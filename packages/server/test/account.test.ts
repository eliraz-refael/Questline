import { it } from "@effect/vitest"
import type { ExportHead, Player as PlayerType, Privacy, PrivacyChange } from "@pathofdev/schema"
import {
  AccountAuthentication,
  accountDeleted,
  applyChange,
  Authentication,
  changeOf,
  CurrentPlayer,
  privacyOf,
  privateProfile,
  ProfileChangeRequest,
  profileSections,
  settingsOf,
} from "@pathofdev/schema"
import { Effect, Fiber, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { describe, expect } from "vitest"
import type { GithubUser } from "../src/index.ts"
import {
  AccountData,
  Allowlist,
  cursorOf,
  defaultProfileOrigin,
  maxInt,
  GitHub,
  isForeignKeyViolation,
  notInBeta,
  Tokens,
  pageBytes,
  pageOf,
  pageRows,
  Players,
  playerTables,
  ProfileOrigin,
} from "../src/index.ts"
import type { Handle } from "./fixtures.ts"
import {
  dump,
  fakeGitHub,
  hatch,
  json,
  onlineWebHandler,
  prompt,
  publicWebHandler,
  request,
  session,
  signIn,
  testOnlineServices,
  testPublicServices,
  webHandler,
  withServer,
} from "./fixtures.ts"

// The player's own account on the public server, end to end through the public build's routes over a fresh database:
// privacy, export and delete. GitHub is a table the test fills; ALLOWED_LOGINS lists Ada and Bob, so either can sign in
// again after a delete:
//
//   /v1/account/* ─▶ AccountAuth (token ─▶ player; no allowlist) ─▶ AccountHandlers ─▶ AccountData ─▶ the tables
//
// The lifecycle and the privacy endpoint are model-based: a sequence of commands, run against the server and a model of
// what it should hold, compared after every step.

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

const ada: GithubUser = { id: 1, login: "Ada", name: "Ada Lovelace" }
const bob: GithubUser = { id: 2, login: "bob", name: null }
const accounts = [ada, bob] as const

const withPublic = (allowedLogins = "ada,bob") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(testPublicServices({ allowedLogins, adminGithubIds: [] }, fakeGitHub(accounts))))

const openSession = (handle: Handle, bearer: string) =>
  handle(request("/v1/sessions", "POST", bearer, { sessionId: session, presence: true }))

/** Everything an export answers, read as the mod reads it: the head, then each part's pages until `next` is null. */
const exportAll = (handle: Handle, bearer: string) =>
  Effect.gen(function* () {
    const headResponse = yield* handle(request("/v1/account/export", "GET", bearer))
    expect(headResponse.status).toBe(200)
    const headText = yield* Effect.promise(() => headResponse.text())
    const head = JSON.parse(headText) as ExportHead
    const parts: Record<string, Array<Record<string, unknown>>> = {}
    const pageSizes: Array<number> = []
    let text = headText
    for (const { part, upto } of head.parts) {
      parts[part] = []
      let after: string | null = null
      do {
        const query = [after === null ? null : `after=${encodeURIComponent(after)}`, upto === null ? null : `upto=${upto}`]
          .filter((one) => one !== null)
          .join("&")
        const response = yield* handle(request(`/v1/account/export/${part}${query === "" ? "" : `?${query}`}`, "GET", bearer))
        expect({ part, status: response.status }).toEqual({ part, status: 200 })
        const pageText = yield* Effect.promise(() => response.text())
        pageSizes.push(new TextEncoder().encode(pageText).length)
        text += pageText
        const page = JSON.parse(pageText) as { rows: Array<Record<string, unknown>>; next: string | null }
        parts[part]!.push(...page.rows)
        after = page.next
      } while (after !== null)
    }
    return { head, headBytes: new TextEncoder().encode(headText).length, parts, pageSizes, text }
  })

