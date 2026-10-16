import type { ExportPart, Player, ProfileSettings } from "@pathofdev/schema"
import {
  changeOf,
  ConfirmMismatch,
  CurrentPlayer,
  InvalidCursor,
  InvalidSection,
  OnlineApi,
  patchOf,
  privacyOf,
  sectionsText,
  settingsOf,
  Unauthorized,
} from "@pathofdev/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Buffer } from "node:buffer"
import { Allowlist } from "./auth/allowlist.ts"
import { nowIso } from "./game.ts"
import { goneAsUnauthorized } from "./http.ts"
import { StreamHub } from "./hub.ts"
import { lockPlayer, PlayerGone } from "./writer.ts"

// The player's own account on the public server, from the mod: what their public page shows, an export of everything
// kept of them, and deleting it all. Each route acts for the token's player (AccountAuth), whether or not the beta
// still lets them in. `playerTables` names every table that holds a player's rows, once: what an export takes of each
// and what it never takes, and the order a delete empties them in. Tables and columns reach SQL only as identifiers.
//
// Privacy: one statement, so two machines hiding two sections at once both stick.
//
//   POST /v1/account/profile {kind, section?} ─▶ changeOf ── names no section ─▶ 400, "the sections are …"
//     └─▶ UPDATE players SET profile = (profile, or {} when junk) || patchOf(change) RETURNING profile
//           ├─ no row ─▶ PlayerGone ─▶ 401
//           └─▶ privacyOf ─▶ settingsOf ─▶ 200 ProfileSettings
//
// Export: a head in one transaction, then each part a page at a time. The head says how far each part goes (`upto`):
// the append-only tables never change at or below it, so pages read later still add up to the head's counts without
// a transaction held open across requests. Sessions change, so theirs is the table as each page reads it.
//
//   GET /v1/account/export ─▶ one tx: players (no roll_seed) · player_state · tokens (created_at only) · counts ≤ upto
//   GET /v1/account/export/{part}?after&upto
//     └─▶ WHERE owner = me AND key > after [AND ≤ upto] ORDER BY key LIMIT 1001 ─▶ pageOf(1 MiB, 1000) ─▶ {rows, next}
//
// Delete: one transaction, after the login the player typed matches theirs. It takes the writer's lock first, so it
// waits for an apply in flight, then the players row, which the foreign-key checks of a token's mint, a session's
// insert and a sign-in's rename wait on. A per-player table missing from the list fails its foreign key, and the whole
// delete rolls back: it fails closed, never half done.
//
//   POST /v1/account/delete {login} ─▶ confirmed ── another login ─▶ 400, nothing deleted
//     └─▶ erase: lockPlayer (player_state FOR UPDATE) ─▶ players FOR UPDATE
//           ─▶ DELETE api_tokens, sessions, quarantine, rolls, server_events, event_log, player_state, players
//           ─▶ commit ─▶ StreamHub.notify: held polls wake, find no player, answer 401
//     └─▶ 200 {deleted, onBetaList}: beta_logins is the admins' list, and stays

/** How a part's rows are bounded by the head: by a column up to one of its counters, by the log, or not at all. */
type Bound =
  | { readonly kind: "column"; readonly column: string; readonly upto: "logSeq" | "serverSeq" }
  /** A row of a logged input: one whose `input_id` the event log holds at or below the head's log_seq. */
  | { readonly kind: "logged"; readonly upto: "logSeq" }
  | { readonly kind: "none" }

/** Where a table's rows go in an export: into the head, or a part of their own, paged by `key`. */
type Into =
  | { readonly kind: "head"; readonly as: "player" | "state" | "tokens" }
  | {
    readonly kind: "part"
    readonly part: ExportPart
    readonly key: string
    readonly keyIs: "int" | "text"
    readonly bound: Bound
  }

/** A table that holds a player's rows: the column naming them, what an export takes and never takes, and where. */
export interface PlayerTable {
  readonly name: string
  readonly owner: "player_id" | "id"
  readonly exported: ReadonlyArray<string>
  /** Never in an export: the roll seed would predict the player's loot, a token's hash signs nobody in but is no data. */
  readonly withheld: ReadonlyArray<string>
  readonly into: Into
}

