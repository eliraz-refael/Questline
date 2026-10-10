import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ClientEvent,
  clientEventTypes,
  CommandResponse,
  GitHubRepo,
  LevelCurve,
  PromptRules,
  ServerEvent,
  Snapshot,
} from "../src/index.ts"

const ulid = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const key = "ab".repeat(32)
const repoKey = "cd".repeat(32)
const at = "2026-10-08T12:00:00Z"
const decodeEvent = Schema.decodeUnknownExit(ClientEvent)

describe("ClientEvent", () => {
  const merged = {
    id: ulid,
    type: "change.merged",
    occurredAt: at,
    sessionId: ulid,
    data: { change: { type: "github", repo: "acme/widgets", number: 212, key } },
  }

  it("decodes each event type by its `type`", () => {
    expect(Schema.decodeUnknownSync(ClientEvent)(merged)).toEqual(merged)
  })

  it("lists every accepted type for the session response", () => {
    expect(clientEventTypes).toContain("turn.completed")
    expect(clientEventTypes).toHaveLength(14)
  })

  it("refuses an unknown type, a bad id and a local path in place of a repo", () => {
    expect(decodeEvent({ ...merged, type: "file.read" })._tag).toBe("Failure")
    expect(decodeEvent({ ...merged, id: "not-a-ulid" })._tag).toBe("Failure")
    const local = { type: "github", repo: "/Users/someone/code", number: 1, key }
    expect(decodeEvent({ ...merged, data: { change: local } })._tag).toBe("Failure")
  })

  it("accepts a test run outside git, and one on a detached HEAD before any branch or commit", () => {
    const outside = { ...merged, type: "tests.failed", data: { checkout: null, runner: "vitest" } }
    expect(decodeEvent(outside)._tag).toBe("Success")
    const detached = { type: "github", repo: "acme/widgets", branch: null, headSha: null, key }
    expect(decodeEvent({ ...outside, data: { checkout: detached, runner: "vitest" } })._tag).toBe("Success")
  })

  it("accepts SHA-256 commits as well as SHA-1", () => {
    const commit = { type: "github", repo: "acme/widgets", sha: "a".repeat(64), key }
    expect(decodeEvent({ ...merged, type: "commit.made", data: { commit } })._tag).toBe("Success")
  })

  it("allows a null repo only where the event can happen outside a repo", () => {
    const explored = { ...merged, type: "repo.explored", data: { repo: null } }
    expect(decodeEvent(explored)._tag).toBe("Success")
    expect(decodeEvent({ ...merged, data: { change: null } })._tag).toBe("Failure")
  })

  it("carries private work as opaque keys, with no room for a name, number or branch", () => {
    const hidden = { type: "private", repo: repoKey, key }
    expect(Schema.decodeUnknownSync(ClientEvent)({ ...merged, data: { change: hidden } })).toEqual({
      ...merged,
      data: { change: hidden },
    })
    const leaky = Schema.decodeUnknownSync(ClientEvent)({ ...merged, data: { change: { ...hidden, number: 4 } } })
    expect(leaky.data).toEqual({ change: hidden })
    expect(decodeEvent({ ...merged, data: { change: { ...hidden, repo: "acme/secret" } } })._tag).toBe("Failure")
  })

  it("puts the private key on public work too, so work sent in both forms can be matched", () => {
    const { key: _key, ...unkeyed } = merged.data.change
    expect(decodeEvent({ ...merged, data: { change: unkeyed } })._tag).toBe("Failure")
  })

  it("groups private test runs by repo even when branch and head differ", () => {
    const checkout = { type: "private", repo: repoKey, key }
    const failed = { ...merged, type: "tests.failed", data: { checkout, runner: "vitest" } }
    expect(decodeEvent(failed)._tag).toBe("Success")
    const unkeyedRepo = { ...failed, data: { checkout: { type: "private", key }, runner: "vitest" } }
    expect(decodeEvent(unkeyedRepo)._tag).toBe("Failure")
  })
})