/** A value as JSON writes it: Postgres reads a bigint column as a BigInt, which JSON has no form for. */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, one) => (typeof one === "bigint" ? Number(one) : one)))

/** The player's own rows of every per-player table, as `SELECT *` reads them, keyed by table. */
const ownRows = (playerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const entries = yield* Effect.forEach(playerTables, (table) =>
      Effect.map(
        sql<Record<string, unknown>>`SELECT * FROM ${sql(table.name)} WHERE ${sql(table.owner)} = ${playerId}`,
        (rows) => [table.name, plain(rows) as Array<Record<string, unknown>>] as const,
      ))
    return Object.fromEntries(entries)
  })

const project = (row: Record<string, unknown>, columns: ReadonlyArray<string>) =>
  Object.fromEntries(columns.map((column) => [column, row[column]]))

/** The same rows whatever their order. */
const asSet = (rows: ReadonlyArray<unknown>) => rows.map((row) => JSON.stringify(row)).sort()

/** An export holds exactly the player's own rows, as `playerTables` projects them, and no withheld column. */
const expectOwnExport = (exported: Effect.Success<ReturnType<typeof exportAll>>, own: Record<string, Array<Record<string, unknown>>>) => {
  for (const table of playerTables) {
    const expected = own[table.name]!.map((row) => project(row, table.exported))
    const got =
      table.into.kind === "part"
        ? exported.parts[table.into.part]!
        : table.into.as === "tokens"
          ? (exported.head.tokens as Array<Record<string, unknown>>)
          : [(table.into.as === "player" ? exported.head.player : exported.head.state) as Record<string, unknown>]
    expect({ table: table.name, rows: asSet(got) }).toEqual({ table: table.name, rows: asSet(expected) })
  }
  for (const part of exported.head.parts) expect(exported.parts[part.part]).toHaveLength(part.rows)
}

// ── the pure half ────────────────────────────────────────────────────────────────────────────────────────────────────

const Sized = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 }))).check(Schema.isMaxLength(60))

describe("pageOf", () => {
  it.prop(
    "pages rows in order, each page within its budget and limit or a single row, until they run out",
    [Sized, Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })), Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))],
    ([sizes, budget, limit]) => {
      const rows = sizes.map((size, i) => ({ key: String(i), size }))
      const pages: Array<ReadonlyArray<{ key: string; size: number }>> = []
      let rest = rows
      for (;;) {
        const page = pageOf(rest, budget, limit)
        pages.push(page.rows)
        const total = page.rows.reduce((sum, row) => sum + row.size, 0)
        expect(page.rows.length <= limit && (total <= budget || page.rows.length === 1)).toBe(true)
        if (page.next === null) {
          expect(page.rows).toEqual(rest)
          break
        }
        expect(page.next).toBe(page.rows.at(-1)!.key)
        rest = rest.slice(page.rows.length)
        expect(page.rows.length).toBeGreaterThan(0)
      }
      expect(pages.flat()).toEqual(rows)
    },
  )
})

describe("an export page's cursor", () => {
  it.prop("reads back any key a page names", [Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxInt })), Schema.String], ([n, text]) => {
    expect(cursorOf("int", String(n))).toEqual(Option.some(n))
    expect(cursorOf("text", text)).toEqual(Option.some(text))
    expect(cursorOf("int", undefined)).toEqual(Option.some(-1))
    expect(cursorOf("text", undefined)).toEqual(Option.some(""))
  })

  it.prop("names no whole-number key for anything else", [Schema.String], ([text]) => {
    const read = cursorOf("int", text)
    if (Option.isSome(read)) expect(String(read.value)).toBe(text)
  })

  it("names none past what an integer column holds", () => {
    expect(cursorOf("int", String(maxInt + 1))).toEqual(Option.none())
    expect(cursorOf("int", "99999999999")).toEqual(Option.none())
  })
})

