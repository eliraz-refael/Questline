import { it as prop } from "@effect/vitest"
import type {
  ClientEvent,
  Command,
  Context,
  GradeDimension,
  Input,
  InventoryEntry,
  PlayerState,
  Recorded,
  RulesConfig,
  Slot,
  Step,
} from "@questline/schema"
import { ItemDef, RulesConfig as RulesSchema, Step as StepSchema } from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  glyphFor,
  initialState,
  levelOf,
  maxCommands,
  project,
  starterCatalog,
  starterRules,
  statsOf,
  step,
  totalXp,
  xpForLevel,
} from "../src/index.ts"

const start = "2026-10-09T08:00:00Z"
const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const repo: { type: "github"; repo: string; key: string } = { type: "github", repo: "acme/widgets", key: "ab".repeat(32) }

const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
/** ULIDs in order: the time part fixed, the counter in the random part. */
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

/** The same score on every dimension. */
const flat = (score: number): Record<GradeDimension, number> => ({
  clarity: score,
  grammar: score,
  specificity: score,
  instructive: score,
  context: score,
  doneCriteria: score,
  focus: score,
  regret: score,
})

/** An event of `type`; `n`, 0-10, varies its data: a prompt's scores, a context fill of n * 10%, and so on. */
const client = (type: ClientEvent["type"], minutes = 0, sessionId = session, n = 10): Input => {
  const base = { id: nextId(), occurredAt: minutesLater(minutes), sessionId }
  const event = ((): ClientEvent => {
    switch (type) {
      case "turn.completed":
        return { ...base, type, data: { durationMs: 1000, toolCalls: 2 } }
      case "commit.made":
        return { ...base, type, data: { commit: { ...repo, sha: "a".repeat(40) } } }
      case "change.opened":
      case "change.merged":
        return { ...base, type, data: { change: { ...repo, number: 7 } } }
      case "review.submitted":
        return { ...base, type, data: { change: { ...repo, number: 7 }, state: "approved" } }
      case "issue.closed":
        return { ...base, type, data: { issue: { ...repo, number: 9 } } }
      case "tests.failed":
      case "tests.passed":
        return { ...base, type, data: { checkout: { ...repo, branch: "main", headSha: null }, runner: "vitest" } }
      case "repo.explored":
        return { ...base, type, data: { repo } }
      case "prompt.graded":
        return { ...base, type, data: { scores: flat(n), rubricVersion: 1, words: 12, grader: "haiku" } }
      case "session.cleared":
        return { ...base, type, data: {} }
      case "session.compacted":
        return { ...base, type, data: { trigger: n % 2 === 0 ? "manual" : "auto" } }
      case "command.used":
        return { ...base, type, data: { command: n % 2 === 0 ? "/code-review" : "/plugin:deploy" } }
      case "context.measured":
        return { ...base, type, data: { pct: n * 10 } }
    }
  })()
  return { kind: "client", event }
}

const context = (logSeq: number, now: string, rules: RulesConfig = starterRules, mode?: Context["mode"]): Context => ({
  now,
  logSeq,
  rollSeed: "secret-seed",
  rules,
  catalog: starterCatalog,
  questPacks: [],
  mode: mode ?? { kind: "live" },
})

const nowOf = (input: Input): string => (input.kind === "client" ? input.event.occurredAt : start)

/** Runs inputs through `step` as the write path would, numbering log rows from 1. */
const play = (inputs: ReadonlyArray<Input>, rules?: RulesConfig, state = fresh()) => {
  const steps: Array<Step> = []
  for (const [i, input] of inputs.entries()) {
    const result = step(state, input, context(i + 1, nowOf(input), rules))
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((s) => s.events) }
}

const replay = (inputs: ReadonlyArray<Input>, recorded: ReadonlyArray<Recorded>, rules?: RulesConfig) => {
  let state = fresh()
  const events = []
  for (const [i, input] of inputs.entries()) {
    const rec = recorded[i] ?? { rolls: [], refusal: null }
    const result = step(state, input, context(i + 1, nowOf(input), rules, { kind: "replay", recorded: rec }))
    events.push(...result.events)
    state = result.state
  }
  return { state, events }
}

const always: RulesConfig = { ...starterRules, loot: { ...starterRules.loot, chancePerTurn: 1, promptChanceAtTen: 1 } }

