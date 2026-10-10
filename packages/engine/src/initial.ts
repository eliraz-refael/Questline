import type { PlayerState } from "@questline/schema"
import { localDay } from "./days.ts"

/** A new player: level 0, no pet, nothing owned. */
export const initialState = (options: { characterName: string; timezone: string; now: string }): PlayerState => ({
  characterName: options.characterName,
  timezone: options.timezone,
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
    shards: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    inventory: [],
    equipped: {},
    pet: null,
    peakLevel: 0,
    achievements: [],
    completedQuests: [],
    loot: { nextRoll: 0, pity: { sinceRare: 0, sinceEpic: 0 } },
    shop: { day: localDay(options.now, options.timezone), bought: {} },
  },
})