// ── the tables ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("playerTables", () => {
  // An example: the migrations are one fixed set, so there is nothing to draw. It fails when a migration adds a
  // per-player table or column the list doesn't name, or names what isn't there.
  it.effect("names every per-player table and every column of each, and empties each before what it names", () =>
    withPublic()(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const columns = yield* sql<{ table_name: string; column_name: string }>`
          SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()
        `
        const byTable = new Map<string, Set<string>>()
        for (const { table_name, column_name } of columns) {
          byTable.set(table_name, new Set([...(byTable.get(table_name) ?? []), column_name]))
        }
        const perPlayer = [...byTable].filter(([, names]) => names.has("player_id")).map(([name]) => name)
        expect(new Set(playerTables.map((table) => table.name))).toEqual(new Set([...perPlayer, "players"]))
        for (const table of playerTables) {
          expect({ table: table.name, columns: byTable.get(table.name) }).toEqual({
            table: table.name,
            columns: new Set([table.owner, ...table.exported, ...table.withheld]),
          })
          expect(table.exported.filter((column) => table.withheld.includes(column))).toEqual([])
        }
        expect(playerTables.find((table) => table.name === "players")?.withheld).toEqual(["roll_seed"])

        const references = yield* sql<{ child: string; parent: string }>`
          SELECT tc.table_name AS child, ccu.table_name AS parent
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()
        `
        const at = (name: string) => playerTables.findIndex((table) => table.name === name)
        for (const { child, parent } of references) expect({ child, parent, before: at(child) < at(parent) }).toMatchObject({ before: true })
      }),
    ), serverRuns.timeout)

  it.effect("tells an insert for a player who is gone by its foreign key", () =>
    withPublic()(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const failed = yield* Effect.flip(
          sql`
            INSERT INTO sessions (player_id, session_id, client_version, opened_at, last_heard_at)
            VALUES ('nobody', ${session}, NULL, 'now', 'now')
          `,
        )
        expect(isForeignKeyViolation(failed as SqlError)).toBe(true)
      }),
    ), serverRuns.timeout)
})

// ── privacy, model-based ─────────────────────────────────────────────────────────────────────────────────────────────

/** What two players ask of their privacy: a change (sections the server knows and some it doesn't) or a look. */
const PrivacyStep = Schema.Union([
  Schema.Struct({ who: Schema.Literals([0, 1]), op: Schema.Literal("get") }),
  Schema.Struct({
    who: Schema.Literals([0, 1]),
    op: Schema.Literal("change"),
    request: Schema.Union([
      ProfileChangeRequest,
      Schema.Struct({ kind: Schema.Literals(["hide", "show"]), section: Schema.Literals([...profileSections, "history", "Pet", ""]) }),
    ]),
  }),
])

const storedPrivacy = (playerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ profile: unknown }>`SELECT profile FROM players WHERE id = ${playerId}`
    return { stored: row?.profile, privacy: privacyOf(row?.profile) }
  })

