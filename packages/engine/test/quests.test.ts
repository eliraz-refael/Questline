import type {
  ClientEvent,
  Command,
  Context,
  GradeDimension,
  Input,
  PlayerState,
  QuestPack,
  Recorded,
  RulesConfig,
  ServerEventDraft,
  Step,
} from "@questline/schema"
import { QuestPack as QuestPackSchema, Step as StepSchema } from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  initialState,
  project,
  questsDue,
  starterCatalog,
  starterQuestPack,
  starterRules,
  startOfDay,
  step,
} from "../src/index.ts"

// Missions: the daily and weekly quests, rolled per local window, counted from play, and granted on completion.

/** A Friday. */
const start = "2026-10-09T08:00:00.000Z"
const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const other = "01K6ZQ8W3J5V7XKQ2M4N6P8R9V"
const third = "01K6ZQ8W3J5V7XKQ2M4N6P8R9W"
const fourth = "01K6ZQ8W3J5V7XKQ2M4N6P8R9X"
const repo: { type: "github"; repo: string; key: string } = {
  type: "github",
  repo: "acme/widgets",
  key: "ab".repeat(32),
}

const at = (hours: number): string => new Date(Date.parse(start) + hours * 3_600_000).toISOString()

let ids = 0
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

const scores = (
  score: number,
  extra: Partial<Record<GradeDimension, number>> = {},
): Record<GradeDimension, number> => ({
  clarity: score,
  grammar: score,
  specificity: score,
  instructive: score,
  context: score,
  doneCriteria: score,
  focus: score,
  regret: 0,
  ...extra,
})

const event = (
  data: DistributiveOmit<ClientEvent, "id" | "occurredAt" | "sessionId">,
  when = start,
  sessionId = session,
): Input => ({
  kind: "client",
  event: { ...data, id: nextId(), occurredAt: when, sessionId },
})

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

const prompt = (clarity: number, when = start): Input =>
  event(
    { type: "prompt.graded", data: { scores: scores(6, { clarity }), rubricVersion: 1, words: 12, grader: "haiku" } },
    when,
  )
const commit = (when = start): Input =>
  event({ type: "commit.made", data: { commit: { ...repo, sha: "a".repeat(40) } } }, when)
const turn = (when = start): Input => event({ type: "turn.completed", data: { durationMs: 1000, toolCalls: 1 } }, when)
const clear = (when = start): Input => event({ type: "session.cleared", data: {} }, when)
const command = (name: string, when = start): Input => event({ type: "command.used", data: { command: name } }, when)
const measured = (pct: number, sessionId: string, when = start): Input =>
  event({ type: "context.measured", data: { pct } }, when, sessionId)
const run = (cmd: DistributiveOmit<Command, "id">): Input => ({ kind: "command", command: { ...cmd, id: nextId() } })

const pack: QuestPack = {
  id: "test",
  version: 1,
  title: "Test quests",
  quests: [
    {
      id: "sharp",
      title: "Sharp",
      description: "Two prompts with clarity 8 or more.",
      cadence: "daily",
      goal: { kind: "fact", fact: "prompt.graded", count: 2, scores: { clarity: 8 } },
      rewards: { xp: 150, gold: 30 },
    },
    {
      id: "commits",
      title: "Commits",
      cadence: "daily",
      goal: { kind: "fact", fact: "commit.made", count: 2 },
      rewards: { loot: { rarity: "common", item: "wizard-hat" } },
    },
    {
      id: "clears",
      title: "Clears",
      cadence: "weekly",
      goal: { kind: "clears", count: 2 },
      rewards: { gold: 40 },
    },
    {
      id: "light",
      title: "Light",
      cadence: "weekly",
      goal: { kind: "context", under: 50, count: 2 },
      rewards: { xp: 20 },
    },
    {
      id: "review",
      title: "Review",
      cadence: "weekly",
      goal: { kind: "command", command: "/code-review", count: 1 },
      rewards: { loot: { rarity: "rare", pool: "wearable" } },
    },
    { id: "chain", title: "Chain", cadence: "chain", goal: { kind: "clears", count: 1 }, rewards: {} },
  ],
}

