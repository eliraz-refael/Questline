import { it } from "@effect/vitest"
import { initialState, step } from "@pathofdev/engine"
import type { ClientEvent, Player as PlayerType, PlayerState as PlayerStateType } from "@pathofdev/schema"
import { Authentication, CurrentPlayer, Input, Player, PlayerState, Unauthorized } from "@pathofdev/schema"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { describe, expect } from "vitest"
import { catalog, naturalKey, Players, QuestPacks, rules } from "../src/index.ts"
import { hatch, merged, prompt, session, testOnlineServices, turn, webHandler } from "./fixtures.ts"

// Who a request acts for, on a server of many players. A test `Authentication` takes the bearer token as a player's
// id, the way the public server will take a game token, so each request below picks its player by its own header:
//
//   Request(Authorization) ─▶ router ─▶ TokenAuth ─┬─ a player's id ─▶ CurrentPlayer ─▶ handler ─▶ that player's rows
//                                                  └─ anything else ─▶ 401, nothing read or written

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

const TokenAuth = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const byId = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Player,
      execute: (id) => sql`
        SELECT id, github_user_id::float8 AS "githubUserId", github_login AS "githubLogin",
          display_name AS "displayName", created_at AS "createdAt"
        FROM players WHERE id = ${id}
      `,
    })
    return Authentication.of({
      bearer: Effect.fn(function* (handler, { credential }) {
        const player = yield* Effect.orDie(byId(Redacted.value(credential)))
        if (Option.isNone(player)) return yield* new Unauthorized({ message: "No player has this token" })
        return yield* Effect.provideService(handler, CurrentPlayer, player.value)
      }),
    })
  }),
)

const withOnline = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(testOnlineServices(TokenAuth)))

/** A new player named `name`, as an online sign-in makes one. */
const signedUp = (name: string, userId: number) =>
  Effect.gen(function* () {
    const players = yield* Players
    return yield* players.create({
      displayName: name,
      characterName: name,
      timezone: "UTC",
      github: { userId, login: name },
    })
  })

const request = (path: string, method: string, authorization: string | null, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** Every table a player's play writes, as rows in a fixed order. */
const tables = ["players", "player_state", "event_log", "server_events", "rolls", "quarantine", "sessions"] as const
const dump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* Effect.forEach(tables, (table) => sql`SELECT * FROM ${sql(table)} ORDER BY 1, 2`)
})

// ── 401 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const Endpoint = Schema.Literals(["openSession", "closeSession", "sendEvents", "runCommand", "stream"])

/** A header that names no player: none, a scheme other than Bearer, or a bearer token no player has. */
const Printable = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{0,40}$/))
const BadIdentity = Schema.Struct({ scheme: Schema.Literals(["none", "Bearer", "bearer", "Basic", "raw"]), token: Printable })

const authorizationOf = ({ scheme, token }: typeof BadIdentity.Type): string | null =>
  scheme === "none" ? null : scheme === "raw" ? token : `${scheme} ${token}`

const requestTo = (endpoint: typeof Endpoint.Type, authorization: string | null): Request => {
  switch (endpoint) {
    case "openSession":
      return request("/v1/sessions", "POST", authorization, { sessionId: session })
    case "closeSession":
      return request(`/v1/sessions/${session}`, "DELETE", authorization)
    case "sendEvents":
      return request("/v1/events", "POST", authorization, { events: [prompt(8)] })
    case "runCommand":
      return request("/v1/commands", "POST", authorization, hatch())
    case "stream":
      return request("/v1/stream?after=0", "GET", authorization)
  }
}