describe("the privacy endpoint", () => {
  it.effect.prop(
    "answers and stores what the model says after every step, for each player apart, and turns down an unknown section",
    [Schema.Array(PrivacyStep).check(Schema.isMaxLength(14))],
    ([steps]) =>
      withPublic()(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const players = [yield* signIn(handle, ada), yield* signIn(handle, bob)]
          const model: Array<Privacy> = [privateProfile, privateProfile]
          for (const step of steps) {
            const { bearer } = players[step.who]!
            const before = [yield* storedPrivacy(players[0]!.player.id), yield* storedPrivacy(players[1]!.player.id)]
            const response = step.op === "get"
              ? yield* handle(request("/v1/account/profile", "GET", bearer))
              : yield* handle(request("/v1/account/profile", "POST", bearer, step.request))
            const body = yield* json(response)
            const change: PrivacyChange | null = step.op === "get" ? null : changeOf(step.request as typeof ProfileChangeRequest.Type)
            if (step.op === "change" && change === null) {
              expect({ step, status: response.status }).toEqual({ step, status: 400 })
              expect(body.message).toContain(profileSections.join(", "))
              expect([yield* storedPrivacy(players[0]!.player.id), yield* storedPrivacy(players[1]!.player.id)]).toEqual(before)
              continue
            }
            if (change !== null) model[step.who] = applyChange(model[step.who]!, change)
            expect({ step, status: response.status }).toEqual({ step, status: 200 })
            // The page's address is the player's login, lower-cased, at the default origin.
            const url = `https://pathof.dev/u/${players[step.who]!.player.githubLogin!.toLowerCase()}`
            expect(body).toEqual(settingsOf(model[step.who]!, url))
            for (const who of [0, 1] as const) {
              expect((yield* storedPrivacy(players[who]!.player.id)).privacy).toEqual(model[who])
            }
          }
        }),
      ),
    serverRuns,
  )

  // The race is Postgres's: PGlite runs one statement at a time, so there this checks only the reduction, sequential
  // changes to different keys, which the model above covers too.
  it.effect("keeps every one of several changes to different keys made at once", () =>
    withPublic()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer, player } = yield* signIn(handle, ada)
        const changes = [{ kind: "public" }, ...profileSections.map((section) => ({ kind: "hide", section }))]
        const answers = yield* Effect.forEach(
          [...changes, ...changes],
          (change) => handle(request("/v1/account/profile", "POST", bearer, change)),
          { concurrency: "unbounded" },
        )
        expect(answers.map((answer) => answer.status)).toEqual(answers.map(() => 200))
        expect((yield* storedPrivacy(player.id)).privacy).toEqual({
          public: true,
          ...Object.fromEntries(profileSections.map((section) => [section, false])),
        })
      }),
    ), serverRuns.timeout)

  it.effect("starts again from an empty profile when the stored one is junk", () =>
    withPublic()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer, player } = yield* signIn(handle, ada)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE players SET profile = '"public"'::jsonb WHERE id = ${player.id}`
        expect(yield* json(yield* handle(request("/v1/account/profile", "GET", bearer)))).toMatchObject({ isPublic: false })
        const changed = yield* handle(request("/v1/account/profile", "POST", bearer, { kind: "hide", section: "pet" }))
        expect(yield* json(changed)).toMatchObject({ isPublic: false, hidden: ["pet"] })
        expect((yield* storedPrivacy(player.id)).stored).toEqual({ pet: false })
      }),
    ), serverRuns.timeout)
})

// ── the account's lifecycle, model-based ─────────────────────────────────────────────────────────────────────────────

const Who = Schema.Literals([0, 1])
const LifeStep = Schema.Union([
  Schema.Struct({ op: Schema.Literal("play"), who: Who, n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })) }),
  Schema.Struct({ op: Schema.Literal("export"), who: Who }),
  Schema.Struct({ op: Schema.Literal("delete"), who: Who, login: Schema.Literals(["own", "OWN", "other", "nobody", ""]) }),
  Schema.Struct({ op: Schema.Literal("signIn"), who: Who }),
  Schema.Struct({ op: Schema.Literal("privacy"), who: Who, kind: Schema.Literals(["public", "private"]) }),
])

/** What the model holds of each account: who it is now, the tokens it was ever given, and the ids it sent. */
interface Held {
  player: PlayerType | null
  bearer: string | null
  bearers: Array<string>
  sent: Array<string>
  ids: Array<string>
}

describe("an account", () => {
  it.effect.prop(
    "exports exactly its own rows, deletes exactly them and every token, and starts afresh on the next sign-in",
    [Schema.Array(LifeStep).check(Schema.isMinLength(1), Schema.isMaxLength(10))],
    ([steps]) =>
      withPublic()(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const sql = yield* SqlClient.SqlClient
          // A login the admins added: the delete leaves their list as it was.
          yield* (yield* Allowlist).add("Ada", 99)
          const held: Array<Held> = []
          for (const account of accounts) {
            const { bearer, player } = yield* signIn(handle, account)
            held.push({ player, bearer, bearers: [bearer], sent: [], ids: [player.id] })
          }
          let sentCount = 0
          const nextSent = () => `01K6ZQ8W3K${String(sentCount++).padStart(16, "0")}`

          for (const step of steps) {
            const me = held[step.who]!
            const other = held[1 - step.who]!
            const account = accounts[step.who]
            if (step.op === "signIn") {
              const wasDeleted = me.player === null
              const { bearer, player } = yield* signIn(handle, account)
              if (wasDeleted) {
                // A new account: a new id, private, at level 0, and the ids the old one sent are new to it.
                expect(me.ids).not.toContain(player.id)
                const settings = yield* json(yield* handle(request("/v1/account/profile", "GET", bearer)))
                expect(settings).toMatchObject({ isPublic: false })
                const opened = yield* json(yield* openSession(handle, bearer))
                expect(opened.snapshot.character.level).toBe(0)
                for (const id of me.sent.slice(-2)) {
                  const answer = yield* json(yield* handle(request("/v1/events", "POST", bearer, { events: [prompt(7, id)] })))
                  expect(answer.results[0]).toMatchObject({ id, status: "accepted" })
                }
                me.ids.push(player.id)
              } else {
                expect(player.id).toBe(me.player!.id)
              }
              me.player = player
              me.bearer = bearer
              me.bearers.push(bearer)
              continue
            }
            if (me.player === null || me.bearer === null) continue
            const bearer = me.bearer
            const player = me.player

            if (step.op === "play") {
              const id = nextSent()
              const sent = yield* handle(request("/v1/events", "POST", bearer, { events: [prompt(step.n + 5, id)] }))
              expect(sent.status).toBe(200)
              me.sent.push(id)
              expect((yield* handle(request("/v1/commands", "POST", bearer, hatch()))).status).toBe(200)
            }

            if (step.op === "privacy") {
              const changed = yield* handle(request("/v1/account/profile", "POST", bearer, { kind: step.kind }))
              expect(yield* json(changed)).toMatchObject({ isPublic: step.kind === "public" })
            }

            if (step.op === "export") {
              const exported = yield* exportAll(handle, bearer)
              expectOwnExport(exported, yield* ownRows(player.id))
              expect(exported.head.onBetaList).toBe(true)
              expect((exported.head.player as { github_user_id: unknown }).github_user_id).toBe(account.id)
              // One-row data only: the head stays small whatever was played, and so does every page.
              expect(exported.headBytes).toBeLessThanOrEqual(pageBytes)
              for (const size of exported.pageSizes) expect(size).toBeLessThanOrEqual(pageBytes + 4096)
              const secrets = yield* sql<{ secret: string }>`
                SELECT roll_seed AS secret FROM players UNION ALL SELECT token_hash AS secret FROM api_tokens
              `
              for (const { secret } of secrets) expect(exported.text).not.toContain(secret)
              for (const id of other.ids) expect(exported.text).not.toContain(id)
            }

            if (step.op === "delete") {
              const login = step.login === "own"
                ? account.login
                : step.login === "OWN"
                  ? account.login.toUpperCase()
                  : step.login === "other"
                    ? accounts[step.who === 0 ? 1 : 0].login
                    : step.login
              const before = yield* dump
              const theirs = other.player === null ? null : yield* ownRows(other.player.id)
              const response = yield* handle(request("/v1/account/delete", "POST", bearer, { login }))
              if (step.login !== "own" && step.login !== "OWN") {
                expect({ step, status: response.status }).toEqual({ step, status: 400 })
                expect(yield* dump).toEqual(before)
                continue
              }
              expect(response.status).toBe(200)
              expect(yield* json(response)).toEqual({ deleted: true, onBetaList: true })
              const left = yield* ownRows(player.id)
              for (const table of playerTables) expect({ table: table.name, rows: left[table.name] }).toEqual({ table: table.name, rows: [] })
              if (other.player !== null) expect(yield* ownRows(other.player.id)).toEqual(theirs)
              const [beta] = yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM beta_logins`
              expect(beta?.count).toBe(1)
              for (const old of me.bearers) {
                const refused = yield* openSession(handle, old)
                expect(refused.status).toBe(401)
                expect((yield* handle(request("/v1/account/export", "GET", old))).status).toBe(401)
              }
              me.player = null
              me.bearer = null
            }
          }
        }),
      ),
    serverRuns,
  )

  it.effect("taken off the beta still reads, changes, exports and deletes itself, but plays no more", () =>
    withPublic("")(
      Effect.gen(function* () {
        const allowlist = yield* Allowlist
        yield* allowlist.add("Ada", 99)
        const handle = yield* publicWebHandler
        const { bearer } = yield* signIn(handle, ada)
        yield* allowlist.remove("ada")
        const refused = yield* openSession(handle, bearer)
        expect(refused.status).toBe(401)
        expect(yield* json(refused)).toMatchObject({ message: notInBeta })
        expect((yield* handle(request("/v1/account/profile", "GET", bearer))).status).toBe(200)
        expect((yield* handle(request("/v1/account/profile", "POST", bearer, { kind: "public" }))).status).toBe(200)
        const exported = yield* exportAll(handle, bearer)
        expect(exported.head.onBetaList).toBe(false)
        const deleted = yield* handle(request("/v1/account/delete", "POST", bearer, { login: "ada" }))
        expect(yield* json(deleted)).toEqual({ deleted: true, onBetaList: false })
      }),
    ), serverRuns.timeout)
})

