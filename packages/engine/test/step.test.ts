import { it as prop } from "@effect/vitest"
import type { ClientEvent, Context, Input, PlayerState, Recorded, RulesConfig, Step } from "@questline/schema"
import { Step as StepSchema } from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { initialState, levelOf, project, starterCatalog, starterRules, step, totalXp, xpForLevel } from "../src/index.ts"

const start = "2026-10-09T08:00:00Z"
const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const repo: { type: "github"; repo: string; key: string } = { type: "github", repo: "acme/widgets", key: "ab".repeat(32) }

const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
/** ULIDs in order: the time part fixed, the counter in the random part. */
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

const client = (type: ClientEvent["type"], minutes = 0, sessionId = session): Input => {
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

const always: RulesConfig = { ...starterRules, loot: { ...starterRules.loot, chancePerTurn: 1 } }

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
    expect(events.filter((e) => e.type === "level.up")).toEqual([{ type: "level.up", data: { from: 0, to: 1 } }])
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
    expect(project(result.state, { rules: starterRules, questPacks: [], now: minutesLater(60) }, meta).boosts).toEqual([])
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

describe("step: purity", () => {
  it("returns output the Step schema accepts", () => {
    const { steps } = play([client("commit.made"), client("turn.completed", 1), client("change.merged", 2)], always)
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

// A generated session: each entry is an event kind, minutes after the previous one, and which of two sessions.
const kinds = [
  "turn.completed",
  "commit.made",
  "change.opened",
  "change.merged",
  "tests.failed",
  "tests.passed",
  "repo.explored",
] as const
const Script = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals(kinds),
    gap: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
    second: Schema.Boolean,
  }),
).check(Schema.isMaxLength(60))

const toInputs = (script: typeof Script.Type): Array<Input> => {
  let minutes = 0
  return script.map(({ kind, gap, second }) => {
    minutes += gap
    return client(kind, minutes, second ? "01K6ZQ8W3J5V7XKQ2M4N6P8R9V" : session)
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
})
