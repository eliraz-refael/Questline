import type {
  Context,
  GradeDimension,
  Input,
  PlayerState,
  QuestPack,
  RulesConfig,
  ServerEventDraft,
  SessionSpan,
  Step,
} from "@questline/schema"
import { PlayerState as PlayerStateSchema, QuestPack as QuestPackSchema } from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  closeSpan,
  initialState,
  keepClosedMs,
  openSpan,
  project,
  prunePresence,
  starterCatalog,
  starterQuestPack,
  starterRules,
  step,
} from "../src/index.ts"

// Presence and the parallel missions: which sessions the server says are open, and the moments when several of them
// each had a well-graded prompt close together.

/** A Friday. */
const start = "2026-10-09T08:00:00.000Z"
const first = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const second = "01K6ZQ8W3J5V7XKQ2M4N6P8R9V"
const third = "01K6ZQ8W3J5V7XKQ2M4N6P8R9W"
const fourth = "01K6ZQ8W3J5V7XKQ2M4N6P8R9X"

const at = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

const scores = (score: number): Record<GradeDimension, number> => ({
  clarity: score,
  grammar: score,
  specificity: score,
  instructive: score,
  context: score,
  doneCriteria: score,
  focus: score,
  regret: 0,
})

/** An input with the time the server received it. */
interface Timed {
  readonly input: Input
  readonly now: string
}

type Reason = "ended" | "lapsed"

const opened = (sessionId: string, minutes: number): Timed => ({
  input: { kind: "system", event: { type: "session.opened", sessionId } },
  now: at(minutes),
})

const closed = (sessionId: string, minutes: number, reason: Reason = "ended", stamped = minutes): Timed => ({
  input: { kind: "system", event: { type: "session.closed", sessionId, reason, at: at(stamped) } },
  now: at(minutes),
})

/** A prompt graded `score` on every quality, made at `minutes` and received at `received` (the same by default). */
const prompt = (sessionId: string, minutes: number, score = 8, received = minutes): Timed => ({
  input: {
    kind: "client",
    event: {
      id: nextId(),
      type: "prompt.graded",
      occurredAt: at(minutes),
      sessionId,
      data: { scores: scores(score), rubricVersion: 1, words: 12, grader: "haiku" },
    },
  },
  now: at(received),
})

const command = (type: "dev.fakeSession" | "dev.rollQuests", minutes: number): Timed => ({
  input: { kind: "command", command: { id: nextId(), type, data: {} } },
  now: at(minutes),
})

const accept = (questId: string, minutes = 0): Timed => ({
  input: { kind: "command", command: { id: nextId(), type: "quest.accept", data: { questId } } },
  now: at(minutes),
})

const abandon = (questId: string, minutes: number): Timed => ({
  input: { kind: "command", command: { id: nextId(), type: "quest.abandon", data: { questId } } },
  now: at(minutes),
})

const pack: QuestPack = {
  id: "together",
  version: 1,
  title: "Together",
  quests: [
    {
      id: "pair",
      title: "Pair",
      description: "Two sessions, each with a 7+ prompt within 20 minutes, twice.",
      cadence: "weekly",
      goal: { kind: "parallel", sessions: 2, grade: 7, withinMinutes: 20, count: 2 },
      rewards: { xp: 150, gold: 80 },
    },
    {
      id: "trio",
      title: "Trio",
      cadence: "weekly",
      goal: { kind: "parallel", sessions: 3, grade: 8, withinMinutes: 20, count: 1 },
      rewards: { xp: 200, gold: 100 },
    },
  ],
}

const rules: RulesConfig = {
  ...starterRules,
  missions: { daily: { count: 0, tier: "uncommon" }, weekly: { offered: 2, active: 2, tier: "rare" } },
  questPacks: ["together"],
}

const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

interface Played {
  readonly state: PlayerState
  readonly steps: ReadonlyArray<Step>
  readonly events: ReadonlyArray<ServerEventDraft>
}

const play = (inputs: ReadonlyArray<Timed>, options: { state?: PlayerState; dev?: boolean } = {}): Played => {
  let state = options.state ?? fresh()
  const steps: Array<Step> = []
  for (const [i, { input, now }] of inputs.entries()) {
    const context: Context = {
      now,
      logSeq: i + 1,
      rollSeed: "secret-seed",
      rules,
      catalog: starterCatalog,
      questPacks: [pack],
      mode: { kind: "live" },
      ...(options.dev === true ? { dev: true } : {}),
    }
    const result = step(state, input, context)
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((one) => one.events) }
}

/** Both weeklies picked, before anything else. */
const picked: ReadonlyArray<Timed> = [accept("pair"), accept("trio")]

