import { Schema } from "effect"
import { Count, Glyph, IsoDateTime, Probability, QualityDimension, Rarity, XpTier } from "./primitives.ts"

/** The scoring facts an `XpRule` prices: every one but a graded prompt, which the `prompt` section prices. */
export const XpFact = Schema.Literals([
  "change.merged",
  "change.opened",
  "commit.made",
  "review.acted_on",
  "issue.closed",
  "bug.fixed",
  "first.contribution",
  "tests.green",
  "repo.explored",
  "streak.day",
])
export type XpFact = typeof XpFact.Type

/** Scoring facts are derived by the server from client events and GitHub; quest goals use the same names. */
export const ScoringFact = Schema.Literals([...XpFact.literals, "prompt.graded"])
export type ScoringFact = typeof ScoringFact.Type

export const XpRule = Schema.Struct({
  xp: Count,
  tier: XpTier,
  dailyCap: Schema.NullOr(Count),
  /** change.merged: 120 in your own or your org's repo, 250 elsewhere. */
  ownRepoXp: Schema.optionalKey(Count),
  /** change.merged: 25% under 3 changed lines. */
  tinyDiffPct: Schema.optionalKey(Count),
})
export interface XpRule extends Schema.Schema.Type<typeof XpRule> {}

// Both must be positive: the curve has to rise for every level to be reachable, and the engine inverts it.
const Positive = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))

/** Total XP for level L = base * L^exponent. */
export const LevelCurve = Schema.Struct({ base: Positive, exponent: Positive })
export interface LevelCurve extends Schema.Schema.Type<typeof LevelCurve> {}

/** A share of the day's prompt XP: prompts up to the `upTo`-th of a local day earn `pct`; null = every one after. */
export const PromptBand = Schema.Struct({ upTo: Schema.NullOr(Count), pct: Count })
export interface PromptBand extends Schema.Schema.Type<typeof PromptBand> {}

/** How a graded prompt is priced: XP = maxXp * weighted average score / 10, then the day's band. */
export const PromptRules = Schema.Struct({
  /** The rubric the mod grades against. */
  rubricVersion: Count,
  /** How much each quality score counts toward XP; `regret` is a stat, never priced. */
  weights: Schema.Record(QualityDimension, Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  /** XP for a perfect weighted grade. */
  maxXp: Count,
  /** Diminishing returns over a local day, in order; past the last band a prompt earns nothing. */
  perDay: Schema.Array(PromptBand),
  /** A prompt counts as regretted from this regret score on: the grader gives small regrets as noise. */
  regretAt: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
}).check(
  Schema.makeFilter(
    (prompt) =>
      Object.values(prompt.weights).some((weight) => weight > 0) || { path: ["weights"], issue: "some score must count" },
  ),
  Schema.makeFilter((prompt) => {
    const rising = prompt.perDay.every((band, i) => {
      const next = prompt.perDay[i + 1]
      return next === undefined || (band.upTo !== null && (next.upTo === null || band.upTo < next.upTo))
    })
    return rising || { path: ["perDay"], issue: "bands must rise, with an open one only last" }
  }),
)
export interface PromptRules extends Schema.Schema.Type<typeof PromptRules> {}

/** The level glyph from `fromLevel` on, up to the next band's; the bands rise, and the first is the glyph below it. */
export const GlyphBand = Schema.Struct({ fromLevel: Count, glyph: Glyph })
export interface GlyphBand extends Schema.Schema.Type<typeof GlyphBand> {}

// At least one band: the snapshot and every level-up name a glyph, and an empty one is no glyph.
const GlyphBands = Schema.Array(GlyphBand).check(
  Schema.isMinLength(1),
  Schema.makeFilter((bands) =>
    bands.every((band, i) => i === 0 || (bands[i - 1]?.fromLevel ?? -1) < band.fromLevel) || "glyph bands must rise",
  ),
)

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
  /** The icon before "Lv" by level band, so progress shows at a glance. */
  glyphs: GlyphBands,
  /** A graded prompt has no rule here: the `prompt` section prices it, always reported and uncapped. */
  xp: Schema.Record(XpFact, XpRule),
  loot: Schema.Struct({
    /** Per finished turn. */
    chancePerTurn: Probability,
    /** Per graded prompt, at a perfect weighted grade; the chance falls in a line to 0 at a grade of 0. */
    promptChanceAtTen: Probability,
    /** A prompt graded at least this well rolls with the rare-and-better weights raised. */
    promptGreatAt: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
    /** What those weights are multiplied by. */
    promptGreatRareFactor: Positive,
    chanceOnVerified: Probability,
    weights: Schema.Record(Rarity, Count),
    /** Every level-up drops one item, by these rarity weights. */
    onLevelUp: Schema.Struct({ weights: Schema.Record(Rarity, Count) }),
    pity: Schema.Struct({ rareAfter: Count, epicAfter: Count }),
    gold: Schema.Record(Rarity, Count),
    shardsToCraft: Count,
    /** Shards of its rarity one salvaged duplicate gives. */
    salvageShards: Schema.Record(Rarity, Count),
    /** Gold to re-roll a duplicate, by its rarity. */
    rerollGold: Schema.Record(Rarity, Count),
  }),
  pet: Schema.Struct({
    moodDecayPerDay: Schema.Finite,
    happyAbove: Schema.Finite,
    happyXpBonusPct: Count,
    evolveAt: Schema.Array(Count),
  }),
  streak: Schema.Struct({ xpPerDay: Count, maxXp: Count, restDaysPerWeek: Count }),
  prompt: PromptRules,
  /** Item definitions to fetch if newer. */
  catalogVersion: Count,
  /** Active pack ids. */
  questPacks: Schema.Array(Schema.String),
})
export interface RulesConfig extends Schema.Schema.Type<typeof RulesConfig> {}
