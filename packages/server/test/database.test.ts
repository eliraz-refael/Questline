import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import { migrate, ServerRandom } from "../src/index.ts"
import { client, commit, merged, prompt, session, withServer } from "./fixtures.ts"

// What holds on either database the server runs on (PGlite, or Postgres in CI), and of the server's own randomness.
// Each run of a server property boots a fresh server, so those take few runs.

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

/** Every table the migrations make, in a fixed order, as rows. */
const tables = ["players", "player_state", "event_log", "server_events", "rolls", "quarantine", "sessions"] as const
const dump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* Effect.forEach(tables, (table) => sql`SELECT * FROM ${sql(table)} ORDER BY 1, 2`)
  const applied = yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`
  return { rows, applied }
})

// A short session of work: commits, merges and graded prompts, `n` picking each one's data.
const Work = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals(["commit", "merged", "prompt"]),
    n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 })),
  }),
).check(Schema.isMaxLength(8))

/** The ids the mod sends: set by the test, so they match between servers. */
const sent = "01K6ZQ8W3K"
const eventOf = ({ kind, n }: typeof Work.Type[number], i: number) => {
  const id = `${sent}${String(i).padStart(16, "0")}`
  return kind === "commit" ? commit(String(n), undefined, id) : kind === "merged" ? merged(n, id) : prompt(n, id)
}

/** A server's own ids and seeds once a session opened and `work` was sent. */
const play = (work: typeof Work.Type) =>
  Effect.gen(function* () {
    const api = yield* client
    yield* api.openSession({ payload: { sessionId: session } })
    yield* api.sendEvents({ payload: { events: work.map(eventOf) } })
    const sql = yield* SqlClient.SqlClient
    const players = yield* sql<{ id: string; roll_seed: string }>`SELECT id, roll_seed FROM players`
    const logged = yield* sql<{ input_id: string }>`SELECT input_id FROM event_log ORDER BY log_seq`
    // The ids the server made itself, for the missions it rolled.
    const own = logged.map((row) => row.input_id).filter((id) => !id.startsWith(sent))
    return { players, own }
  })

describe("the database", () => {
  it.effect.prop("is left as it is by migrating again", [Work], ([work]) =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.openSession({ payload: { sessionId: session } })
        yield* api.sendEvents({ payload: { events: work.map(eventOf) } })
        const before = yield* dump
        yield* migrate
        expect(yield* dump).toEqual(before)
      }),
    ), serverRuns)
})

/** `bytes` bytes of hex from a generator freshly seeded with `seed`. */
const hexFrom = (seed: string, bytes: number) =>
  Effect.gen(function* () {
    const random = yield* ServerRandom
    return yield* random.hex(bytes)
  }).pipe(Effect.provide(ServerRandom.layer(seed)))

describe("the server's randomness", () => {
  it.effect.prop("gives the same ids and roll seeds from the same seed", [Schema.NonEmptyString, Work], ([seed, work]) =>
    Effect.gen(function* () {
      const first = yield* withServer(play(work), undefined, false, seed)
      const second = yield* withServer(play(work), undefined, false, seed)
      expect(second).toEqual(first)
    }), serverRuns)

  it.effect.prop("differs between two boots", [Work], ([work]) =>
    Effect.gen(function* () {
      const first = yield* withServer(play(work))
      const second = yield* withServer(play(work))
      expect(second.players).not.toEqual(first.players)
      expect(second.own).not.toEqual(first.own)
    }), serverRuns)

  it.effect.prop(
    "draws `bytes` bytes of hex, the same from the same seed",
    [Schema.String, Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))],
    ([seed, bytes]) =>
      Effect.gen(function* () {
        const drawn = yield* hexFrom(seed, bytes)
        expect(drawn).toMatch(new RegExp(`^[0-9a-f]{${bytes * 2}}$`))
        expect(yield* hexFrom(seed, bytes)).toBe(drawn)
      }),
  )
})
