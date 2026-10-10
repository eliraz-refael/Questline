import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Command, Context, PlayerState, RollRecord, RulesConfig, ServerEvent, ServerEventDraft, Step } from "../src/index.ts"

const ulid = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const at = "2026-10-08T12:00:00Z"
const shards = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 }

const fresh = {
  characterName: "Player",
  timezone: "Europe/Berlin",
  progress: {
    xp: { verified: 0, reported: 0 },
    totals: {},
    prestige: 0,
    prestigeXp: 0,
    tallies: [],
    activeDays: [],
    quests: [],
    boosts: [],
    tests: { armed: [] },
    claims: [],
    stats: {
      clears: 0,
      compactions: { manual: 0, auto: 0 },
      commands: {},
      context: { crossed: { pct50: 0, pct75: 0, pct100: 0 }, sessions: 0, peakSum: 0, recent: [] },
      prompts: { graded: 0, scoreSum: 0, regretted: 0 },
    },
  },
  holdings: {
    gold: 0,
    shards,
    inventory: [],
    equipped: {},
    pet: null,
    peakLevel: 0,
    achievements: [],
    completedQuests: [],
    loot: { nextRoll: 0, pity: { sinceRare: 0, sinceEpic: 0 } },
    shop: { day: "2026-10-08", bought: {} },
  },
}

const decodeState = Schema.decodeUnknownExit(PlayerState)

describe("PlayerState", () => {
  it("decodes a fresh level-0 player", () => {
    expect(Schema.decodeUnknownSync(PlayerState)(fresh)).toEqual(fresh)
  })

  it("decodes a player mid-game: a hatched pet in gear, a day's tallies, a pending claim", () => {
    const playing = {
      ...fresh,
      progress: {
        ...fresh.progress,
        xp: { verified: 250, reported: 43 },
        totals: { "commit.made": 31, "change.merged": 2 },
        tallies: [{ day: "2026-10-08", counts: { "commit.made": 4, "change.merged": 1 } }],
        activeDays: ["2026-10-07", "2026-10-08"],
        tests: { armed: [{ sessionId: ulid, checkout: { type: "private", repo: "cd".repeat(32), key: "ab".repeat(32) } }] },
        claims: [
          {
            claimId: ulid,
            kind: "change.merged",
            work: { type: "github", repo: "acme/widgets", number: 212 },
            status: "pending",
            openedAt: at,
            expiresAt: "2026-11-07T12:00:00Z",
          },
        ],
      },
      holdings: {
        ...fresh.holdings,
        gold: 35,
        inventory: [{ id: ulid, itemId: "plain-cap", acquiredAt: at, source: { kind: "drop", ref: "0" }, dye: null }],
        equipped: { head: ulid },
        pet: { species: "fox", name: "Ember", hatchedAt: at, forms: [0], form: 0, mood: { value: 80, at } },
        peakLevel: 2,
      },
    }
    expect(Schema.decodeUnknownSync(PlayerState)(playing)).toEqual(playing)
  })

  it("drops a tally key the rules don't score", () => {
    const progress = { ...fresh.progress, tallies: [{ day: "2026-10-08", counts: { "file.read": 1, "commit.made": 2 } }] }
    const decoded = Schema.decodeUnknownSync(PlayerState)({ ...fresh, progress })
    expect(decoded.progress.tallies[0]?.counts).toEqual({ "commit.made": 2 })
  })

  it("refuses a pet showing a form it hasn't unlocked", () => {
    const pet = { species: "fox", name: "Ember", hatchedAt: at, forms: [0, 1], form: 3, mood: { value: 80, at } }
    expect(decodeState({ ...fresh, holdings: { ...fresh.holdings, pet } })._tag).toBe("Failure")
    expect(decodeState({ ...fresh, holdings: { ...fresh.holdings, pet: { ...pet, forms: [] } } })._tag).toBe("Failure")
  })

  it("refuses a negative tally and a pet mood out of bounds", () => {
    const tally = { ...fresh.progress, tallies: [{ day: "2026-10-08", counts: { "commit.made": -1 } }] }
    expect(decodeState({ ...fresh, progress: tally })._tag).toBe("Failure")
    const pet = { species: "fox", name: "Ember", hatchedAt: at, forms: [0], form: 0, mood: { value: 140, at } }
    expect(decodeState({ ...fresh, holdings: { ...fresh.holdings, pet } })._tag).toBe("Failure")
  })
})