describe("a request that names no player", () => {
  it.effect.prop(
    "is answered 401 on every route, and writes nothing",
    [Schema.Array(Schema.Tuple([Endpoint, BadIdentity])).check(Schema.isMaxLength(10))],
    ([tries]) =>
      withOnline(
        Effect.gen(function* () {
          // A real player exists, so a write would have someone to land on.
          yield* signedUp("someone", 1)
          const handle = yield* webHandler
          const before = yield* dump
          for (const [endpoint, identity] of tries) {
            const response = yield* handle(requestTo(endpoint, authorizationOf(identity)))
            expect({ endpoint, status: response.status }).toEqual({ endpoint, status: 401 })
          }
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )
})

// ── isolation ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Two players' play, interleaved: who sends each event, and what it is; `n` picks its data. */
const Play = Schema.Array(
  Schema.Struct({
    who: Schema.Literals([0, 1]),
    kind: Schema.Literals(["merged", "prompt", "turn", "hatch"]),
    n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  }),
).check(Schema.isMaxLength(12))

/** The ids the test sends, which name their sender, so the server's own ids are told apart. */
const sentPrefix = "01K6ZQ8W3K"
const sentId = (who: number, i: number) => `${sentPrefix}${who}${String(i).padStart(15, "0")}`

const LogRow = Schema.Struct({
  input_id: Schema.String,
  input: Input,
  received_at: Schema.String,
  log_seq: Schema.Number,
  status: Schema.String,
})

/** A player's own log, their roll seed and their saved state, as the database holds them. */
const savedOf = (playerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const log = yield* Schema.decodeUnknownEffect(Schema.Array(LogRow))(
      yield* sql`
        SELECT input_id, input, received_at, log_seq, status FROM event_log
        WHERE player_id = ${playerId} ORDER BY log_seq
      `,
    )
    const [head] = yield* sql<{ roll_seed: string }>`SELECT roll_seed FROM players WHERE id = ${playerId}`
    const [row] = yield* sql<{ state: unknown }>`SELECT state FROM player_state WHERE player_id = ${playerId}`
    const state = yield* Schema.decodeUnknownEffect(PlayerState)(row!.state)
    return { log, rollSeed: head!.roll_seed, state }
  })

/** A player's state rebuilt from their own log alone, stepped as the write path stepped it. */
const replayed = (player: PlayerType, saved: Effect.Success<ReturnType<typeof savedOf>>) =>
  Effect.gen(function* () {
    const questPacks = yield* QuestPacks
    const start: PlayerStateType = initialState({
      characterName: player.displayName,
      timezone: "UTC",
      now: player.createdAt,
    })
    return saved.log
      .filter((row) => row.status === "accepted")
      .reduce(
        (state, row) =>
          step(state, row.input, {
            now: row.received_at,
            logSeq: row.log_seq,
            rollSeed: saved.rollSeed,
            rules,
            catalog,
            questPacks: questPacks.active,
            mode: { kind: "live" },
          }).state,
        start,
      )
  })

/** The ids the server logs for one player's events: each sent, less a repeat of their own earlier work. */
const loggedIds = (sent: ReadonlyArray<{ id: string; event: ClientEvent | null }>) =>
  sent
    .reduce(
      ({ ids, keys }, { id, event }) => {
        const key = event === null ? null : naturalKey(event)
        return key !== null && keys.has(key)
          ? { ids, keys }
          : { ids: [...ids, id], keys: key === null ? keys : new Set([...keys, key]) }
      },
      { ids: [] as Array<string>, keys: new Set<string>() },
    )
    .ids

describe("two players on one server", () => {
  it.effect.prop(
    "each keep their own log, and their saved state is a replay of it under their own roll seed",
    [Play],
    ([play]) =>
      withOnline(
        Effect.gen(function* () {
          const players = [yield* signedUp("ada", 1), yield* signedUp("bob", 2)] as const
          const handle = yield* webHandler
          const bearer = (who: 0 | 1) => `Bearer ${players[who].id}`
          for (const who of [0, 1] as const) {
            const opened = yield* handle(request("/v1/sessions", "POST", bearer(who), { sessionId: session }))
            expect(opened.status).toBe(200)
          }
          const sent = play.map(({ who, kind, n }, i) => {
            const id = sentId(who, i)
            // Both players merge the same few numbers: the same work, by two players, counts for each.
            const event = kind === "merged" ? merged(n, id) : kind === "prompt" ? prompt(n + 5, id) : kind === "turn" ? turn(id) : null
            return { who, id, event, command: event === null ? { ...hatch(id) } : null }
          })
          for (const { who, event, command } of sent) {
            const response = yield* handle(
              event === null
                ? request("/v1/commands", "POST", bearer(who), command)
                : request("/v1/events", "POST", bearer(who), { events: [event] }),
            )
            expect(response.status).toBe(200)
          }

          for (const who of [0, 1] as const) {
            const player = players[who]
            const saved = yield* savedOf(player.id)
            const theirs = sent.filter((one) => one.who === who)
            // Their own ids, in the order sent, and nobody else's: the rest of the log is the server's own.
            expect(saved.log.map((row) => row.input_id).filter((id) => id.startsWith(sentPrefix))).toEqual(
              loggedIds(theirs),
            )
            expect(yield* replayed(player, saved)).toEqual(saved.state)
          }
        }),
      ),
    serverRuns,
  )
})

// ── findOrCreate ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sign-ins by a few GitHub accounts, in any order and as often as they like, under a few logins in any case: so an
 * account renames, and a login one account gave up is taken by another.
 */
const SignIns = Schema.Array(
  Schema.Struct({
    userId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
    login: Schema.Literals(["ada", "Ada", "ADA", "bob", "Bob", "cy"]),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(10))

/** Who holds which login after `signIns`: each account the login it last signed in with, unless another took it. */
const loginsAfter = (signIns: typeof SignIns.Type): ReadonlyMap<number, string | null> =>
  signIns.reduce(
    (held, { userId, login }) =>
      new Map([
        ...[...held].map(([other, had]): [number, string | null] => [
          other,
          had !== null && had.toLowerCase() === login.toLowerCase() ? null : had,
        ]),
        [userId, login],
      ]),
    new Map<number, string | null>(),
  )

describe("Players.findOrCreate", () => {
  it.effect.prop(
    "makes one player per GitHub account, under the login it signs in with now, and a login names one account",
    [SignIns],
    ([signIns]) =>
      withOnline(
        Effect.gen(function* () {
          const players = yield* Players
          const found = yield* Effect.forEach(signIns, ({ userId, login }) =>
            players.findOrCreate({ displayName: login, characterName: login, timezone: "UTC", github: { userId, login } }))
          const first = (userId: number) => found[signIns.findIndex((one) => one.userId === userId)]!
          // Every sign-in answers with the account's first player, renamed or not, under the login it signed in with.
          signIns.forEach(({ userId, login }, i) =>
            expect(found[i]).toEqual({ ...first(userId), githubUserId: userId, githubLogin: login })
          )
          const accounts = [...new Set(signIns.map((one) => one.userId))]
          expect(new Set(accounts.map((userId) => first(userId).id)).size).toBe(accounts.length)
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ id: string; github_user_id: number; github_login: string | null }>`
            SELECT id, github_user_id::float8 AS github_user_id, github_login FROM players ORDER BY github_user_id
          `
          const [states] = yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM player_state`
          expect(states!.count).toBe(accounts.length)
          const held = loginsAfter(signIns)
          expect(rows).toEqual(
            [...accounts].sort((a, b) => a - b).map((userId) => ({
              id: first(userId).id,
              github_user_id: userId,
              github_login: held.get(userId) ?? null,
            })),
          )
        }),
      ),
    serverRuns,
  )
})