describe("step: XP", () => {
  it("grants a commit's reported XP, and the day's first event starts the streak", () => {
    const { state, events } = play([client("commit.made")])
    expect(state.progress.xp).toEqual({ verified: 0, reported: 13 })
    expect(events.map((e) => e.type)).toEqual(["xp.granted", "streak.changed", "xp.granted"])
    expect(events[2]).toEqual({ type: "xp.granted", data: { amount: 3, tier: "reported", reason: "commit.made", totalAfter: 13 } })
  })

  it("stops at the daily cap but still counts the work", () => {
    const { state, events } = play(Array.from({ length: 21 }, (_, i) => client("commit.made", i)))
    expect(state.progress.xp.reported).toBe(10 + 20 * 3)
    expect(state.progress.totals["commit.made"]).toBe(21)
    expect(events.filter((e) => e.type === "xp.capped")).toEqual([
      { type: "xp.capped", data: { eventType: "commit.made", cap: 20 } },
    ])
  })

  it("opens a new day's cap, and grows the streak XP day by day", () => {
    const { state } = play([client("commit.made"), client("commit.made", 24 * 60), client("commit.made", 48 * 60)])
    expect(state.progress.xp.reported).toBe(3 * 3 + 10 + 20 + 30)
  })

  it("gives an opened PR nothing and a merged one its full XP", () => {
    const { state } = play([client("change.opened"), client("change.merged", 5)])
    expect(state.progress.xp.reported).toBe(10 + 250)
    expect(state.progress.totals).toMatchObject({ "change.opened": 1, "change.merged": 1 })
  })

  it("leaves verified-tier hints to the verifier", () => {
    const { state } = play([client("issue.closed"), client("review.submitted", 1)])
    expect(state.progress.xp.reported).toBe(10)
    expect(state.progress.totals["issue.closed"]).toBeUndefined()
  })

  it("credits a green run only after a red one in the same session and repo", () => {
    const other = "01K6ZQ8W3J5V7XKQ2M4N6P8R9V"
    const unarmed = play([client("tests.passed")])
    expect(unarmed.state.progress.xp.reported).toBe(10)
    const elsewhere = play([client("tests.failed", 0, other), client("tests.passed", 1)])
    expect(elsewhere.state.progress.xp.reported).toBe(10)
    const fixed = play([client("tests.failed"), client("tests.passed", 1), client("tests.passed", 2)])
    expect(fixed.state.progress.xp.reported).toBe(10 + 20)
  })

  it("levels up once past the curve and never replays a level already reached", () => {
    const { state, events } = play([client("change.merged")])
    expect(levelOf(state, starterRules).level).toBe(1)
    expect(events.filter((e) => e.type === "level.up")).toEqual([
      { type: "level.up", data: { from: 0, to: 1, tier: "rare", glyph: "⚔" } },
    ])
    expect(state.holdings.peakLevel).toBe(1)
  })
})

describe("step: loot", () => {
  it("rolls on every turn, numbering rolls and adding the drop with its gold", () => {
    const { state, steps } = play([client("turn.completed"), client("turn.completed", 1)], always)
    expect(steps.flatMap((s) => s.rolls.map((r) => r.number))).toEqual([0, 1])
    expect(state.holdings.inventory).toHaveLength(2)
    expect(state.holdings.loot.nextRoll).toBe(2)
    const gold = steps.flatMap((s) => s.rolls).reduce((sum, r) => sum + (r.drop?.gold ?? 0), 0)
    expect(state.holdings.gold).toBe(gold)
  })

  it("records a roll that misses, so the number is never drawn twice", () => {
    const never = { ...starterRules, loot: { ...starterRules.loot, chancePerTurn: 0 } }
    const { state, steps } = play([client("turn.completed")], never)
    expect(steps[0]?.rolls).toEqual([expect.objectContaining({ number: 0, drop: null })])
    expect(state.holdings.loot.nextRoll).toBe(1)
    expect(state.holdings.inventory).toEqual([])
  })

  it("forces a rare once the pity timer runs out", () => {
    const due = fresh()
    const pitied = { ...due, holdings: { ...due.holdings, loot: { nextRoll: 0, pity: { sinceRare: 25, sinceEpic: 0 } } } }
    const commonOnly = { ...always, loot: { ...always.loot, weights: { common: 1, uncommon: 0, rare: 0, epic: 0, legendary: 0 } } }
    const { steps } = play([client("turn.completed")], commonOnly, pitied)
    expect(steps[0]?.rolls[0]?.drop?.rarity).toBe("rare")
  })
})

const graded = (scores: Record<GradeDimension, number>, minutes = 0): Input => {
  const input = client("prompt.graded", minutes)
  if (input.kind !== "client" || input.event.type !== "prompt.graded") throw new Error("not a graded prompt")
  return { kind: "client", event: { ...input.event, data: { ...input.event.data, scores } } }
}

/** The XP each graded prompt earned, in order. */
const promptXp = (events: ReadonlyArray<Step["events"][number]>): Array<number> =>
  events.flatMap((e) => (e.type === "xp.granted" && e.data.reason === "prompt.graded" ? [e.data.amount] : []))