const progressOf = (state: PlayerState, questId: string): number | undefined =>
  state.progress.quests.find((mission) => mission.questId === questId)?.progress

const moments = (events: ReadonlyArray<ServerEventDraft>, questId: string): Array<number> =>
  events.flatMap((event) =>
    event.type === "quest.progress" && event.data.questId === questId ? [event.data.progress] : [],
  )

describe("presence: the spans", () => {
  it("opens a session once, closes it once, and keeps a closed span only for a day", () => {
    const { state } = play([opened(first, 0), opened(first, 1), closed(first, 5), closed(first, 6), closed(second, 6)])
    expect(state.progress.presence).toEqual([{ sessionId: first, openedAt: at(0), closedAt: at(5) }])
    const later = play([opened(second, 24 * 60 + 10)], { state })
    expect(later.state.progress.presence).toEqual([{ sessionId: second, openedAt: at(24 * 60 + 10), closedAt: null }])
  })

  it("stamps a lapse at the last time the session was heard from, never before it opened or after receipt", () => {
    const { state } = play([
      opened(first, 0),
      closed(first, 4, "lapsed", 1),
      opened(second, 10),
      closed(second, 12, "lapsed", 9),
    ])
    expect(state.progress.presence).toEqual([
      { sessionId: first, openedAt: at(0), closedAt: at(1) },
      { sessionId: second, openedAt: at(10), closedAt: at(10) },
    ])
    const spans: Array<SessionSpan> = [{ sessionId: first, openedAt: at(0), closedAt: null }]
    expect(closeSpan(spans, first, at(30), at(20))).toEqual([{ sessionId: first, openedAt: at(0), closedAt: at(20) }])
  })

  it("opens a lapsed session again under a span of its own", () => {
    const { state } = play([opened(first, 0), closed(first, 4, "lapsed", 1), opened(first, 6)])
    expect(state.progress.presence).toEqual([
      { sessionId: first, openedAt: at(0), closedAt: at(1) },
      { sessionId: first, openedAt: at(6), closedAt: null },
    ])
  })

  it("keeps every open span and the latest closed ones past the cap", () => {
    const spans = Array.from({ length: 205 }, (_, i): SessionSpan => ({
      sessionId: nextId(),
      openedAt: at(i),
      closedAt: i === 0 ? null : at(i + 1),
    }))
    const kept = prunePresence(spans, at(300))
    expect(kept).toHaveLength(200)
    expect(kept[0]).toEqual(spans[0])
    expect(kept[1]).toEqual(spans[6])
    const twoDaysOn = new Date(Date.parse(at(0)) + keepClosedMs * 2).toISOString()
    expect(prunePresence(openSpan([], first, at(0)), twoDaysOn)).toHaveLength(1)
  })
})