/** Every table that holds a player's rows, in the order a delete empties them: each before the tables it names. */
export const playerTables: ReadonlyArray<PlayerTable> = [
  {
    name: "api_tokens",
    owner: "player_id",
    exported: ["created_at"],
    withheld: ["token_hash"],
    into: { kind: "head", as: "tokens" },
  },
  {
    name: "sessions",
    owner: "player_id",
    exported: ["session_id", "client_version", "opened_at", "last_heard_at", "closed_at", "close_reason"],
    withheld: [],
    into: { kind: "part", part: "sessions", key: "session_id", keyIs: "text", bound: { kind: "none" } },
  },
  {
    name: "quarantine",
    owner: "player_id",
    exported: ["input_id", "input", "error", "received_at"],
    withheld: [],
    into: { kind: "part", part: "quarantine", key: "input_id", keyIs: "text", bound: { kind: "logged", upto: "logSeq" } },
  },
  {
    name: "rolls",
    owner: "player_id",
    exported: ["number", "log_seq", "record"],
    withheld: [],
    into: {
      kind: "part",
      part: "rolls",
      key: "number",
      keyIs: "int",
      bound: { kind: "column", column: "log_seq", upto: "logSeq" },
    },
  },
  {
    name: "server_events",
    owner: "player_id",
    exported: ["seq", "at", "cause", "type", "data"],
    withheld: [],
    into: {
      kind: "part",
      part: "serverEvents",
      key: "seq",
      keyIs: "int",
      bound: { kind: "column", column: "seq", upto: "serverSeq" },
    },
  },
  {
    name: "event_log",
    owner: "player_id",
    exported: [
      "log_seq",
      "input_id",
      "natural_key",
      "schema_version",
      "input",
      "received_at",
      "engine_version",
      "rules_version",
      "catalog_version",
      "status",
      "reason",
      "refusal",
    ],
    withheld: [],
    into: {
      kind: "part",
      part: "events",
      key: "log_seq",
      keyIs: "int",
      bound: { kind: "column", column: "log_seq", upto: "logSeq" },
    },
  },
  {
    name: "player_state",
    owner: "player_id",
    exported: ["state", "log_seq", "server_seq", "stream_epoch", "engine_version", "rules_version"],
    withheld: [],
    into: { kind: "head", as: "state" },
  },
  {
    name: "players",
    owner: "id",
    exported: ["id", "github_user_id", "github_login", "display_name", "created_at", "profile"],
    withheld: ["roll_seed"],
    into: { kind: "head", as: "player" },
  },
]

type PartTable = PlayerTable & { readonly into: Extract<Into, { kind: "part" }> }

const isPart = (table: PlayerTable): table is PartTable => table.into.kind === "part"

/** The export's parts, in the order the head lists them and the mod reads them. */
export const partTables: ReadonlyArray<PartTable> = playerTables.filter(isPart).toReversed()

/** The table of an export's part. */
export const partTableOf = (part: ExportPart): PartTable => partTables.find((table) => table.into.part === part)!

const headTableOf = (as: "player" | "state" | "tokens"): PlayerTable =>
  playerTables.find((table) => table.into.kind === "head" && table.into.as === as)!

/** A page's most rows, and its most bytes of JSON: the mod writes each page to a file of its own, under 4 MiB. */
export const pageRows = 1000
export const pageBytes = 1024 * 1024

/** A row as the database wrote it out, its key, and its size in the page. */
export interface ExportRow {
  readonly json: string
  readonly key: string
  readonly size: number
}

/**
 * The page `rows` (in key order) start: as many as fit in `budget` bytes, and at most `limit`, but always one, so a
 * row bigger than a page still leaves; `next` is the last one's key when rows are left over, else null.
 */
export const pageOf = <R extends { readonly key: string; readonly size: number }>(
  rows: ReadonlyArray<R>,
  budget: number,
  limit: number,
): { readonly rows: ReadonlyArray<R>; readonly next: string | null } => {
  const totals = rows.reduce<ReadonlyArray<number>>((sums, row) => [...sums, (sums.at(-1) ?? 0) + row.size], [])
  const over = totals.findIndex((total, i) => i >= limit || total > budget)
  const count = over === -1 ? rows.length : Math.max(1, over)
  const taken = rows.slice(0, count)
  return { rows: taken, next: count < rows.length ? (taken.at(-1)?.key ?? null) : null }
}

const confirmText =
  "That isn't this account's GitHub login: type the login you sign in with to delete it. Nothing was deleted"

/** The player means this account: the login they typed is theirs, in any case. */
export const confirmed = (player: Player, login: string): Effect.Effect<void, ConfirmMismatch> =>
  player.githubLogin !== null && player.githubLogin.toLowerCase() === login.trim().toLowerCase()
    ? Effect.void
    : Effect.fail(new ConfirmMismatch({ message: confirmText }))