describe("ClientEvent: prompts and stats", () => {
  const base = { id: ulid, occurredAt: at, sessionId: ulid }
  const scores = { clarity: 8, grammar: 9, specificity: 6, instructive: 7, context: 5, doneCriteria: 4, focus: 10, regret: 0 }
  const prompt = { ...base, type: "prompt.graded", data: { scores, rubricVersion: 1, words: 14, grader: "haiku" } }

  it("decodes a graded prompt: scores, rubric version, word count and grader, never the text", () => {
    expect(Schema.decodeUnknownSync(ClientEvent)(prompt)).toEqual(prompt)
    const leaky = Schema.decodeUnknownSync(ClientEvent)({ ...prompt, data: { ...prompt.data, text: "fix the bug" } })
    expect(leaky.data).toEqual(prompt.data)
  })

  it("holds scores to whole numbers 0-10, every dimension present", () => {
    const withScores = (changed: object) => ({ ...prompt, data: { ...prompt.data, scores: { ...scores, ...changed } } })
    expect(decodeEvent(withScores({ clarity: 11 }))._tag).toBe("Failure")
    expect(decodeEvent(withScores({ clarity: 7.5 }))._tag).toBe("Failure")
    const { regret: _regret, ...noRegret } = scores
    expect(decodeEvent({ ...prompt, data: { ...prompt.data, scores: noRegret } })._tag).toBe("Failure")
  })

  it("decodes the stats events", () => {
    const events = [
      { ...base, type: "session.cleared", data: {} },
      { ...base, type: "session.compacted", data: { trigger: "auto" } },
      { ...base, type: "command.used", data: { command: "/code-review" } },
      { ...base, type: "command.used", data: { command: "/plugin:deploy" } },
      { ...base, type: "command.used", data: { command: "custom" } },
      { ...base, type: "context.measured", data: { pct: 62.5 } },
    ]
    for (const event of events) expect(Schema.decodeUnknownSync(ClientEvent)(event)).toEqual(event)
  })

  it("takes a command's name only, never its arguments, and a context fill only within 0-100", () => {
    const used = (command: string) => ({ ...base, type: "command.used", data: { command } })
    expect(["/review 212", "code-review", "/", "/a b", "/../x"].map((name) => decodeEvent(used(name))._tag)).toEqual(
      Array(5).fill("Failure"),
    )
    expect(decodeEvent({ ...base, type: "context.measured", data: { pct: 101 } })._tag).toBe("Failure")
    expect(decodeEvent({ ...base, type: "session.compacted", data: { trigger: "sometimes" } })._tag).toBe("Failure")
  })
})

describe("PromptRules", () => {
  const rules = {
    rubricVersion: 1,
    weights: { clarity: 1, grammar: 1, specificity: 1, instructive: 1, context: 1, doneCriteria: 1, focus: 1 },
    maxXp: 20,
    perDay: [
      { upTo: 20, pct: 100 },
      { upTo: 40, pct: 50 },
      { upTo: null, pct: 10 },
    ],
  }
  const valid = Schema.is(PromptRules)

  it("accepts the starter's bands and weights", () => {
    expect(valid(rules)).toBe(true)
    expect(valid({ ...rules, perDay: [{ upTo: 5, pct: 100 }] })).toBe(true)
  })

  it("refuses weights that count no score, and a weight for regret, which only the stats count", () => {
    const none = { clarity: 0, grammar: 0, specificity: 0, instructive: 0, context: 0, doneCriteria: 0, focus: 0 }
    expect(valid({ ...rules, weights: none })).toBe(false)
    expect(valid({ ...rules, weights: { ...rules.weights, clarity: -1 } })).toBe(false)
    const decoded = Schema.decodeUnknownSync(PromptRules)({ ...rules, weights: { ...rules.weights, regret: 5 } })
    expect(decoded.weights).toEqual(rules.weights)
  })

  it("refuses bands that don't rise, or an open band before the last", () => {
    expect(valid({ ...rules, perDay: [{ upTo: 40, pct: 50 }, { upTo: 20, pct: 100 }] })).toBe(false)
    expect(valid({ ...rules, perDay: [{ upTo: null, pct: 10 }, { upTo: 20, pct: 100 }] })).toBe(false)
  })
})