describe("parallel missions", () => {
  it("count a moment when two open sessions each have a good prompt within the minutes, and spend them", () => {
    const { state, events } = play([
      ...picked,
      opened(first, 0),
      opened(second, 1),
      prompt(first, 2),
      prompt(second, 15),
      // Spent: these two alone make no second moment with the first two.
      prompt(second, 16),
    ])
    expect(moments(events, "pair")).toEqual([1])
    expect(progressOf(state, "pair")).toBe(1)
    expect(state.progress.quests.find((one) => one.questId === "pair")?.prompts).toEqual([
      { sessionId: second, at: at(16), openedAt: at(1) },
    ])
  })

  it("never count an idle session, a prompt below the grade, or prompts further apart than the minutes", () => {
    const { state } = play([
      ...picked,
      opened(first, 0),
      opened(second, 0),
      opened(third, 0),
      prompt(first, 1),
      prompt(second, 2, 6),
      prompt(second, 22),
    ])
    expect(progressOf(state, "pair")).toBe(0)
  })

  it("count only prompts made while their session was open, so one queued past a lapse counts for nothing", () => {
    const { state } = play([
      ...picked,
      opened(first, 0),
      opened(second, 0),
      prompt(first, 1),
      // Never opened: an older mod's session.
      prompt(fourth, 2),
      // Lapsed at minute 3, last heard; its prompt from minute 5 arrives once it is back.
      closed(second, 6, "lapsed", 3),
      prompt(second, 5, 8, 8),
    ])
    expect(progressOf(state, "pair")).toBe(0)
  })

  it("need the sessions to have been open together, not only prompts close in time", () => {
    const { state } = play([
      ...picked,
      opened(first, 0),
      prompt(first, 1),
      closed(first, 2),
      opened(second, 3),
      prompt(second, 4),
    ])
    expect(progressOf(state, "pair")).toBe(0)
  })

  it("earn nothing extra from more sessions than asked: three sessions make one pair, the third prompt waits", () => {
    const { state } = play([
      ...picked,
      opened(first, 0),
      opened(second, 0),
      opened(third, 0),
      prompt(first, 1),
      prompt(second, 2),
      prompt(third, 3),
    ])
    expect(progressOf(state, "pair")).toBe(1)
    // The trio's own: all three at 8, in three open sessions.
    expect(progressOf(state, "trio")).toBe(1)
  })

  it("complete at the goal and grant the rewards, as any mission", () => {
    const { events } = play([
      ...picked,
      opened(first, 0),
      opened(second, 0),
      prompt(first, 1),
      prompt(second, 2),
      prompt(first, 30),
      prompt(second, 31),
    ])
    expect(moments(events, "pair")).toEqual([1, 2])
    const done = events.filter((event) => event.type === "quest.completed")
    expect(done).toEqual([
      {
        type: "quest.completed",
        data: { questId: "pair", title: "Pair", tier: "rare", rewards: { xp: 150, gold: 80 } },
      },
    ])
  })

  it("count prompts only while the mission runs, and an abandon lets the waiting ones go", () => {
    const { state } = play([
      opened(first, 0),
      opened(second, 0),
      // Before the pick: it waits for nothing.
      prompt(first, 1),
      accept("pair", 2),
      prompt(second, 3),
      abandon("pair", 5),
      accept("pair", 6),
      prompt(first, 7),
    ])
    expect(progressOf(state, "pair")).toBe(0)
    expect(state.progress.quests.find((one) => one.questId === "pair")?.prompts).toEqual([
      { sessionId: first, at: at(7), openedAt: at(0) },
    ])
  })

  it("show the goal's kind in the snapshot, so the mod can word it", () => {
    const { state } = play([...picked])
    const player = { id: first, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
    const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
    const quests = project(state, { rules, catalog: starterCatalog, questPacks: [pack], now: at(1) }, meta).quests
    expect(quests.map((quest) => [quest.questId, quest.goalKind])).toEqual([
      ["pair", "parallel"],
      ["trio", "parallel"],
    ])
  })

  it("replay to the same state from the same inputs", () => {
    const inputs = [...picked, opened(first, 0), opened(second, 0), prompt(first, 1), prompt(second, 2)]
    expect(play(inputs).state).toEqual(play(inputs).state)
    expect(Schema.decodeUnknownSync(PlayerStateSchema)(play(inputs).state)).toEqual(play(inputs).state)
  })
})

describe("a stand-in session, in dev mode", () => {
  it("opens with a prompt graded 10, so a good prompt in the player's own session makes a moment with it", () => {
    const { state, events } = play([...picked, opened(first, 0), command("dev.fakeSession", 1), prompt(first, 2)], {
      dev: true,
    })
    expect(moments(events, "pair")).toEqual([1])
    const stand = state.progress.presence.find((span) => span.sessionId !== first)
    expect(stand).toEqual({ sessionId: expect.any(String), openedAt: at(1), closedAt: at(31) })
  })

  it("is refused off dev mode", () => {
    const { steps } = play([command("dev.fakeSession", 1)])
    expect(steps[0]?.refusal?.code).toBe("not_allowed")
  })
})

describe("the starter pack", () => {
  it("offers the three parallel weeklies, weeklies only, modest and in the usual weekly range", () => {
    const parallel = starterQuestPack.quests.filter((quest) => quest.goal.kind === "parallel")
    expect(parallel.map((quest) => [quest.id, quest.cadence, quest.goal, quest.rewards])).toEqual([
      [
        "two-minds",
        "weekly",
        { kind: "parallel", sessions: 2, grade: 7, withinMinutes: 20, count: 3 },
        { xp: 150, gold: 80 },
      ],
      [
        "juggler",
        "weekly",
        { kind: "parallel", sessions: 3, grade: 7, withinMinutes: 20, count: 1 },
        { xp: 200, gold: 100 },
      ],
      [
        "conductor",
        "weekly",
        { kind: "parallel", sessions: 3, grade: 8, withinMinutes: 20, count: 2 },
        { xp: 300, gold: 150, loot: { rarity: "rare" } },
      ],
    ])
    expect(Schema.decodeUnknownSync(QuestPackSchema)(starterQuestPack)).toEqual(starterQuestPack)
    expect(starterQuestPack.version).toBe(2)
  })

  it("refuses a parallel goal of fewer than two sessions", () => {
    const goal = { kind: "parallel", sessions: 1, grade: 7, withinMinutes: 20, count: 1 }
    const one = { ...pack, quests: [{ ...pack.quests[0], goal }] }
    expect(() => Schema.decodeUnknownSync(QuestPackSchema)(one)).toThrow()
  })
})