// ── export bounds ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rows written straight to the tables, past what play writes in a test: a page's worth, and quarantined inputs. */
const writeRows = (playerId: string, from: number, count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO server_events (player_id, seq, at, cause, type, data)
      SELECT ${playerId}, n, '2026-10-09T08:00:00.000Z', NULL, 'xp.granted', jsonb_build_object('n', n)
      FROM generate_series(${from}::int, ${from + count - 1}::int) AS n
    `
    yield* sql`
      INSERT INTO event_log (
        player_id, log_seq, input_id, natural_key, schema_version, input, received_at,
        engine_version, rules_version, catalog_version, status, reason, refusal
      )
      SELECT ${playerId}, n, 'q' || lpad(n::text, 8, '0'), NULL, 1, '{}'::jsonb, '2026-10-09T08:00:00.000Z',
        1, 1, 1, 'rejected', 'internal', NULL
      FROM generate_series(${from}::int, ${from + 2}::int) AS n
    `
    yield* sql`
      INSERT INTO quarantine (player_id, input_id, input, error, received_at)
      SELECT ${playerId}, 'q' || lpad(n::text, 8, '0'), '{}'::jsonb, 'boom', '2026-10-09T08:00:00.000Z'
      FROM generate_series(${from}::int, ${from + 2}::int) AS n
    `
    yield* sql`UPDATE player_state SET log_seq = ${from + 2}, server_seq = ${from + count - 1} WHERE player_id = ${playerId}`
  })

describe("an export", () => {
  it.effect("reads past one page in key order, and stops at the head's counts while play goes on", () =>
    withPublic()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer, player } = yield* signIn(handle, ada)
        yield* writeRows(player.id, 1, pageRows + 500)
        const headResponse = yield* handle(request("/v1/account/export", "GET", bearer))
        const head = (yield* json(headResponse)) as ExportHead
        const counts = Object.fromEntries(head.parts.map((part) => [part.part, part.rows]))
        expect(counts).toMatchObject({ serverEvents: pageRows + 500, events: 3, quarantine: 3 })
        // Play after the head: what it writes is past every part's `upto`, so the pages still add up to the head.
        yield* writeRows(player.id, pageRows + 501, 10)
        const rows = (part: string, upto: number | null) =>
          Effect.gen(function* () {
            const all: Array<Record<string, unknown>> = []
            let after: string | null = null
            let pages = 0
            do {
              const query: string = `?${upto === null ? "" : `upto=${upto}`}${after === null ? "" : `&after=${after}`}`
              const page: { rows: Array<Record<string, unknown>>; next: string | null } = yield* json(yield* handle(request(`/v1/account/export/${part}${query}`, "GET", bearer)))
              all.push(...page.rows)
              after = page.next
              pages += 1
            } while (after !== null)
            return { all, pages }
          })
        for (const { part, upto } of head.parts) {
          const { all, pages } = yield* rows(part, upto)
          expect({ part, rows: all.length }).toEqual({ part, rows: counts[part] })
          if (part === "serverEvents") {
            expect(pages).toBe(2)
            expect(all.map((row) => row["seq"])).toEqual(Array.from({ length: pageRows + 500 }, (_, i) => i + 1))
          }
        }
        const bad = yield* handle(request("/v1/account/export/events?after=x1", "GET", bearer))
        expect(bad.status).toBe(400)
      }),
    ), serverRuns.timeout)
})

// ── delete ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a delete", () => {
  it.effect("that fails on any table rolls back whole: nothing is deleted, and the next one deletes it all", () =>
    withPublic()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer, player } = yield* signIn(handle, ada)
        expect((yield* handle(request("/v1/events", "POST", bearer, { events: [prompt(8)] }))).status).toBe(200)
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$
        `
        yield* sql`CREATE TRIGGER refuse BEFORE DELETE ON event_log FOR EACH ROW EXECUTE FUNCTION refuse()`
        const before = yield* dump
        const failed = yield* handle(request("/v1/account/delete", "POST", bearer, { login: "ada" }))
        expect(failed.status).toBe(500)
        expect(yield* dump).toEqual(before)
        yield* sql`DROP TRIGGER refuse ON event_log`
        expect((yield* handle(request("/v1/account/delete", "POST", bearer, { login: "ada" }))).status).toBe(200)
        const left = yield* ownRows(player.id)
        for (const table of playerTables) expect(left[table.name]).toEqual([])
      }),
    ), serverRuns.timeout)

  it.effect("wakes a held stream poll, which answers 401", () =>
    withPublic()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer } = yield* signIn(handle, ada)
        const poll = yield* Effect.forkChild(handle(request("/v1/stream?after=0", "GET", bearer)))
        // Real time, which the test clock doesn't hold: the poll gets to its wait first.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
        expect((yield* handle(request("/v1/account/delete", "POST", bearer, { login: "ada" }))).status).toBe(200)
        // No clock moves: only the delete's wakeup, or a read that finds no player, ends the poll.
        const answered = yield* Fiber.join(poll)
        expect(answered.status).toBe(401)
      }),
    ), serverRuns.timeout)

  // The race is Postgres's: PGlite runs one transaction at a time. The reduction that runs on both is the stale player
  // below: a request that read its player before the delete committed.
  it.effect("while the player plays answers each request 200 or 401, and leaves no row of theirs", () =>
    withPublic()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer, player } = yield* signIn(handle, ada)
        const plays = Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? request("/v1/events", "POST", bearer, { events: [prompt(6)] })
            : request("/v1/sessions", "POST", bearer, { sessionId: `01K6ZQ8W3J5V7XKQ2M4N6P8R${String(i).padStart(2, "0")}`, presence: true }))
        const [deleted, ...played] = yield* Effect.all(
          [handle(request("/v1/account/delete", "POST", bearer, { login: "ada" })), ...plays.map(handle)],
          { concurrency: "unbounded" },
        )
        expect(deleted!.status).toBe(200)
        for (const one of played) expect([200, 401]).toContain(one.status)
        const left = yield* ownRows(player.id)
        for (const table of playerTables) expect(left[table.name]).toEqual([])
      }),
    ), serverRuns.timeout)
})