describe("GitHubRepo", () => {
  it("accepts GitHub slugs and refuses path-like strings", () => {
    const valid = Schema.is(GitHubRepo)
    expect(["acme/widgets", "a-b/c.d_e", "x/.github"].map(valid)).toEqual([true, true, true])
    expect(["~/code", "../secret", "acme/..", "C:\\Users\\bob/proj", "a/b/c", "acme/"].map(valid)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe("LevelCurve", () => {
  it("refuses a flat or falling curve, which no level could climb", () => {
    const valid = Schema.is(LevelCurve)
    expect(valid({ base: 100, exponent: 1.6 })).toBe(true)
    expect([{ base: 0, exponent: 1.6 }, { base: 100, exponent: 0 }, { base: -100, exponent: 1.6 }].map(valid)).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe("ServerEvent", () => {
  it("keeps the pet's bounds on pet.changed", () => {
    const changed = (data: object) => ({ seq: 8, at, type: "pet.changed", cause: null, data })
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ mood: 60, form: 2 }))._tag).toBe("Success")
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ mood: 140 }))._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ form: 9 }))._tag).toBe("Failure")
  })

  it("decodes a level-up with its optional fields left out", () => {
    const event = { seq: 7, at, type: "level.up", cause: ulid, data: { from: 4, to: 5, tier: "rare", glyph: "🗡️" } }
    expect(Schema.decodeUnknownSync(ServerEvent)(event)).toEqual(event)
  })

  it("names the celebration's tier on a level-up", () => {
    const event = { seq: 7, at, type: "level.up", cause: ulid, data: { from: 4, to: 5, glyph: "🗡️" } }
    expect(Schema.decodeUnknownExit(ServerEvent)(event)._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(ServerEvent)({ ...event, data: { ...event.data, tier: "huge" } })._tag).toBe("Failure")
  })

  it("names the level's glyph on a level-up, one to eight characters", () => {
    const event = { seq: 7, at, type: "level.up", cause: ulid, data: { from: 4, to: 5, tier: "rare" } }
    expect(Schema.decodeUnknownExit(ServerEvent)(event)._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(ServerEvent)({ ...event, data: { ...event.data, glyph: "" } })._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(ServerEvent)({ ...event, data: { ...event.data, glyph: "🗡️" } })._tag).toBe("Success")
  })

  it("carries only the stats that changed on stats.changed", () => {
    const changed = (stats: object) => ({ seq: 9, at, type: "stats.changed", cause: ulid, data: { stats } })
    const one = changed({ clears: 3 })
    expect(Schema.decodeUnknownSync(ServerEvent)(one)).toEqual(one)
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ contextPeak: { lastSession: 140, average: 50 } }))._tag).toBe(
      "Failure",
    )
  })
})

describe("CommandResponse", () => {
  it("carries a refusal code", () => {
    const refused = { status: "refused", code: "insufficient_gold", message: "Needs 40 more gold" }
    expect(Schema.decodeUnknownSync(CommandResponse)(refused)).toEqual(refused)
  })
})

describe("Snapshot", () => {
  const snapshot = {
    serverId: "local",
    streamEpoch: 1,
    player: { id: ulid, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: at },
    character: {
      playerId: ulid,
      name: "Player",
      level: 0,
      xp: { total: 0, verified: 0, reported: 0, intoLevel: 0, forNextLevel: 100 },
      title: "Apprentice",
      glyph: "⚔",
      prestige: 0,
      gold: 0,
      shards: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
      streak: { days: 0, restDaysLeftThisWeek: 1, lastDay: "2026-10-08" },
      equipped: {},
    },
    pet: null,
    inventory: [],
    quests: [],
    claims: [],
    shop: [],
    boosts: [],
    pity: { sinceRare: 0, sinceEpic: 0 },
    achievements: [],
    stats: {
      clears: 0,
      compactions: { manual: 0, auto: 0 },
      commands: {},
      contextCrossed: { pct50: 0, pct75: 0, pct100: 0 },
      contextPeak: { lastSession: 0, average: 0 },
      prompts: { graded: 0, gradedToday: 0, averageScore: 0, regretted: 0 },
    },
    cursor: 0,
  }

  it("decodes a fresh level-0 player with no pet", () => {
    expect(Schema.decodeUnknownSync(Snapshot)(snapshot)).toEqual(snapshot)
  })

  it("holds names to the same 1-32 characters the commands and state allow", () => {
    expect(Schema.decodeUnknownExit(Snapshot)({ ...snapshot, character: { ...snapshot.character, name: "" } })._tag).toBe(
      "Failure",
    )
  })
})