describe("step: graded prompts", () => {
  it("earns the quality scores' average x 2, and starts the day's streak like any work", () => {
    const { state, events } = play([client("prompt.graded", 0, session, 10), client("prompt.graded", 1, session, 7)])
    expect(promptXp(events)).toEqual([20, 14])
    expect(state.progress.xp.reported).toBe(10 + 20 + 14)
    expect(state.progress.activeDays).toEqual(["2026-10-09"])
  })

  it("weighs the scores by the rules, and leaves regret out of the price", () => {
    const weights = { clarity: 3, grammar: 1, specificity: 0, instructive: 0, context: 0, doneCriteria: 0, focus: 0 }
    const rules = { ...starterRules, prompt: { ...starterRules.prompt, weights } }
    const scores = { ...flat(0), clarity: 10, grammar: 2, regret: 10 }
    // (3 * 10 + 1 * 2) / 4 = 8, x 2 = 16; the regret score changes nothing.
    expect(promptXp(play([graded(scores)], rules).events)).toEqual([16])
    expect(promptXp(play([graded({ ...scores, regret: 0 })], rules).events)).toEqual([16])
  })

  it("earns nothing for a zero grade, but still counts the prompt", () => {
    const { state, events } = play([client("prompt.graded", 0, session, 0)])
    expect(promptXp(events)).toEqual([])
    expect(statsOf(state, start).prompts).toEqual({ graded: 1, gradedToday: 1, averageScore: 0, regretted: 0 })
  })

  it("is full for the day's first 20 prompts, half for the next 20, a tenth after, and full again the next day", () => {
    const day = Array.from({ length: 45 }, (_, i) => client("prompt.graded", i))
    const { events } = play([...day, client("prompt.graded", 24 * 60)])
    expect(promptXp(events)).toEqual([...Array(20).fill(20), ...Array(20).fill(10), ...Array(5).fill(2), 20])
  })

  it("earns nothing past the last band when the rules close it", () => {
    const perDay = [{ upTo: 1, pct: 100 }]
    const rules = { ...starterRules, prompt: { ...starterRules.prompt, perDay } }
    expect(promptXp(play([client("prompt.graded"), client("prompt.graded", 1)], rules).events)).toEqual([20])
  })

  it("rolls loot, and a drop names its rarity as the celebration's tier", () => {
    const { state, steps } = play([client("prompt.graded")], always)
    expect(steps[0]?.rolls).toEqual([expect.objectContaining({ number: 0, trigger: "prompt", chance: 1 })])
    const dropped = steps[0]?.events.find((e) => e.type === "loot.dropped")
    if (dropped?.type !== "loot.dropped") throw new Error("expected a drop")
    expect(dropped.data.tier).toBe(dropped.data.item.rarity)
    expect(state.holdings.inventory).toHaveLength(1)
  })

  it("rolls at a chance in a line with the weighted grade: 0 at 0, 12% at 5, 24% at 10", () => {
    const chanceAt = (n: number) => play([client("prompt.graded", 0, session, n)]).steps[0]?.rolls[0]?.chance
    expect(chanceAt(0)).toBe(0)
    expect(chanceAt(5)).toBeCloseTo(0.12)
    expect(chanceAt(10)).toBeCloseTo(0.24)
    // The weights, not regret, make the grade the chance follows.
    expect(play([graded({ ...flat(10), regret: 0 })]).steps[0]?.rolls[0]?.chance).toBeCloseTo(0.24)
  })

  it("raises the rare-and-better weights for a prompt graded at least promptGreatAt", () => {
    const weights = { common: 999, uncommon: 0, rare: 1, epic: 0, legendary: 0 }
    const odds = (promptGreatAt: number): RulesConfig => ({
      ...always,
      loot: { ...always.loot, weights, promptGreatAt, promptGreatRareFactor: 1_000_000 },
    })
    const rarity = (rules: RulesConfig) =>
      play([client("prompt.graded", 0, session, 9)], rules).steps[0]?.rolls[0]?.drop?.rarity
    expect(rarity(odds(10))).toBe("common")
    expect(rarity(odds(9))).toBe("rare")
  })

  it("counts graded prompts, today's, the average grade and the regrets, and says so on the stream", () => {
    const { state, events } = play([graded({ ...flat(10), regret: 0 }), graded({ ...flat(5), regret: 3 }, 1)])
    expect(statsOf(state, start).prompts).toEqual({ graded: 2, gradedToday: 2, averageScore: 7.5, regretted: 1 })
    expect(statsOf(state, minutesLater(24 * 60)).prompts.gradedToday).toBe(0)
    expect(events.filter((e) => e.type === "stats.changed").at(-1)).toEqual({
      type: "stats.changed",
      data: { stats: { prompts: { graded: 2, gradedToday: 2, averageScore: 7.5, regretted: 1 } } },
    })
  })
})

