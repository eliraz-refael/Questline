import { it } from "@effect/vitest"
import { clientEventTypes } from "@questline/schema"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import {
  client,
  commandUsed,
  commit,
  contextMeasured,
  hatch,
  merged,
  nextId,
  prompt,
  session,
  start,
  withServer,
} from "./fixtures.ts"

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
        expect(opened.rules.version).toBe(4)
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

describe("POST /v1/commands: band styles", () => {
  it.effect("equips an owned band style, keeps it across sessions, refuses the wrong slot, and unequips it", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const sql = yield* SqlClient.SqlClient
        const entryId = "01K6ZQ8W3J0000000000009001"
        const entry = { id: entryId, itemId: "starlit-edge", acquiredAt: start, source: { kind: "drop", ref: "0" }, dye: null }
        yield* sql`UPDATE player_state SET state = jsonb_set(state, '{holdings,inventory}', ${JSON.stringify([entry])}::jsonb)`
        const wrong = yield* api.runCommand({ payload: { id: nextId(), type: "item.equip", data: { entryId, slot: "xpBar" } } })
        expect(wrong).toMatchObject({ status: "refused", code: "invalid" })
        const equipped = yield* api.runCommand({ payload: { id: nextId(), type: "item.equip", data: { entryId, slot: "topEdge" } } })
        expect(equipped.status === "ok" && equipped.events.map((event) => [event.type, event.data])).toEqual([
          ["item.equipped", { slot: "topEdge", entryId }],
        ])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.character.equipped).toEqual({ topEdge: entryId })
        expect(opened.snapshot.items.map((item) => [item.id, item.look?.fps])).toEqual([["starlit-edge", 5]])
        const stream = yield* api.stream({ query: { after: 0 } })
        expect(stream.events.map((event) => event.type)).toEqual(["item.equipped"])
        const unequipped = yield* api.runCommand({ payload: { id: nextId(), type: "item.unequip", data: { slot: "topEdge" } } })
        expect(unequipped.status).toBe("ok")
        expect((yield* api.openSession({ payload: { sessionId: session } })).snapshot.character.equipped).toEqual({})
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