describe("StatCounters", () => {
  it("keeps each recent session's context peak, within 0-100", () => {
    const context = { ...fresh.progress.stats.context, sessions: 1, peakSum: 80, recent: [{ sessionId: ulid, peak: 80 }] }
    const measured = { ...fresh, progress: { ...fresh.progress, stats: { ...fresh.progress.stats, context } } }
    expect(decodeState(measured)._tag).toBe("Success")
    const over = { ...context, recent: [{ sessionId: ulid, peak: 120 }] }
    const overfull = { ...fresh, progress: { ...fresh.progress, stats: { ...fresh.progress.stats, context: over } } }
    expect(decodeState(overfull)._tag).toBe("Failure")
  })
})

describe("ServerEventDraft", () => {
  const draft = { type: "xp.granted", data: { amount: 120, tier: "verified", reason: "change.merged", totalAfter: 120 } }

  it("is the event without its envelope, which the write path adds", () => {
    expect(Schema.decodeUnknownSync(ServerEventDraft)(draft)).toEqual(draft)
    expect(Schema.decodeUnknownExit(ServerEvent)(draft)._tag).toBe("Failure")
    const event = { ...draft, seq: 1, at, cause: ulid }
    expect(Schema.decodeUnknownSync(ServerEvent)(event)).toEqual(event)
  })
})

describe("Claim", () => {
  it("only waits on named GitHub work: private work never opens one", () => {
    const work = { type: "private", key: "ab".repeat(32) }
    const claim = { claimId: ulid, kind: "change.merged", work, status: "pending", openedAt: at, expiresAt: at }
    expect(decodeState({ ...fresh, progress: { ...fresh.progress, claims: [claim] } })._tag).toBe("Failure")
  })
})

describe("Step", () => {
  it("decodes a refused command: the state as it was and nothing else", () => {
    const refused = {
      state: fresh,
      rolls: [],
      refusal: { code: "insufficient_gold", message: "Needs 40 more gold" },
      events: [],
      claims: [],
    }
    expect(Schema.decodeUnknownSync(Step)(refused)).toEqual(refused)
  })
})

describe("Duplicates", () => {
  it("stay in the inventory: every drop, a re-roll's too, makes a new entry", () => {
    const pity = { sinceRare: 3, sinceEpic: 3 }
    const drop = { rarity: "rare", itemId: "slayer-cape", gold: 60, entryId: ulid }
    const reroll = { number: 12, trigger: "reroll", chance: 1, pityBefore: pity, rulesVersion: 1, drop }
    expect(Schema.decodeUnknownSync(RollRecord)(reroll)).toEqual(reroll)
    const lost = { ...reroll, drop: { ...drop, entryId: null } }
    expect(Schema.decodeUnknownExit(RollRecord)(lost)._tag).toBe("Failure")
  })

  it("can only miss on a turn or a graded prompt: a re-roll or reward always drops", () => {
    const pityBefore = { sinceRare: 0, sinceEpic: 0 }
    const missable = { number: 12, trigger: "reroll", chance: 0.2, pityBefore, rulesVersion: 1, drop: null }
    expect(Schema.decodeUnknownExit(RollRecord)(missable)._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(RollRecord)({ ...missable, trigger: "turn" })._tag).toBe("Success")
    expect(Schema.decodeUnknownExit(RollRecord)({ ...missable, trigger: "prompt" })._tag).toBe("Success")
  })

  it("salvage into shards tuned per rarity", () => {
    const salvageShards = RulesConfig.fields.loot.fields.salvageShards
    expect(Schema.decodeUnknownExit(salvageShards)({ ...shards, legendary: 25 })._tag).toBe("Success")
    expect(Schema.decodeUnknownExit(salvageShards)(1)._tag).toBe("Failure")
  })

  it("are traded in by command, for shards or a re-roll", () => {
    const salvage = { id: ulid, type: "item.salvage", data: { entryId: ulid } }
    expect(Schema.decodeUnknownSync(Command)(salvage)).toEqual(salvage)
    expect(Schema.decodeUnknownSync(Command)({ ...salvage, type: "item.reroll" })).toEqual({ ...salvage, type: "item.reroll" })
  })
})

describe("Context", () => {
  it("requires a replay to carry what the input produced the first time", () => {
    const mode = Context.fields.mode
    expect(Schema.decodeUnknownExit(mode)({ kind: "live" })._tag).toBe("Success")
    expect(Schema.decodeUnknownExit(mode)({ kind: "replay" })._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(mode)({ kind: "replay", recorded: { rolls: [], refusal: null } })._tag).toBe("Success")
  })
})