describe("step: player stats", () => {
  const other = "01K6ZQ8W3J5V7XKQ2M4N6P8R9V"

  it("counts clears, compactions by trigger and commands by name, with no XP and no streak", () => {
    const inputs = [
      client("session.cleared"),
      client("session.compacted", 1, session, 0),
      client("session.compacted", 2, session, 1),
      client("session.compacted", 3, session, 1),
      client("command.used", 4, session, 0),
      client("command.used", 5, session, 0),
      client("command.used", 6, session, 1),
    ]
    const { state, events } = play(inputs)
    expect(totalXp(state)).toBe(0)
    expect(state.progress.activeDays).toEqual([])
    expect(events.every((e) => e.type === "stats.changed")).toBe(true)
    expect(statsOf(state, start)).toMatchObject({
      clears: 1,
      compactions: { manual: 1, auto: 2 },
      commands: { "/code-review": 2, "/plugin:deploy": 1 },
    })
  })

  it("sends only the stats an event changed", () => {
    const { events } = play([client("session.cleared"), client("command.used", 1, session, 0)])
    expect(events).toEqual([
      { type: "stats.changed", data: { stats: { clears: 1 } } },
      { type: "stats.changed", data: { stats: { commands: { "/code-review": 1 } } } },
    ])
  })

  it("counts each context fill a session crosses once, and keeps each session's peak", () => {
    const fills = (sessionId: string, ...tenths: Array<number>) =>
      tenths.map((n, i) => client("context.measured", i, sessionId, n))
    const first = play(fills(session, 3, 6, 5, 8, 10))
    expect(statsOf(first.state, start)).toMatchObject({
      contextCrossed: { pct50: 1, pct75: 1, pct100: 1 },
      contextPeak: { lastSession: 100, average: 100 },
    })
    // A fill below the session's peak changes nothing, so it sends nothing.
    expect(first.steps[2]?.events).toEqual([])
    const second = play(fills(other, 4, 8), starterRules, first.state)
    expect(statsOf(second.state, start)).toMatchObject({
      contextCrossed: { pct50: 2, pct75: 2, pct100: 1 },
      contextPeak: { lastSession: 80, average: 90 },
    })
  })

  it("counts a new command name as custom once the record holds the most names it keeps", () => {
    const state = fresh()
    const names = Array.from({ length: maxCommands - 1 }, (_, i): [string, number] => [`/c${i}`, 1])
    const commands = Object.fromEntries([...names, ["/plugin:deploy", 4]])
    const full = { ...state, progress: { ...state.progress, stats: { ...state.progress.stats, commands } } }
    const uses = [client("command.used", 0, session, 0), client("command.used", 1, session, 1)]
    const { state: after } = play(uses, starterRules, full)
    expect(after.progress.stats.commands["/code-review"]).toBeUndefined()
    expect(after.progress.stats.commands["custom"]).toBe(1)
    expect(after.progress.stats.commands["/plugin:deploy"]).toBe(5)
  })
})

describe("step: review fixes, prompts and stats", () => {
  it("never keeps more than maxCommands names, custom included", () => {
    const uses = Array.from({ length: maxCommands + 20 }, (_, i): Input => {
      const input = client("command.used", i)
      if (input.kind !== "client" || input.event.type !== "command.used") throw new Error("not a command use")
      return { kind: "client", event: { ...input.event, data: { command: `/c${i}` } } }
    })
    const { state } = play(uses)
    expect(Object.keys(state.progress.stats.commands)).toHaveLength(maxCommands)
    expect(state.progress.stats.commands["custom"]).toBe(21)
  })
})

describe("step: level-up loot", () => {
  it("drops one item on a level-up, always, by the level-up's own weights, and replays it", () => {
    const legendary = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 1 }
    const rules = { ...starterRules, loot: { ...starterRules.loot, onLevelUp: { weights: legendary } } }
    const inputs = [client("change.merged")]
    const { state, steps } = play(inputs, rules)
    expect(steps[0]?.rolls).toEqual([
      expect.objectContaining({
        number: 0,
        trigger: "levelUp",
        chance: 1,
        drop: expect.objectContaining({ rarity: "legendary" }),
      }),
    ])
    expect(steps[0]?.events.map((e) => e.type)).toEqual([
      "xp.granted",
      "streak.changed",
      "xp.granted",
      "level.up",
      "loot.dropped",
      "gold.changed",
    ])
    expect(state.holdings.inventory).toHaveLength(1)
    const recorded = steps.map((s) => ({ rolls: s.rolls, refusal: s.refusal }))
    expect(replay(inputs, recorded, rules).state).toEqual(state)
  })

  it("rolls nothing for a level already reached", () => {
    const state = fresh()
    const reached = { ...state, holdings: { ...state.holdings, peakLevel: 1 } }
    expect(play([client("change.merged")], starterRules, reached).steps[0]?.rolls).toEqual([])
  })
})