// ── a player gone under a request ────────────────────────────────────────────────────────────────────────────────────

/** Who every request acts for: the player as a request read them before their account was deleted. */
const Stale = (player: PlayerType) =>
  Layer.mergeAll(
    Layer.succeed(Authentication, Authentication.of({ bearer: (handler) => Effect.provideService(handler, CurrentPlayer, player) })),
    Layer.succeed(
      AccountAuthentication,
      AccountAuthentication.of({ bearer: (handler) => Effect.provideService(handler, CurrentPlayer, player) }),
    ),
    AccountData.layer.pipe(Layer.provide(ProfileOrigin.layer(defaultProfileOrigin))),
    Tokens.layer,
    Allowlist.layer({ allowedLogins: "ada", adminGithubIds: [] }),
    fakeGitHub([]),
  )

const gone: PlayerType = {
  id: "01K6ZQ8W3J5V7XKQ2M4N6P8GNE",
  githubUserId: 1,
  githubLogin: "ada",
  displayName: "Ada",
  createdAt: "2026-10-09T08:00:00.000Z",
}

const StaleEntry = Schema.Literals([
  "openSession",
  "closeSession",
  "sendEvents",
  "runCommand",
  "stream",
  "profileSettings",
  "changeProfile",
  "exportHead",
  "exportPage",
  "deleteAccount",
])