/** Two dailies and three weeklies: every quest of the pack is offered, two weeklies can run. */
const rules: RulesConfig = {
  ...starterRules,
  missions: { daily: { count: 2, tier: "uncommon" }, weekly: { offered: 3, active: 2, tier: "rare" } },
  questPacks: ["test"],
}

const fresh = (timezone = "UTC"): PlayerState => initialState({ characterName: "Player", timezone, now: start })

const nowOf = (input: Input, fallback: string): string => (input.kind === "client" ? input.event.occurredAt : fallback)

interface Played {
  readonly state: PlayerState
  readonly steps: ReadonlyArray<Step>
  readonly events: ReadonlyArray<ServerEventDraft>
}

/** Runs inputs as the write path would; a command runs at the time of the input before it. */
const play = (
  inputs: ReadonlyArray<Input>,
  options: {
    state?: PlayerState
    packs?: ReadonlyArray<QuestPack>
    dev?: boolean
    rules?: RulesConfig
    mode?: Context["mode"]
    /** The receipt time of every input, when it differs from the events' own. */
    now?: string
  } = {},
): Played => {
  let state = options.state ?? fresh()
  let now = start
  const steps: Array<Step> = []
  for (const [i, input] of inputs.entries()) {
    now = options.now ?? nowOf(input, now)
    const context: Context = {
      now,
      logSeq: i + 1,
      rollSeed: "secret-seed",
      rules: options.rules ?? rules,
      catalog: starterCatalog,
      questPacks: options.packs ?? [pack],
      mode: options.mode ?? { kind: "live" },
      ...(options.dev === true ? { dev: true } : {}),
    }
    const result = step(state, input, context)
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((one) => one.events) }
}

const ofType = <T extends ServerEventDraft["type"]>(
  events: ReadonlyArray<ServerEventDraft>,
  type: T,
): Array<Extract<ServerEventDraft, { type: T }>> =>
  events.filter((one): one is Extract<ServerEventDraft, { type: T }> => one.type === type)

const missions = (state: PlayerState) =>
  state.progress.quests.map((mission) => [mission.questId, mission.status, mission.progress])