/** A page's cursor as its key column reads it, or none for a cursor that column can't hold. */
export const cursorOf = (keyIs: "int" | "text", after: string | undefined): Option.Option<number | string> => {
  if (keyIs === "text") return Option.some(after ?? "")
  if (after === undefined) return Option.some(-1)
  return /^(0|[1-9][0-9]{0,14})$/.test(after) ? Option.some(Number(after)) : Option.none()
}

type Failure = SqlError | Schema.SchemaError | PlayerGone

const Text = Schema.Struct({ json: Schema.String })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Text))

export class AccountData extends Context.Service<
  AccountData,
  {
    readonly settings: (playerId: string) => Effect.Effect<ProfileSettings, Failure>
    readonly change: (playerId: string, patch: object) => Effect.Effect<ProfileSettings, Failure>
    /** The head's rows, and for each part its rows up to the head, with the `upto` its pages are read with. */
    readonly head: (playerId: string) => Effect.Effect<
      {
        readonly player: unknown
        readonly state: unknown
        readonly tokens: ReadonlyArray<unknown>
        readonly parts: ReadonlyArray<{ part: ExportPart; rows: number; upto: number | null }>
      },
      Failure
    >
    /** A page of `part`'s rows after `after` (`cursorOf` read it), up to `upto`. */
    readonly page: (
      playerId: string,
      part: ExportPart,
      after: number | string,
      upto: number | undefined,
    ) => Effect.Effect<{ readonly rows: ReadonlyArray<unknown>; readonly next: string | null }, Failure>
    /** Deletes every row of the player, in one transaction; `PlayerGone` when there were none to delete. */
    readonly erase: (playerId: string) => Effect.Effect<void, Failure>
  }
>()("pathofdev/AccountData") {
  static readonly layer = Layer.effect(
    AccountData,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const columnsOf = (table: PlayerTable) => sql.csv(table.exported.map((column) => sql`${sql(column)}`))

      /** The player's rows of `table`, each as the database writes it out as JSON, under `where`. */
      const jsonRows = (table: PlayerTable, playerId: string, where = sql``, order = sql``) =>
        Effect.flatMap(
          sql`
            SELECT row_to_json(t)::text AS json FROM (
              SELECT ${columnsOf(table)} FROM ${sql(table.name)}
              WHERE ${sql(table.owner)} = ${playerId} ${where}
              ${order}
            ) t
          `,
          decodeRows,
        )

      const parse = (json: string): unknown => JSON.parse(json)

      /** `table`'s rows at or below the head's counters, as a part's `upto` says. */
      const boundBy = (table: PartTable, playerId: string, upto: number | undefined) => {
        const bound = table.into.bound
        if (bound.kind === "none" || upto === undefined) return sql``
        return bound.kind === "column"
          ? sql`AND ${sql(bound.column)} <= ${upto}`
          : sql`AND input_id IN (SELECT input_id FROM event_log WHERE player_id = ${playerId} AND log_seq <= ${upto})`
      }

      const uptoOf = (table: PartTable, counters: { logSeq: number; serverSeq: number }): number | null =>
        table.into.bound.kind === "none" ? null : counters[table.into.bound.upto]

      const playerRow = (playerId: string) =>
        Effect.flatMap(jsonRows(headTableOf("player"), playerId), (rows) =>
          rows[0] === undefined ? Effect.fail(new PlayerGone({ playerId })) : Effect.succeed(parse(rows[0].json)))

      const settings = (playerId: string) =>
        Effect.flatMap(
          sql<{ profile: unknown }>`SELECT profile FROM players WHERE id = ${playerId}`,
          (rows) =>
            rows[0] === undefined
              ? Effect.fail(new PlayerGone({ playerId }))
              : Effect.succeed(settingsOf(privacyOf(rows[0].profile), null)),
        )

      const change = (playerId: string, patch: object) =>
        Effect.flatMap(
          sql<{ profile: unknown }>`
            UPDATE players
            SET profile = (CASE WHEN jsonb_typeof(profile) = 'object' THEN profile ELSE '{}'::jsonb END)
              || ${JSON.stringify(patch)}::jsonb
            WHERE id = ${playerId}
            RETURNING profile
          `,
          (rows) =>
            rows[0] === undefined
              ? Effect.fail(new PlayerGone({ playerId }))
              : Effect.succeed(settingsOf(privacyOf(rows[0].profile), null)),
        )

      const head = (playerId: string) =>
        Effect.gen(function* () {
          const player = yield* playerRow(playerId)
          const [stateRow] = yield* jsonRows(headTableOf("state"), playerId)
          if (stateRow === undefined) return yield* new PlayerGone({ playerId })
          const state = parse(stateRow.json) as { log_seq: number; server_seq: number }
          const counters = { logSeq: state.log_seq, serverSeq: state.server_seq }
          const tokens = (yield* jsonRows(headTableOf("tokens"), playerId, sql``, sql`ORDER BY created_at`)).map(
            (row) => parse(row.json),
          )
          const parts = yield* Effect.forEach(partTables, (table) => {
            const upto = uptoOf(table, counters)
            return Effect.map(
              sql<{ rows: number }>`
                SELECT count(*)::int AS rows FROM ${sql(table.name)}
                WHERE player_id = ${playerId} ${boundBy(table, playerId, upto ?? undefined)}
              `,
              ([counted]) => ({ part: table.into.part, rows: counted?.rows ?? 0, upto }),
            )
          })
          return { player, state, tokens, parts }
        }).pipe(sql.withTransaction)

      const page = (playerId: string, part: ExportPart, after: number | string, upto: number | undefined) =>
        Effect.gen(function* () {
          const table = partTableOf(part)
          const { key } = table.into
          const rows = yield* jsonRows(
            table,
            playerId,
            sql`AND ${sql(key)} > ${after} ${boundBy(table, playerId, upto)}`,
            sql`ORDER BY ${sql(key)} LIMIT ${pageRows + 1}`,
          )
          const parsed = rows.map((row) => {
            const value = parse(row.json) as Record<string, unknown>
            return { value, key: String(value[key]), size: Buffer.byteLength(row.json) + 1 }
          })
          const taken = pageOf(parsed, pageBytes, pageRows)
          // The players row must still be there: an empty page for a player deleted meanwhile is no page.
          if (taken.rows.length === 0) yield* playerRow(playerId)
          return { rows: taken.rows.map((row) => row.value), next: taken.next }
        })

      const erase = (playerId: string) =>
        Effect.gen(function* () {
          yield* sql`SET LOCAL statement_timeout = '60s'`
          if ((yield* lockPlayer(sql, playerId)).length === 0) return yield* new PlayerGone({ playerId })
          yield* sql`SELECT id FROM players WHERE id = ${playerId} FOR UPDATE`
          yield* Effect.forEach(
            playerTables,
            (table) => sql`DELETE FROM ${sql(table.name)} WHERE ${sql(table.owner)} = ${playerId}`,
            { discard: true },
          )
        }).pipe(sql.withTransaction)
      // The timeout covers each statement, its waits for locks included: generous, as it is the player's whole history.

      return AccountData.of({ settings, change, head, page, erase })
    }),
  )
}