describe("step: celebration tiers", () => {
  it("stages a level-up as rare, and as epic when it brings a new title", () => {
    expect(play([client("change.merged")]).events.find((e) => e.type === "level.up")).toMatchObject({
      data: { to: 1, tier: "rare" },
    })
    const state = fresh()
    const nearTen = {
      ...state,
      progress: { ...state.progress, xp: { verified: 0, reported: xpForLevel(starterRules.levelCurve, 10) - 100 } },
      holdings: { ...state.holdings, peakLevel: 9 },
    }
    expect(play([client("change.merged")], starterRules, nearTen).events.find((e) => e.type === "level.up")).toEqual({
      type: "level.up",
      data: { from: 9, to: 10, tier: "epic", glyph: "🛡️", title: "Adept" },
    })
  })
})

describe("level glyphs", () => {
  const at = (level: number): PlayerState => {
    const state = fresh()
    const xp = { verified: 0, reported: xpForLevel(starterRules.levelCurve, level) }
    return { ...state, progress: { ...state.progress, xp }, holdings: { ...state.holdings, peakLevel: level } }
  }
  const player = { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
  const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }

  it("changes the icon before Lv every five levels, from the rules' bands", () => {
    const glyphs = [0, 4, 5, 9, 10, 14, 15, 19, 20, 60].map((level) => glyphFor(starterRules, level))
    expect(glyphs).toEqual(["⚔", "⚔", "🗡️", "🗡️", "🛡️", "🛡️", "👑", "👑", "🐉", "🐉"])
  })

  it("puts the character's glyph on the snapshot, under the rules in force", () => {
    const context = { rules: starterRules, catalog: starterCatalog, questPacks: [], now: start }
    expect(project(at(15), context, meta).character).toMatchObject({ level: 15, glyph: "👑" })
    const rules = { ...starterRules, glyphs: [{ fromLevel: 3, glyph: "✦" }, { fromLevel: 12, glyph: "★" }] }
    expect(project(at(0), { ...context, rules }, meta).character.glyph).toBe("✦")
    expect(project(at(12), { ...context, rules }, meta).character.glyph).toBe("★")
  })

  it("names the glyph reached on a level-up into a new band", () => {
    const nearFive = at(4)
    const xp = { verified: 0, reported: xpForLevel(starterRules.levelCurve, 5) - 100 }
    const { events } = play([client("change.merged")], starterRules, { ...nearFive, progress: { ...nearFive.progress, xp } })
    expect(events.find((e) => e.type === "level.up")).toMatchObject({ data: { from: 4, to: 5, glyph: "🗡️" } })
  })

  it("refuses glyph bands that don't rise, an empty glyph, and no bands at all", () => {
    const decode = Schema.decodeUnknownExit(RulesSchema)
    const glyphs = [{ fromLevel: 5, glyph: "🗡️" }, { fromLevel: 5, glyph: "🛡️" }]
    expect(decode({ ...starterRules, glyphs })._tag).toBe("Failure")
    expect(decode({ ...starterRules, glyphs: [{ fromLevel: 0, glyph: "" }] })._tag).toBe("Failure")
    expect(decode({ ...starterRules, glyphs: [] })._tag).toBe("Failure")
  })
})

describe("step: pet", () => {
  const hatch: Input = { kind: "command", command: { id: nextId(), type: "pet.hatch", data: { species: "fox", name: "Ember" } } }

  it("keeps the egg until level 1, hatches once, then refuses", () => {
    expect(play([hatch]).steps[0]?.refusal?.code).toBe("not_allowed")
    const { state, steps } = play([client("change.merged"), hatch, hatch])
    expect(steps[1]?.events).toEqual([
      { type: "pet.hatched", data: { species: "fox", name: "Ember", form: 0, mood: 100, equipped: {} } },
    ])
    expect(steps[2]?.refusal?.code).toBe("not_allowed")
    expect(state.holdings.pet?.name).toBe("Ember")
  })
})