describe("missions: the windows", () => {
  it("rolls the day's dailies, running, and the week's weeklies, on offer, at the day's first step and only then", () => {
    const { state, steps } = play([turn(), turn(at(1))])
    const offered = ofType(steps[0]?.events ?? [], "quest.offered")
    const rows = offered.map((one) => [
      one.data.cadence,
      one.data.quests.map((q) => [q.questId, q.status, q.start]).sort(),
    ])
    expect(rows).toEqual([
      [
        "daily",
        [
          ["commits", "active", "auto"],
          ["sharp", "active", "auto"],
        ],
      ],
      [
        "weekly",
        [
          ["clears", "offered", "pick"],
          ["light", "offered", "pick"],
          ["review", "offered", "pick"],
        ],
      ],
    ])
    // A day runs to the next local midnight; a week to the Monday after.
    expect(offered[0]?.data.quests[0]?.expiresAt).toBe("2026-10-10T00:00:00.000Z")
    expect(offered[1]?.data.quests[0]?.expiresAt).toBe("2026-10-12T00:00:00.000Z")
    expect(state.progress.questWindows).toEqual({ daily: "2026-10-09", weekly: "2026-10-05" })
    expect(ofType(steps[1]?.events ?? [], "quest.offered")).toEqual([])
    // Chains are not offered yet.
    expect(state.progress.quests.some((mission) => mission.questId === "chain")).toBe(false)
  })

  it("counts days and weeks in the player's time zone", () => {
    // 01:30 on Saturday in Jerusalem.
    const { state, events } = play([turn("2026-10-09T22:30:00.000Z")], { state: fresh("Asia/Jerusalem") })
    expect(state.progress.questWindows).toEqual({ daily: "2026-10-10", weekly: "2026-10-05" })
    expect(ofType(events, "quest.offered")[0]?.data.quests[0]?.expiresAt).toBe("2026-10-10T21:00:00.000Z")
    // Moved west, back into Friday: the missions rolled for Saturday keep running, and Friday isn't rolled again.
    const west = play([{ kind: "system", event: { type: "timezone.changed", tz: "UTC" } }], {
      state,
      now: "2026-10-09T22:40:00.000Z",
    })
    expect(west.events).toEqual([])
    expect(west.state.progress.quests).toEqual(state.progress.quests)
    expect(startOfDay("2026-10-25", "Europe/Berlin")).toBe("2026-10-24T22:00:00.000Z")
    expect(startOfDay("2026-10-26", "Europe/Berlin")).toBe("2026-10-25T23:00:00.000Z")
  })

  it("draws the rules' number from a bigger pool by the player's seed, the same set however often it is rolled", () => {
    const starter = { rules: starterRules, packs: [starterQuestPack] }
    const once = play([turn()], starter)
    const again = play([turn(at(2))], starter)
    const daily = (played: Played) =>
      played.state.progress.quests.filter((m) => m.cadence === "daily").map((m) => m.questId)
    const weekly = (played: Played) =>
      played.state.progress.quests.filter((m) => m.cadence === "weekly").map((m) => m.questId)
    expect(daily(once)).toHaveLength(3)
    expect(new Set(daily(once)).size).toBe(3)
    expect(weekly(once)).toHaveLength(5)
    expect(daily(again)).toEqual(daily(once))
    expect(weekly(again)).toEqual(weekly(once))
  })

  it("expires a day's missions at the next local midnight, and a week's on Monday, dropping the old window's grants", () => {
    const friday = play([prompt(9), prompt(9)])
    expect(friday.state.holdings.completedQuests.map((done) => done.questId)).toEqual(["sharp"])
    const saturday = play([turn("2026-10-10T09:00:00.000Z")], { state: friday.state })
    expect(ofType(saturday.events, "quest.offered").map((one) => one.data.cadence)).toEqual(["daily"])
    expect(
      saturday.state.progress.quests.filter((m) => m.cadence === "daily").map((m) => [m.window, m.progress]),
    ).toEqual([
      ["2026-10-10", 0],
      ["2026-10-10", 0],
    ])
    expect(saturday.state.holdings.completedQuests).toEqual([])
    const monday = play([turn("2026-10-12T09:00:00.000Z")], { state: saturday.state })
    expect(ofType(monday.events, "quest.offered").map((one) => one.data.cadence)).toEqual(["daily", "weekly"])
    expect(monday.state.progress.questWindows).toEqual({ daily: "2026-10-12", weekly: "2026-10-12" })
  })

  it("counts an event from a window already over toward nothing", () => {
    const saturday = play([turn(), turn("2026-10-10T01:00:00.000Z")]).state
    // Prompts from Friday evening, queued offline, arrive on Saturday.
    const late = play([prompt(9, "2026-10-09T23:00:00.000Z"), prompt(9, "2026-10-09T23:30:00.000Z")], {
      state: saturday,
      now: "2026-10-10T02:00:00.000Z",
    })
    expect(ofType(late.events, "quest.progress")).toEqual([])
    expect(late.state.progress.stats.prompts.graded).toBe(2)
  })

  it("says when a step would roll, and a refused command rolls nothing", () => {
    expect(questsDue(fresh(), start)).toBe(true)
    const { state } = play([turn()])
    expect(questsDue(state, at(1))).toBe(false)
    expect(questsDue(state, "2026-10-10T00:00:00.000Z")).toBe(true)
    const refused = play([run({ type: "quest.accept", data: { questId: "nope" } })])
    expect(refused.steps[0]?.refusal?.code).toBe("not_allowed")
    expect(refused.state).toEqual(fresh())
    expect(refused.events).toEqual([])
  })
})

