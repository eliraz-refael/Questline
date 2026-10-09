import { it } from "@effect/vitest"
import { step } from "@questline/engine"
import { Input as InputSchema } from "@questline/schema"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import type { Admitted, Stepper } from "../src/index.ts"
import { admit, CurrentPlayer, PlayerWriter } from "../src/index.ts"
import { commit, hatch, merged, start, turn, withServer } from "./fixtures.ts"

const admitted = (raw: unknown): Admitted => {
  const one = admit(raw, start)
  if (one.kind === "rejected") throw new Error(`fixture rejected: ${one.result.reason}`)
  return one.admitted
}

const command = (raw: ReturnType<typeof hatch>): Admitted => ({
  id: raw.id,
  input: { kind: "command", command: raw },
  naturalKey: null,
})

const apply = (inputs: ReadonlyArray<Admitted>) =>
  Effect.gen(function* () {
    const player = yield* CurrentPlayer
    const writer = yield* PlayerWriter
    return yield* writer.apply(player.id, start, inputs)
  })

const Head = Schema.Struct({ log_seq: Schema.Number, server_seq: Schema.Number })

const head = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT log_seq, server_seq FROM player_state`
  return yield* Schema.decodeUnknownEffect(Head)(rows[0])
})

const count = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT count(*)::int AS n FROM ${sql(table)}`
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ n: Schema.Number }))(rows[0]).pipe(Effect.map((row) => row.n))
  })

describe("PlayerWriter.apply", () => {
  it.effect("applies events in order, numbering the stream from 1 and moving the head", () =>
    withServer(
      Effect.gen(function* () {
        const applied = yield* apply([admitted(commit("a")), admitted(commit("b"))])
        expect(applied.map((one) => one.status)).toEqual(["accepted", "accepted"])
        const seqs = applied.flatMap((one) => one.events.map((event) => event.seq))
        expect(seqs).toEqual(seqs.map((_, i) => i + 1))
        expect(applied.flatMap((one) => one.events).every((event) => event.at === start)).toBe(true)
        expect(applied[1]?.events.every((event) => event.cause === applied[1]?.id)).toBe(true)
        expect(yield* head).toEqual({ log_seq: 2, server_seq: seqs.length })
      }),
    ),
  )

  it.effect("answers a repeated id as the first time and creates nothing new", () =>
    withServer(
      Effect.gen(function* () {
        const event = admitted(commit("a"))
        const [first] = yield* apply([event])
        const before = yield* head
        const [again] = yield* apply([event])
        expect(again).toEqual(first)
        expect(yield* head).toEqual(before)
      }),
    ),
  )

  it.effect("counts the same work once when it comes back under a new id", () =>
    withServer(
      Effect.gen(function* () {
        const [first] = yield* apply([admitted(merged(212))])
        const [second] = yield* apply([admitted(merged(212))])
        expect(second).toEqual({ id: second?.id, status: "duplicate", original: first?.id, refusal: null, events: [] })
        expect((yield* head).log_seq).toBe(1)
      }),
    ),
  )

  it.effect("keeps one failing input from blocking its batch, and quarantines it", () => {
    const failing: Stepper = (state, input, context) => {
      if (input.kind === "client" && input.event.type === "commit.made") throw new Error("engine defect")
      return step(state, input, context)
    }
    return withServer(
      Effect.gen(function* () {
        const applied = yield* apply([admitted(merged(1)), admitted(commit("a")), admitted(merged(2))])
        expect(applied.map((one) => [one.status, one.reason])).toEqual([
          ["accepted", undefined],
          ["rejected", "internal"],
          ["accepted", undefined],
        ])
        expect(yield* count("quarantine")).toBe(1)
        expect((yield* head).log_seq).toBe(3)
        // A retry of the rejected id gets the same answer instead of running again.
        const [retry] = yield* apply([admitted({ ...commit("a"), id: applied[1]?.id })])
        expect(retry).toEqual(applied[1])
      }),
      failing,
    )
  })

  it.effect("logs a refused command with its refusal, so a retry gets the same answer", () =>
    withServer(
      Effect.gen(function* () {
        const egg = command(hatch())
        const [refused] = yield* apply([egg])
        expect(refused?.refusal).toEqual({ code: "not_allowed", message: "The egg hatches at level 1" })
        expect(refused?.events).toEqual([])
        expect(yield* apply([egg])).toEqual([refused])
        expect((yield* head).log_seq).toBe(1)
      }),
    ),
  )

  it.effect("returns an applied command's events again on a retry", () =>
    withServer(
      Effect.gen(function* () {
        // A merge's 250 XP passes level 1, at 100.
        yield* apply([admitted(merged(1))])
        const egg = command(hatch())
        const [hatched] = yield* apply([egg])
        expect(hatched?.refusal).toBeNull()
        expect(hatched?.events.map((event) => event.type)).toEqual(["pet.hatched"])
        expect(yield* apply([egg])).toEqual([hatched])
      }),
    ),
  )

  it.effect("stores every loot roll with the log row that made it", () =>
    withServer(
      Effect.gen(function* () {
        const turns = Array.from({ length: 30 }, () => admitted(turn()))
        yield* apply(turns)
        expect(yield* count("rolls")).toBe(30)
        expect(yield* count("event_log")).toBe(30)
      }),
    ),
  )

  it.effect("keeps the log row's input as raw JSON the engine can read back", () =>
    withServer(
      Effect.gen(function* () {
        const event = admitted(commit("a"))
        yield* apply([event])
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`SELECT input FROM event_log`
        const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ input: InputSchema })))(rows)
        expect(row?.input).toEqual(event.input)
      }),
    ),
  )
})
