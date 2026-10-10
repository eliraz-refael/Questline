import { it } from "@effect/vitest"
import { clientEventTypes } from "@questline/schema"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { client, commandUsed, commit, contextMeasured, hatch, merged, prompt, session, withServer } from "./fixtures.ts"

describe("POST /v1/sessions", () => {
  it.effect("opens on the snapshot, the rules and the event types this server takes", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.cursor).toBe(0)
        expect(opened.snapshot.character).toMatchObject({ name: "Player", level: 0, gold: 0 })
        expect(opened.snapshot.pet).toBeNull()
        expect(opened.snapshot.serverId).toBe(`local-${opened.snapshot.player.id}`)
        expect(opened.rules.version).toBe(3)
        expect(opened.acceptedEventTypes).toEqual(clientEventTypes)
      }),
    ),
  )
})

describe("POST /v1/events", () => {
  it.effect("answers each event in the order sent, with the server events the batch caused", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const good = commit("a")
        const response = yield* api.sendEvents({ payload: { events: [{ id: "x", type: "pet.danced" }, good] } })
        expect(response.results).toEqual([
          { id: "x", status: "rejected", reason: "unknown_type" },
          { id: good.id, status: "accepted" },
        ])
        expect(response.events.map((event) => event.type)).toEqual(["xp.granted", "streak.changed", "xp.granted"])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.cursor).toBe(3)
        expect(opened.snapshot.character.xp.reported).toBe(13)
      }),
    ),
  )
})

describe("POST /v1/events: prompts and stats", () => {
  it.effect("prices graded prompts, counts the stats, and the snapshot carries them", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const events = [prompt(10), prompt(10), commandUsed("/code-review"), contextMeasured(80)]
        const response = yield* api.sendEvents({ payload: { events } })
        expect(response.results.map((result) => result.status)).toEqual(["accepted", "accepted", "accepted", "accepted"])
        const prompts = response.events.flatMap((event) =>
          event.type === "xp.granted" && event.data.reason === "prompt.graded" ? [event.data.amount] : [],
        )
        // The same grade twice is two prompts, not one fact reported twice.
        expect(prompts).toEqual([20, 20])
        expect(response.events.filter((event) => event.type === "stats.changed")).toHaveLength(4)
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.character.xp.reported).toBe(10 + 40)
        expect(opened.snapshot.stats).toEqual({
          clears: 0,
          compactions: { manual: 0, auto: 0 },
          commands: { "/code-review": 1 },
          contextCrossed: { pct50: 1, pct75: 1, pct100: 0 },
          contextPeak: { lastSession: 80, average: 80 },
          prompts: { graded: 2, gradedToday: 2, averageScore: 10, regretted: 2 },
        })
        expect(opened.rules.prompt.maxXp).toBe(20)
      }),
    ),
  )
})

describe("POST /v1/commands", () => {
  it.effect("refuses what the rules refuse, and applies the rest", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        expect(yield* api.runCommand({ payload: hatch() })).toEqual({
          status: "refused",
          code: "not_allowed",
          message: "The egg hatches at level 1",
        })
        yield* api.sendEvents({ payload: { events: [merged(1)] } })
        const hatched = yield* api.runCommand({ payload: hatch() })
        expect(hatched.status === "ok" && hatched.events.map((event) => event.type)).toEqual(["pet.hatched"])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.pet).toMatchObject({ species: "fox", name: "Pixel", form: 0 })
      }),
    ),
  )
})

describe("GET /v1/stream", () => {
  it.effect("answers at once when the stream is past the cursor", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.sendEvents({ payload: { events: [commit("a")] } })
        const stream = yield* api.stream({ query: { after: 1 } })
        expect(stream.events.map((event) => event.seq)).toEqual([2, 3])
        expect(stream.cursor).toBe(3)
        expect(stream.resync).toBeUndefined()
      }),
    ),
  )

  it.effect("holds the poll and wakes it when a commit adds events", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const poll = yield* Effect.forkChild(api.stream({ query: { after: 0 } }))
        // Let the poll park; the test clock never fires the 25-second timer on its own.
        yield* TestClock.adjust("1 second")
        yield* api.sendEvents({ payload: { events: [commit("a")] } })
        const stream = yield* Fiber.join(poll)
        expect(stream.events.map((event) => event.seq)).toEqual([1, 2, 3])
      }),
    ),
  )

  it.effect("leaves a held poll alone when a resent batch adds nothing", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const batch = { events: [commit("a")] }
        yield* api.sendEvents({ payload: batch })
        const poll = yield* Effect.forkChild(api.stream({ query: { after: 3 } }))
        yield* TestClock.adjust("1 second")
        yield* api.sendEvents({ payload: batch })
        yield* TestClock.adjust("1 second")
        expect(poll.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("23 seconds")
        expect(yield* Fiber.join(poll)).toMatchObject({ events: [], cursor: 3 })
      }),
    ),
  )

  it.effect("answers with nothing after 25 seconds", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const poll = yield* Effect.forkChild(api.stream({ query: { after: 0 } }))
        yield* TestClock.adjust("24 seconds")
        expect(poll.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        const stream = yield* Fiber.join(poll)
        expect(stream).toMatchObject({ events: [], cursor: 0 })
      }),
    ),
  )

  it.effect("asks for a resync when the cursor is ahead of the stream", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const stream = yield* api.stream({ query: { after: 5 } })
        expect(stream).toMatchObject({ events: [], cursor: 0, resync: true })
      }),
    ),
  )
})