describe("missions: progress and rewards", () => {
  it("counts a prompt toward a daily only when its scores meet the goal, then grants the rewards once", () => {
    const { state, events } = play([prompt(9), prompt(5), prompt(8), prompt(10)])
    expect(ofType(events, "quest.progress").map((one) => [one.data.questId, one.data.progress, one.data.goal])).toEqual(
      [
        ["sharp", 1, 2],
        ["sharp", 2, 2],
      ],
    )
    const completed = ofType(events, "quest.completed")
    expect(completed).toEqual([
      {
        type: "quest.completed",
        data: { questId: "sharp", title: "Sharp", tier: "uncommon", rewards: { xp: 150, gold: 30 } },
      },
    ])
    const after = events.slice(events.findIndex((one) => one.type === "quest.completed"))
    expect(after[1]).toMatchObject({ type: "xp.granted", data: { amount: 150, reason: "quest", tier: "reported" } })
    // 150 XP passes level 1: the level-up and its drop come with the reward.
    expect(after[2]).toMatchObject({ type: "level.up", data: { to: 1 } })
    expect(events.filter((one) => one.type === "gold.changed" && one.data.reason === "quest")).toEqual([
      { type: "gold.changed", data: { delta: 30, totalAfter: expect.any(Number), reason: "quest" } },
    ])
    expect(state.holdings.completedQuests).toEqual([
      { questId: "sharp", packId: "test", window: "2026-10-09", completedAt: start },
    ])
    expect(missions(state)).toContainEqual(["sharp", "completed", 2])
  })

  it("drops a reward's item as a quest entry, rolled at chance 1 and recorded, and a replay lands it again", () => {
    const inputs = [commit(), commit(at(1))]
    const live = play(inputs)
    expect(live.state.holdings.inventory).toMatchObject([
      { itemId: "wizard-hat", source: { kind: "quest", ref: "test/commits" } },
    ])
    expect(live.steps[1]?.rolls.map((roll) => [roll.trigger, roll.chance, roll.drop?.itemId])).toEqual([
      ["reward", 1, "wizard-hat"],
    ])
    let state = fresh()
    for (const [i, input] of inputs.entries()) {
      const recorded: Recorded = { rolls: live.steps[i]?.rolls ?? [], refusal: null }
      state = play([input], { state, mode: { kind: "replay", recorded } }).state
    }
    expect(state).toEqual(live.state)
  })

  it("counts stats toward a picked weekly only, and a crossing session stops counting until the goal is met", () => {
    const before = play([clear(), command("/code-review")])
    expect(ofType(before.events, "quest.progress")).toEqual([])
    const { state, events } = play(
      [
        run({ type: "quest.accept", data: { questId: "clears" } }),
        run({ type: "quest.accept", data: { questId: "light" } }),
        clear(at(1)),
        measured(30, session, at(1)),
        measured(70, session, at(2)),
        measured(20, other, at(2)),
        measured(40, third, at(2)),
        measured(10, fourth, at(3)),
        clear(at(3)),
      ],
      { state: before.state },
    )
    expect(ofType(events, "quest.progress").map((one) => [one.data.questId, one.data.progress])).toEqual([
      ["clears", 1],
      ["light", 1],
      ["light", 2],
      ["clears", 2],
    ])
    expect(ofType(events, "quest.completed").map((one) => [one.data.questId, one.data.tier])).toEqual([
      ["light", "rare"],
      ["clears", "rare"],
    ])
    expect(missions(state)).toEqual(
      expect.arrayContaining([
        ["light", "completed", 2],
        ["clears", "completed", 2],
      ]),
    )
  })

  it("rolls a reward from its pool at its rarity", () => {
    const { state } = play([run({ type: "quest.accept", data: { questId: "review" } }), command("/code-review")])
    const entry = state.holdings.inventory.find((one) => one.source.kind === "quest")
    const item = starterCatalog.find((one) => one.id === entry?.itemId)
    expect(item).toMatchObject({ category: "wearable", rarity: "rare" })
  })

  it("leaves a mission whose pack quest is gone idle, and the snapshot without it", () => {
    const { state } = play([turn()])
    const gone = play([prompt(9, at(1)), prompt(9, at(1))], { state, packs: [] })
    expect(ofType(gone.events, "quest.progress")).toEqual([])
    const player = { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
    const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
    expect(project(state, { rules, catalog: starterCatalog, questPacks: [], now: at(1) }, meta).quests).toEqual([])
  })
})

describe("missions: picking weeklies", () => {
  it("runs a picked weekly, up to the rules' number, and refuses a daily, a taken one, a full log and one not on offer", () => {
    const { steps, state } = play([
      turn(),
      run({ type: "quest.accept", data: { questId: "sharp" } }),
      run({ type: "quest.accept", data: { questId: "clears" } }),
      run({ type: "quest.accept", data: { questId: "clears" } }),
      run({ type: "quest.accept", data: { questId: "light" } }),
      run({ type: "quest.accept", data: { questId: "review" } }),
      run({ type: "quest.accept", data: { questId: "nope" } }),
    ])
    expect(steps.slice(1).map((one) => one.refusal?.message ?? "ok")).toEqual([
      "Dailies run on their own",
      "ok",
      "That mission is already taken",
      "ok",
      "The quest log is full: 2 weeklies run at once",
      "That mission is not on offer",
    ])
    expect(steps[2]?.events).toMatchObject([
      { type: "quest.accepted", data: { quest: { questId: "clears", status: "active", start: "pick" } } },
    ])
    expect(
      state.progress.quests.filter((m) => m.status === "active" && m.cadence === "weekly").map((m) => m.questId),
    ).toEqual(["clears", "light"])
  })

  it("puts an abandoned weekly back on offer with its progress gone, and refuses one not running or a daily", () => {
    const { steps, state } = play([
      run({ type: "quest.accept", data: { questId: "clears" } }),
      clear(),
      run({ type: "quest.abandon", data: { questId: "clears" } }),
      run({ type: "quest.abandon", data: { questId: "clears" } }),
      run({ type: "quest.abandon", data: { questId: "sharp" } }),
    ])
    expect(steps[2]?.events).toMatchObject([
      { type: "quest.abandoned", data: { quest: { questId: "clears", status: "offered", progress: 0 } } },
    ])
    expect(steps.slice(3).map((one) => one.refusal)).toEqual([
      { code: "invalid", message: "That mission is not running" },
      { code: "not_allowed", message: "Dailies run on their own" },
    ])
    expect(missions(state)).toContainEqual(["clears", "offered", 0])
  })

  it("replays an accept the live run applied, though the log has since filled", () => {
    const { state } = play([
      turn(),
      run({ type: "quest.accept", data: { questId: "clears" } }),
      run({ type: "quest.accept", data: { questId: "light" } }),
    ])
    const replayed = play([run({ type: "quest.accept", data: { questId: "review" } })], {
      state,
      mode: { kind: "replay", recorded: { rolls: [], refusal: null } },
    })
    expect(missions(replayed.state)).toContainEqual(["review", "active", 0])
  })
})

describe("missions: the snapshot", () => {
  it("shows each mission with its pack's words, and one whose window ended unfinished as expired", () => {
    const { state } = play([prompt(9), prompt(9)])
    const player = { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
    const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
    const of = (now: string) => project(state, { rules, catalog: starterCatalog, questPacks: [pack], now }, meta).quests
    expect(of(at(1)).find((quest) => quest.questId === "sharp")).toEqual({
      questId: "sharp",
      packId: "test",
      title: "Sharp",
      description: "Two prompts with clarity 8 or more.",
      cadence: "daily",
      start: "auto",
      status: "completed",
      progress: 2,
      goal: 2,
      rewards: { xp: 150, gold: 30 },
      expiresAt: "2026-10-10T00:00:00.000Z",
    })
    const tomorrow = of("2026-10-10T08:00:00.000Z")
    expect(tomorrow.map((quest) => [quest.questId, quest.status])).toEqual(
      expect.arrayContaining([
        ["sharp", "completed"],
        ["commits", "expired"],
        ["clears", "offered"],
      ]),
    )
  })
})

describe("missions: dev commands", () => {
  it("complete a mission at once, its rewards marked dev, and re-roll the windows; off dev mode both are refused", () => {
    const { steps, state } = play(
      [
        turn(),
        run({ type: "dev.completeQuest", data: { questId: "review" } }),
        run({ type: "dev.rollQuests", data: {} }),
      ],
      { dev: true },
    )
    expect(steps[1]?.events[0]).toMatchObject({ type: "quest.completed", data: { questId: "review" } })
    expect(state.holdings.inventory.map((entry) => entry.source.kind)).toEqual(["dev"])
    expect(ofType(steps[2]?.events ?? [], "quest.offered").map((one) => one.data.cadence)).toEqual(["daily", "weekly"])
    expect(missions(state).every(([, status, progress]) => status !== "completed" && progress === 0)).toBe(true)
    const off = play([
      turn(),
      run({ type: "dev.completeQuest", data: { questId: "review" } }),
      run({ type: "dev.rollQuests", data: {} }),
    ])
    expect(off.steps.slice(1).map((one) => one.refusal?.code)).toEqual(["not_allowed", "not_allowed"])
  })
})

describe("missions: schemas", () => {
  it("take the starter pack and the test pack, and every step's output", () => {
    expect(Schema.decodeUnknownSync(QuestPackSchema)(starterQuestPack)).toEqual(starterQuestPack)
    expect(Schema.decodeUnknownSync(QuestPackSchema)(pack)).toEqual(pack)
    const { steps } = play([
      prompt(9),
      prompt(9),
      commit(),
      commit(),
      run({ type: "quest.accept", data: { questId: "light" } }),
    ])
    for (const one of steps) expect(Schema.is(StepSchema)(one)).toBe(true)
  })

  it("refuse a pack whose ids repeat, or a score filter on a fact other than a prompt", () => {
    const decode = Schema.decodeUnknownExit(QuestPackSchema)
    const quest = pack.quests[0]
    expect(decode({ ...pack, quests: [quest, quest] })._tag).toBe("Failure")
    const scored = { ...quest, goal: { kind: "fact", fact: "commit.made", count: 1, scores: { clarity: 8 } } }
    expect(decode({ ...pack, quests: [scored] })._tag).toBe("Failure")
  })
})

describe("missions: review fixes", () => {
  it("counts a context session only once a later one is measured, so one that crosses first never counts", () => {
    const { state, events } = play([
      run({ type: "quest.accept", data: { questId: "light" } }),
      measured(5, session),
      measured(90, session, at(1)),
      measured(5, other, at(1)),
      measured(5, third, at(2)),
    ])
    expect(ofType(events, "quest.progress").map((one) => [one.data.questId, one.data.progress])).toEqual([["light", 1]])
    expect(missions(state)).toContainEqual(["light", "active", 1])
  })

  it("rolls a reward whose pool has nothing at or below its rarity from the whole catalogue, so its drop lands", () => {
    const artefact: QuestPack = {
      ...pack,
      quests: [
        {
          id: "clear-once",
          title: "Clear Once",
          cadence: "daily",
          goal: { kind: "clears", count: 1 },
          rewards: { loot: { rarity: "common", pool: "artefact" } },
        },
      ],
    }
    const { events } = play([clear()], { packs: [artefact] })
    const after = events.slice(events.findIndex((one) => one.type === "quest.completed"))
    expect(after.find((one) => one.type === "loot.dropped")).toMatchObject({ data: { tier: "common" } })
  })
})
