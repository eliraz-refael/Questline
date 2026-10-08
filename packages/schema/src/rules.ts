import { Schema } from "effect"
import { Count, IsoDateTime, Rarity, XpTier } from "./primitives.ts"

/** Scoring facts are derived by the server from client events and GitHub; quest goals use the same names. */
export const ScoringFact = Schema.Literals([
  "pr.merged",
  "pr.opened",
  "commit.made",
  "review.acted_on",
  "issue.closed",
  "bug.fixed",
  "first.contribution",
  "tests.green",
  "repo.explored",
  "streak.day",
])
export type ScoringFact = typeof ScoringFact.Type

export const XpRule = Schema.Struct({
  xp: Count,
  tier: XpTier,
  dailyCap: Schema.NullOr(Count),
  /** pr.merged: 120 in your own or your org's repo, 250 elsewhere. */
  ownRepoXp: Schema.optionalKey(Count),
  /** pr.merged: 25% under 3 changed lines. */
  tinyDiffPct: Schema.optionalKey(Count),
})
export interface XpRule extends Schema.Schema.Type<typeof XpRule> {}

// Both must be positive: the curve has to rise for every level to be reachable, and the engine inverts it.
const Positive = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))

/** Total XP for level L = base * L^exponent. */
export const LevelCurve = Schema.Struct({ base: Positive, exponent: Positive })
export interface LevelCurve extends Schema.Schema.Type<typeof LevelCurve> {}

const Probability = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))

/** The game's tuning. The mod never hard-codes a number from it. */
export const RulesConfig = Schema.Struct({
  /** Tuning version. */
  version: Count,
  /** Shape of this object. */
  schemaVersion: Count,
  /** Null = retroactive over all history. */
  appliesFrom: Schema.NullOr(IsoDateTime),
  levelCurve: LevelCurve,
  titles: Schema.Array(Schema.Struct({ fromLevel: Count, title: Schema.String })),
  xp: Schema.Record(ScoringFact, XpRule),
  loot: Schema.Struct({
    chancePerTurn: Probability,
    chanceOnVerified: Probability,
    weights: Schema.Record(Rarity, Count),
    pity: Schema.Struct({ rareAfter: Count, epicAfter: Count }),
    gold: Schema.Record(Rarity, Count),
    shardsToCraft: Count,
  }),
  pet: Schema.Struct({
    moodDecayPerDay: Schema.Finite,
    happyAbove: Schema.Finite,
    happyXpBonusPct: Count,
    evolveAt: Schema.Array(Count),
  }),
  streak: Schema.Struct({ xpPerDay: Count, maxXp: Count, restDaysPerWeek: Count }),
  /** Item definitions to fetch if newer. */
  catalogVersion: Count,
  /** Active pack ids. */
  questPacks: Schema.Array(Schema.String),
})
export interface RulesConfig extends Schema.Schema.Type<typeof RulesConfig> {}