describe("step: review fixes", () => {
  it("replays a hatch the live run accepted, even when a rebalance moved the level below 1", () => {
    const data = { species: "owl", name: "Hoot" }
    const hatch: Input = { kind: "command", command: { id: nextId(), type: "pet.hatch", data } }
    const steep = { ...starterRules, levelCurve: { base: 10_000, exponent: 1.6 } }
    const replayed = step(fresh(), hatch, context(1, start, steep, { kind: "replay", recorded: { rolls: [], refusal: null } }))
    expect(replayed.refusal).toBeNull()
    expect(replayed.state.holdings.pet?.name).toBe("Hoot")
  })

  it("ends a boost by instant, not by comparing timestamps as text", () => {
    const state = fresh()
    // 10:00+02:00 is 08:00Z: over by 09:00Z, though the text sorts after it.
    const boost = { source: "trail-mix", xpBoostPct: 10, endsAt: "2026-10-09T10:00:00+02:00" }
    const boosted = { ...state, progress: { ...state.progress, boosts: [boost] } }
    const merged = client("change.merged", 60)
    const result = step(boosted, merged, context(1, minutesLater(60)))
    expect(result.state.progress.xp.reported).toBe(10 + 250)
    const player = { id: session, githubUserId: null, githubLogin: null, displayName: "P", createdAt: start }
    const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
    const projected = project(result.state, { rules: starterRules, catalog: starterCatalog, questPacks: [], now: minutesLater(60) }, meta)
    expect(projected.boosts).toEqual([])
  })

  it("keeps forms an evolution stone unlocked when the pet evolves by level", () => {
    const state = fresh()
    const pet = { species: "fox", name: "Ember", hatchedAt: start, forms: [0, 3], form: 3, mood: { value: 100, at: start } }
    const nearTen = {
      ...state,
      progress: { ...state.progress, xp: { verified: 0, reported: xpForLevel(starterRules.levelCurve, 10) - 100 } },
      holdings: { ...state.holdings, peakLevel: 9, pet },
    }
    const { state: after } = play([client("change.merged")], starterRules, nearTen)
    expect(after.holdings.pet?.forms).toEqual([0, 1, 3])
    expect(after.holdings.pet?.form).toBe(1)
  })

  it("counts an event clocked just past midnight on the day the server received it", () => {
    const now = "2026-10-09T23:58:00Z"
    const event = { id: nextId(), occurredAt: "2026-10-10T00:02:00Z", sessionId: session, data: { repo } }
    const early: Input = { kind: "client", event: { ...event, type: "repo.explored" } }
    const result = step(fresh(), early, context(1, now))
    expect(result.state.progress.activeDays).toEqual(["2026-10-09"])
  })
})

describe("step: review fixes, graded prompt loot", () => {
  const weightsOf = (values: ReadonlyArray<number>) => {
    const [clarity = 0, grammar = 0, specificity = 0, instructive = 0, context = 0, doneCriteria = 0, focus = 0] = values
    return { clarity, grammar, specificity, instructive, context, doneCriteria, focus }
  }

  it("never rolls a perfect grade at a chance past 1, whatever float error the weights carry", () => {
    const weights = weightsOf([7.85, 1.58, 3.05, 0.7, 4.64, 3.45, 7.6])
    const rules = { ...always, prompt: { ...always.prompt, weights } }
    const { steps } = play([client("prompt.graded", 0, session, 10)], rules)
    expect(steps[0]?.rolls[0]?.chance).toBe(1)
    for (const s of steps) expect(Schema.decodeUnknownExit(StepSchema)(s)._tag).toBe("Success")
  })

  it("gives a grade of exactly promptGreatAt the raised weights, whatever float error the weights carry", () => {
    const weights = weightsOf([4.92, 5.56, 5.83, 2.92, 7.44, 4.31, 4.48])
    const loot = { ...always.loot, weights: { common: 999, uncommon: 0, rare: 1, epic: 0, legendary: 0 }, promptGreatRareFactor: 1_000_000 }
    const rules = { ...always, loot, prompt: { ...always.prompt, weights } }
    expect(play([client("prompt.graded", 0, session, 9)], rules).steps[0]?.rolls[0]?.drop?.rarity).toBe("rare")
  })
})

describe("step: review fixes, stats averages", () => {
  it("rounds the average grade and context peak to the thousandth, so float error never shows", () => {
    const none = { ...flat(0), regret: 0 }
    const { state } = play([
      graded({ ...none, clarity: 1 }),
      graded({ ...none, clarity: 10, grammar: 5 }, 1),
      client("context.measured", 2, session, 0),
    ])
    // 0.143 and 2.143 average to 1.1429999999999998 in floats.
    expect(statsOf(state, start).prompts.averageScore).toBe(1.143)
    const measured = (pct: number, sessionId: string): Input => {
      const input = client("context.measured", 3, sessionId)
      if (input.kind !== "client" || input.event.type !== "context.measured") throw new Error("not a measurement")
      return { kind: "client", event: { ...input.event, data: { pct } } }
    }
    const peaks = play([measured(0.1, session), measured(0.2, "01K6ZQ8W3J5V7XKQ2M4N6P8R9V")]).state
    // 0.1 + 0.2 over two sessions is 0.15000000000000002 in floats.
    expect(statsOf(peaks, start).contextPeak.average).toBe(0.15)
  })
})