/** Database and decoding failures as defects, and a player deleted meanwhile as a 401. */
const asAccountErrors = <A, R>(effect: Effect.Effect<A, Failure, R>): Effect.Effect<A, Unauthorized, R> =>
  Effect.catchTags(goneAsUnauthorized(effect), { SqlError: Effect.die, SchemaError: Effect.die })

const noSection = `That names no section to hide or show: ${sectionsText}`

export const AccountHandlers = HttpApiBuilder.group(
  OnlineApi,
  "account",
  Effect.fn(function* (handlers) {
    const data = yield* AccountData
    const allowlist = yield* Allowlist
    const hub = yield* StreamHub

    return handlers.handleAll({
      profileSettings: () => Effect.flatMap(CurrentPlayer, (player) => asAccountErrors(data.settings(player.id))),

      changeProfile: ({ payload }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          const asked = changeOf(payload)
          if (asked === null) return yield* new InvalidSection({ message: noSection })
          return yield* asAccountErrors(data.change(player.id, patchOf(asked)))
        }),

      exportHead: () =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          const head = yield* asAccountErrors(data.head(player.id))
          return { format: 1 as const, exportedAt: yield* nowIso, ...head, onBetaList: yield* allowlist.allows(player) }
        }),

      exportPage: ({ params, query }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          const after = cursorOf(partTableOf(params.part).into.keyIs, query.after)
          if (Option.isNone(after)) {
            return yield* new InvalidCursor({ message: `A ${params.part} page starts after a whole number` })
          }
          return yield* asAccountErrors(data.page(player.id, params.part, after.value, query.upto))
        }),

      deleteAccount: ({ payload }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          yield* confirmed(player, payload.login)
          yield* asAccountErrors(data.erase(player.id))
          // After the commit: a held poll woken now reads the stream, finds no player, and answers 401.
          yield* hub.notify(player.id)
          return { deleted: true as const, onBetaList: yield* allowlist.allows(player) }
        }),
    })
  }),
)
