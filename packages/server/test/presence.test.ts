import { it } from "@effect/vitest"
import { initialState } from "@pathofdev/engine"
import type { ServerEvent } from "@pathofdev/schema"
import { PlayerState } from "@pathofdev/schema"
import { Effect, Schema } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { CurrentPlayer, lapse, migrate, migrations, Presence } from "../src/index.ts"
import { client, minutesLater, nextId, profile, prompt, session, start, testSql, withServer } from "./fixtures.ts"

// Presence over the routes: a mod that keeps its session live opens it, its stream polls keep it fresh, and it closes
// it at the end; the sweep closes one unheard for two minutes. Only the changes reach the log.

const other = "01K6ZQ8W3J5V7XKQ2M4N6P8R9V"
const coldStart = 30_000

/** The presence inputs the log took, in order. */
const presenceLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ input: { event: Record<string, unknown> } }>`
    SELECT input FROM event_log
    WHERE input ->> 'kind' = 'system' AND input -> 'event' ->> 'type' LIKE 'session.%'
    ORDER BY log_seq
  `
  return rows.map((row) => row.input.event)
})

const spans = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT state FROM player_state`
  const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: PlayerState })))(rows)
  return row?.state.progress.presence ?? []
})

/** Lets work the test clock woke finish: it runs its queries on the real clock. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))

/**
 * The test clock moved on in the sweep's own steps, each let finish, so every sweep reads the time it woke at and sets
 * its next wake from there.
 */
const sweepFor = (seconds: number) =>
  Effect.gen(function* () {
    for (let passed = 0; passed < seconds; passed += 30) {
      yield* TestClock.adjust("30 seconds")
      yield* settle
    }
  })

const heardAt = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ last_heard_at: string }>`
      SELECT last_heard_at FROM sessions WHERE session_id = ${sessionId}
    `
    return rows[0]?.last_heard_at
  })

describe("presence", () => {
  it.effect("opens a session the mod keeps live once, however often it opens, and an older mod's never", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* api.openSession({ payload: { sessionId: other } })
        expect(yield* presenceLog).toEqual([{ type: "session.opened", sessionId: session }])
        expect(yield* spans).toEqual([{ sessionId: session, openedAt: start, closedAt: null }])
      }),
    ),
  )

  it.effect("keeps a session live on each poll that names it, logging none of them", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* TestClock.adjust("90 seconds")
        // The day's offer is on the stream already, so the poll answers at once.
        yield* api.stream({ query: { after: 0, session } })
        expect(yield* heardAt(session)).toBe(minutesLater(1.5))
        yield* sweepFor(90)
        expect(yield* presenceLog).toEqual([{ type: "session.opened", sessionId: session }])
      }),
    ),
  )

  it.effect("lapses a session unheard for two minutes, at its last-heard time, and opens it again once heard", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        // The sweep runs every 30 seconds: at 2.5 minutes it finds the session unheard since the start.
        yield* sweepFor(120)
        expect(yield* presenceLog).toEqual([{ type: "session.opened", sessionId: session }])
        yield* sweepFor(30)
        expect(yield* presenceLog).toEqual([
          { type: "session.opened", sessionId: session },
          { type: "session.closed", sessionId: session, reason: "lapsed", at: start },
        ])
        yield* api.stream({ query: { after: 0, session } })
        expect((yield* presenceLog).at(-1)).toEqual({ type: "session.opened", sessionId: session })
        expect(yield* spans).toEqual([
          { sessionId: session, openedAt: start, closedAt: start },
          { sessionId: session, openedAt: minutesLater(2.5), closedAt: null },
        ])
      }),
    ),
  )

  it.effect("closes a session once when the mod ends it, and never opens it again", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* TestClock.adjust("1 minute")
        expect(yield* api.closeSession({ params: { id: session } })).toEqual({ closed: true })
        expect(yield* api.closeSession({ params: { id: session } })).toEqual({ closed: false })
        expect(yield* api.closeSession({ params: { id: other } })).toEqual({ closed: false })
        // A late request of the mod's own, on the id it closed.
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* api.stream({ query: { after: 0, session } })
        yield* sweepFor(300)
        expect(yield* presenceLog).toEqual([
          { type: "session.opened", sessionId: session },
          { type: "session.closed", sessionId: session, reason: "ended", at: minutesLater(1) },
        ])
        expect(yield* spans).toEqual([{ sessionId: session, openedAt: start, closedAt: minutesLater(1) }])
      }),
    ),
  )

  it.effect("counts a moment for a parallel mission from prompts in two sessions open together", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* api.openSession({ payload: { sessionId: other, presence: true } })
        // Re-roll the dev sandbox's week until Two Minds is on offer, then pick it.
        for (let tries = 0; tries < 40; tries++) {
          const opened = yield* api.openSession({ payload: { sessionId: session, presence: true } })
          if (opened.snapshot.quests.some((quest) => quest.questId === "two-minds")) break
          yield* api.runCommand({ payload: { id: nextId(), type: "dev.rollQuests", data: {} } })
        }
        const picked = yield* api.runCommand({
          payload: { id: nextId(), type: "quest.accept", data: { questId: "two-minds" } },
        })
        expect(picked.status).toBe("ok")
        const sent = yield* api.sendEvents({ payload: { events: [prompt(8), { ...prompt(8), sessionId: other }] } })
        const ticks = sent.events.flatMap((event: ServerEvent) =>
          event.type === "quest.progress" && event.data.questId === "two-minds" ? [event.data.progress] : [],
        )
        expect(ticks).toEqual([1])
        const after = yield* api.openSession({ payload: { sessionId: session, presence: true } })
        expect(after.snapshot.quests.find((quest) => quest.questId === "two-minds")).toMatchObject({
          progress: 1,
          goal: 3,
          goalKind: "parallel",
        })
      }),
      undefined,
      true,
    ),
  )
})

describe("presence: review fixes", () => {
  it.effect("leaves open a session heard from between the sweep's look and its close", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const presence = yield* Presence
        const player = yield* CurrentPlayer
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        // What the sweep saw: unheard since the start. A poll then names the session before the close.
        const seen = { player_id: player.id, session_id: session, last_heard_at: start }
        yield* TestClock.adjust("150 seconds")
        yield* presence.heard(player.id, session)
        expect(yield* lapse(seen)).toBe(false)
        expect(yield* heardAt(session)).toBe(minutesLater(2.5))
        expect(yield* lapse({ ...seen, last_heard_at: minutesLater(2.5) })).toBe(true)
      }),
    ),
  )

  it.effect("answers a poll even when the session can't be heard from: presence never holds up the stream", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const sql = yield* SqlClient.SqlClient
        yield* api.openSession({ payload: { sessionId: session, presence: true } })
        yield* sql`DROP TABLE sessions`
        const polled = yield* api.stream({ query: { after: 0, session } })
        expect(polled.events.length).toBeGreaterThan(0)
      }),
    ),
  )
})

describe("the presence migration", () => {
  it.effect("gives a player saved before presence no spans, and its missions no waiting prompts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0008"))
      yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
      const fresh = initialState({ ...profile, now: start })
      const mission = {
        questId: "light-packer",
        packId: "starter",
        cadence: "weekly",
        window: "2026-10-05",
        status: "active",
        progress: 1,
        sessions: [{ sessionId: session, peak: 20 }],
      }
      const { presence: _presence, ...progress } = fresh.progress
      const saved = { ...fresh, progress: { ...progress, quests: [mission] } }
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
        VALUES ('p', NULL, NULL, 'Player', 'seed', ${start})
      `
      yield* sql`
        INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
        VALUES ('p', ${JSON.stringify(saved)}::jsonb, 0, 0, 1, 8, 6)
      `
      yield* migrate
      const stored = yield* sql`SELECT state FROM player_state`
      const states = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: PlayerState })))(stored)
      expect(states.map((row) => row.state)).toEqual([
        { ...fresh, progress: { ...fresh.progress, quests: [{ ...mission, prompts: [] }] } },
      ])
      expect(yield* sql`SELECT * FROM sessions`).toEqual([])
    }).pipe(Effect.provide(testSql)),
    coldStart,
  )
})