describe("step: equipping", () => {
  const entryId = "01K6ZQ8W3J0000000000009001"
  const otherId = "01K6ZQ8W3J0000000000009002"
  const owning = (...items: ReadonlyArray<readonly [string, string]>): PlayerState => {
    const state = fresh()
    const source: InventoryEntry["source"] = { kind: "drop", ref: "0" }
    const inventory = items.map(([id, itemId]): InventoryEntry => ({ id, itemId, acquiredAt: start, source, dye: null }))
    return { ...state, holdings: { ...state.holdings, inventory } }
  }
  const command = (command: Command): Input => ({ kind: "command", command })
  const equip = (id: string, slot: Slot): Input => command({ id: nextId(), type: "item.equip", data: { entryId: id, slot } })
  const unequip = (slot: Slot): Input => command({ id: nextId(), type: "item.unequip", data: { slot } })
  const player = { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
  const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
  const snapshotOf = (state: PlayerState) =>
    project(state, { rules: starterRules, catalog: starterCatalog, questPacks: [], now: start }, meta)

  it("puts an owned band style in its slot, the snapshot carrying it and its look, and empties it again", () => {
    const owned = owning([entryId, "arcane-current"], [otherId, "tempered-steel"])
    const { state, steps } = play([equip(entryId, "xpBar"), equip(otherId, "xpBar"), unequip("xpBar")], starterRules, owned)
    expect(steps.map((s) => s.refusal)).toEqual([null, null, null])
    expect(steps.flatMap((s) => s.events)).toEqual([
      { type: "item.equipped", data: { slot: "xpBar", entryId } },
      { type: "item.equipped", data: { slot: "xpBar", entryId: otherId } },
      { type: "item.unequipped", data: { slot: "xpBar" } },
    ])
    expect(state.holdings.equipped).toEqual({})
    const worn = snapshotOf(play([equip(entryId, "xpBar")], starterRules, owned).state)
    expect(worn.character.equipped).toEqual({ xpBar: entryId })
    expect(worn.items.map((item) => item.id)).toEqual(["tempered-steel", "arcane-current"])
    expect(worn.items.find((item) => item.id === "arcane-current")?.look?.fps).toBe(6)
  })

  it("refuses an item not owned, the wrong slot, a pet slot before the hatch, and an empty slot", () => {
    const owned = owning([entryId, "solid-bar"], [otherId, "wizard-hat"])
    const refusals = play(
      [equip("01K6ZQ8W3J0000000000009999", "xpBar"), equip(entryId, "topEdge"), equip(otherId, "head"), unequip("goldDisplay")],
      starterRules,
      owned,
    ).steps.map((s) => s.refusal?.code)
    expect(refusals).toEqual(["not_owned", "invalid", "not_allowed", "invalid"])
    const pet = { species: "fox", name: "Ember", hatchedAt: start, forms: [0], form: 0, mood: { value: 100, at: start } }
    const hatched = { ...owned, holdings: { ...owned.holdings, pet } }
    const { state } = play([equip(otherId, "head")], starterRules, hatched)
    expect(snapshotOf(state).pet?.equipped).toEqual({ head: otherId })
    expect(snapshotOf(state).character.equipped).toEqual({})
  })

  it("refuses an item the catalogue no longer has, but a replay applies what the live run accepted", () => {
    const owned = owning([entryId, "retired-style"])
    expect(play([equip(entryId, "xpBar")], starterRules, owned).steps[0]?.refusal?.code).toBe("invalid")
    const replayed = step(owned, equip(entryId, "xpBar"), context(1, start, starterRules, { kind: "replay", recorded: { rolls: [], refusal: null } }))
    expect(replayed.state.holdings.equipped).toEqual({ xpBar: entryId })
  })
})

describe("starter catalogue", () => {
  it("passes the item schema, with band styles at every rarity: still up to rare, looping from epic", () => {
    const decode = Schema.decodeUnknownSync(ItemDef)
    for (const item of starterCatalog) expect(decode(item)).toEqual(item)
    const styles = starterCatalog.filter((item) => item.category === "bandStyle")
    const rarities = ["common", "uncommon", "rare", "epic", "legendary"]
    expect(new Set(styles.map((item) => item.rarity))).toEqual(new Set(rarities))
    for (const item of styles) {
      const loops = item.look?.frames !== null
      expect(loops).toBe(item.rarity === "epic" || item.rarity === "legendary")
    }
    expect(new Set(styles.map((item) => item.slot))).toEqual(new Set(["xpBar", "levelDisplay", "topEdge", "goldDisplay"]))
  })
})

describe("starter rules", () => {
  it("pass the rules schema, which prices a graded prompt only in its prompt section", () => {
    const decode = Schema.decodeUnknownSync(RulesSchema)
    expect(decode(starterRules)).toEqual(starterRules)
    const xp = { ...starterRules.xp, "prompt.graded": { xp: 20, tier: "reported", dailyCap: null } }
    expect(decode({ ...starterRules, xp }).xp).toEqual(starterRules.xp)
    const loot = { ...starterRules.loot, promptGreatAt: 11 }
    expect(Schema.decodeUnknownExit(RulesSchema)({ ...starterRules, loot })._tag).toBe("Failure")
  })
})

describe("step: purity", () => {
  it("returns output the Step schema accepts", () => {
    const inputs = [
      client("commit.made"),
      client("turn.completed", 1),
      client("change.merged", 2),
      client("prompt.graded", 3),
      client("context.measured", 4),
      client("command.used", 5),
    ]
    const { steps } = play(inputs, always)
    for (const s of steps) expect(Schema.decodeUnknownExit(StepSchema)(s)._tag).toBe("Success")
  })

  it("gives the same result for the same input, and leaves the old state untouched", () => {
    const state = fresh()
    const input = client("turn.completed")
    const before = structuredClone(state)
    expect(step(state, input, context(1, start, always))).toEqual(step(state, input, context(1, start, always)))
    expect(state).toEqual(before)
  })
})

// A generated session: each entry is an event kind, minutes after the previous one, which of two sessions, and `n`
// for the event's data (a prompt's scores, a context fill).
const Kind = Schema.Literals([
  "turn.completed",
  "commit.made",
  "change.opened",
  "change.merged",
  "tests.failed",
  "tests.passed",
  "repo.explored",
  "prompt.graded",
  "session.cleared",
  "session.compacted",
  "command.used",
  "context.measured",
])
const Script = Schema.Array(
  Schema.Struct({
    kind: Kind,
    gap: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
    second: Schema.Boolean,
    n: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  }),
).check(Schema.isMaxLength(60))

const toInputs = (script: typeof Script.Type): Array<Input> => {
  let minutes = 0
  return script.map(({ kind, gap, second, n }) => {
    minutes += gap
    return client(kind, minutes, second ? "01K6ZQ8W3J5V7XKQ2M4N6P8R9V" : session, n)
  })
}

const loot = { ...starterRules, loot: { ...starterRules.loot, chancePerTurn: 0.5 } }

describe("step: properties", () => {
  prop.prop("a replay of the log reproduces the live run", [Script], ([script]) => {
    const inputs = toInputs(script)
    const live = play(inputs, loot)
    const recorded = live.steps.map((s) => ({ rolls: s.rolls, refusal: s.refusal }))
    const again = replay(inputs, recorded, loot)
    expect(again.state).toEqual(live.state)
    expect(again.events).toEqual(live.events)
  })

  prop.prop("XP, gold and pity never go negative, and XP never goes down", [Script], ([script]) => {
    let previous = 0
    let state = fresh()
    for (const [i, input] of toInputs(script).entries()) {
      state = step(state, input, context(i + 1, nowOf(input), loot)).state
      expect(totalXp(state)).toBeGreaterThanOrEqual(previous)
      previous = totalXp(state)
    }
    expect(state.holdings.gold).toBeGreaterThanOrEqual(0)
    expect(state.holdings.loot.pity.sinceRare).toBeGreaterThanOrEqual(0)
  })

  prop.prop("a graded prompt earns at most its day's band of maxXp", [Script], ([script]) => {
    const inputs = toInputs(script)
    const perDay = new Map<string, number>()
    for (const [i, s] of play(inputs, loot).steps.entries()) {
      const input = inputs[i]
      if (input?.kind !== "client" || input.event.type !== "prompt.graded") continue
      const day = input.event.occurredAt.slice(0, 10)
      const nth = (perDay.get(day) ?? 0) + 1
      perDay.set(day, nth)
      const cap = nth <= 20 ? 20 : nth <= 40 ? 10 : 2
      for (const amount of promptXp(s.events)) expect(amount).toBeLessThanOrEqual(cap)
    }
  })

  const statKinds: ReadonlyArray<ClientEvent["type"]> = ["session.cleared", "session.compacted", "command.used", "context.measured"]

  prop.prop("stats events earn nothing, counters only grow, and context fills nest", [Script], ([script]) => {
    let state = fresh()
    for (const [i, input] of toInputs(script).entries()) {
      const before = statsOf(state, nowOf(input))
      const result = step(state, input, context(i + 1, nowOf(input), loot))
      const after = statsOf(result.state, nowOf(input))
      if (input.kind === "client" && statKinds.includes(input.event.type)) expect(totalXp(result.state)).toBe(totalXp(state))
      expect(after.clears).toBeGreaterThanOrEqual(before.clears)
      expect(after.prompts.graded).toBeGreaterThanOrEqual(before.prompts.graded)
      expect(after.contextCrossed.pct50).toBeGreaterThanOrEqual(before.contextCrossed.pct50)
      const { pct50, pct75, pct100 } = after.contextCrossed
      expect(pct100 <= pct75 && pct75 <= pct50 && pct50 <= result.state.progress.stats.context.sessions).toBe(true)
      expect(after.contextPeak.average).toBeGreaterThanOrEqual(0)
      expect(after.contextPeak.average).toBeLessThanOrEqual(100)
      state = result.state
    }
  })
})