const staleRequest = (entry: typeof StaleEntry.Type): Request => {
  const bearer = "Bearer stale"
  switch (entry) {
    case "openSession":
      return request("/v1/sessions", "POST", bearer, { sessionId: session, presence: true })
    case "closeSession":
      return request(`/v1/sessions/${session}`, "DELETE", bearer)
    case "sendEvents":
      return request("/v1/events", "POST", bearer, { events: [prompt(8)] })
    case "runCommand":
      return request("/v1/commands", "POST", bearer, hatch())
    case "stream":
      return request(`/v1/stream?after=0&session=${session}`, "GET", bearer)
    case "profileSettings":
      return request("/v1/account/profile", "GET", bearer)
    case "changeProfile":
      return request("/v1/account/profile", "POST", bearer, { kind: "public" })
    case "exportHead":
      return request("/v1/account/export", "GET", bearer)
    case "exportPage":
      return request("/v1/account/export/sessions", "GET", bearer)
    case "deleteAccount":
      return request("/v1/account/delete", "POST", bearer, { login: "ada" })
  }
}

describe("a request for a player deleted since it was read", () => {
  it.effect.prop(
    "is answered 401, saying the account was deleted, on every route, and writes nothing",
    [Schema.Array(StaleEntry).check(Schema.isMinLength(1), Schema.isMaxLength(10))],
    ([entries]) =>
      Effect.gen(function* () {
        const handle = yield* onlineWebHandler
        // Someone else plays on, so a write would have rows to land beside.
        const players = yield* Players
        yield* players.create({ displayName: "bob", characterName: "bob", timezone: "UTC", github: { userId: 2, login: "bob" } })
        const before = yield* dump
        for (const entry of entries) {
          const response = yield* handle(staleRequest(entry))
          expect({ entry, status: response.status }).toEqual({ entry, status: 401 })
          expect(yield* json(response)).toMatchObject({ message: accountDeleted })
        }
        expect(yield* dump).toEqual(before)
      }).pipe(Effect.provide(testOnlineServices(Stale(gone)))),
    serverRuns,
  )
})

describe("the local server", () => {
  it.effect("has no account routes: the save is the player's own disk", () =>
    withServer(
      Effect.gen(function* () {
        const handle = yield* webHandler
        for (const path of ["/v1/account/profile", "/v1/account/export"]) {
          expect((yield* handle(request(path, "GET", null))).status).toBe(404)
        }
      }),
    ), serverRuns.timeout)
})
