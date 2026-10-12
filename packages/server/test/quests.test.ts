import { it } from "@effect/vitest"
import { starterQuestPack, starterRules } from "@pathofdev/engine"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { QuestPacks } from "../src/index.ts"
import { client, nextId, session, withServer } from "./fixtures.ts"

// Missions over the routes: the starter pack published as the server starts, the day's missions rolled when a session
// opens, and weeklies picked through the command route.

describe("missions over the routes", () => {
  it.effect("publish the starter pack once, and open a fresh session on the day's dailies and the week's offer", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const sql = yield* SqlClient.SqlClient
        // A second start publishes nothing new: the version is already there.
        yield* Effect.scoped(Layer.build(QuestPacks.layer))
        const packs = yield* sql<{ pack: string; version: number }>`SELECT pack, version FROM quest_packs`
        expect(packs).toEqual([{ pack: starterQuestPack.id, version: starterQuestPack.version }])

        const opened = yield* api.openSession({ payload: { sessionId: session } })
        const { quests } = opened.snapshot
        const daily = quests.filter((quest) => quest.cadence === "daily")
        const weekly = quests.filter((quest) => quest.cadence === "weekly")
        expect(daily.map((quest) => [quest.status, quest.start])).toEqual(
          Array(starterRules.missions.daily.count).fill(["active", "auto"]),
        )
        expect(weekly.map((quest) => [quest.status, quest.start])).toEqual(
          Array(starterRules.missions.weekly.offered).fill(["offered", "pick"]),
        )
        // The clock stands at 08:00 UTC on a Friday: the day ends at midnight, the week on Monday.
        expect(daily[0]?.expiresAt).toBe("2026-10-10T00:00:00.000Z")
        expect(weekly[0]?.expiresAt).toBe("2026-10-12T00:00:00.000Z")

        const stream = yield* api.stream({ query: { after: 0 } })
        expect(stream.events.map((event) => event.type === "quest.offered" && event.data.cadence)).toEqual([
          "daily",
          "weekly",
        ])
        const logged = yield* sql<{ natural_key: string }>`SELECT natural_key FROM event_log`
        expect(logged).toEqual([{ natural_key: "quests.refresh:2026-10-09" }])

        // Opening again the same day rolls nothing.
        expect((yield* api.openSession({ payload: { sessionId: session } })).snapshot.cursor).toBe(2)
      }),
    ),
  )

  it.effect("roll the next day's dailies when a session opens on it, and keep the week's", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const first = yield* api.openSession({ payload: { sessionId: session } })
        yield* TestClock.adjust("1 day")
        const next = yield* api.openSession({ payload: { sessionId: session } })
        const stream = yield* api.stream({ query: { after: first.snapshot.cursor } })
        expect(stream.events.map((event) => event.type === "quest.offered" && event.data.cadence)).toEqual(["daily"])
        const weeklies = (opened: typeof first) => opened.snapshot.quests.filter((quest) => quest.cadence === "weekly")
        expect(weeklies(next)).toEqual(weeklies(first))
        expect(next.snapshot.quests.find((quest) => quest.cadence === "daily")?.expiresAt).toBe(
          "2026-10-11T00:00:00.000Z",
        )
      }),
    ),
  )

  it.effect("run a picked weekly, refuse a daily, and give one up again", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        const weekly = opened.snapshot.quests.find((quest) => quest.cadence === "weekly")
        const daily = opened.snapshot.quests.find((quest) => quest.cadence === "daily")
        if (weekly === undefined || daily === undefined) throw new Error("no missions offered")

        const accept = (questId: string) =>
          api.runCommand({ payload: { id: nextId(), type: "quest.accept", data: { questId } } })
        expect(yield* accept(weekly.questId)).toMatchObject({
          status: "ok",
          events: [{ type: "quest.accepted", data: { quest: { questId: weekly.questId, status: "active" } } }],
        })
        expect(yield* accept(daily.questId)).toEqual({
          status: "refused",
          code: "not_allowed",
          message: "Dailies run on their own",
        })
        const running = yield* api.openSession({ payload: { sessionId: session } })
        expect(running.snapshot.quests.find((quest) => quest.questId === weekly.questId)?.status).toBe("active")

        const abandoned = yield* api.runCommand({
          payload: { id: nextId(), type: "quest.abandon", data: { questId: weekly.questId } },
        })
        expect(abandoned).toMatchObject({ status: "ok", events: [{ type: "quest.abandoned" }] })
      }),
    ),
  )

  it.effect("complete a mission at once in dev mode, granting its rewards as dev", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        const daily = opened.snapshot.quests.find((quest) => quest.cadence === "daily")
        if (daily === undefined) throw new Error("no dailies offered")
        const done = yield* api.runCommand({
          payload: { id: nextId(), type: "dev.completeQuest", data: { questId: daily.questId } },
        })
        if (done.status !== "ok") throw new Error(done.message)
        expect(done.events[0]).toMatchObject({ type: "quest.completed", data: { questId: daily.questId } })
        expect(done.events.find((event) => event.type === "xp.granted")).toMatchObject({ data: { reason: "dev" } })
        const after = yield* api.openSession({ payload: { sessionId: session } })
        expect(after.snapshot.quests.find((quest) => quest.questId === daily.questId)?.status).toBe("completed")
      }),
      undefined,
      true,
    ),
  )
})
