import { Schema } from "effect"
import {
  Count,
  Glyph,
  IsoDateTime,
  ItemCategory,
  Multiplier,
  Name,
  Probability,
  QualityDimension,
  Rarity,
  XpTier,
} from "./primitives.ts"

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

/** A sigil's multiplier range at one rarity: `[min, max]`, both inclusive. */
export const MultiplierRange = Schema.Tuple([Multiplier, Multiplier]).check(
  Schema.makeFilter(([min, max]) => min <= max || "a range runs from its least to its most"),
)
export type MultiplierRange = typeof MultiplierRange.Type

/**
 * The multiplier each rarity's sigils carry, in ranges that rise with the rarity and never overlap, so a rarer sigil
 * always beats a more common one.
 */
export const SigilRanges = Schema.Record(Rarity, MultiplierRange).check(
  Schema.makeFilter((ranges) => {
    const rising = Rarity.literals.every((rarity, i) => {
      const next = Rarity.literals[i + 1]
      return next === undefined || ranges[rarity][1] < ranges[next][0]
    })
    return rising || "each rarity's range must sit above the one before, without overlap"
  }),
)
export type SigilRanges = typeof SigilRanges.Type

/**
 * How a graded prompt is priced: XP = maxXp * weighted average score / 10, then the day's band, then the equipped
 * sigil, then the flat boosts, rounded down once.
 */
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
  /** The range a sigil's multiplier sits in, by its rarity; the engine holds a sigil to it. */
  sigilMultiplier: SigilRanges,
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

/** How many missions run: dailies offered and running on their own each local day, weeklies offered and picked. */
export const MissionRules = Schema.Struct({
  daily: Schema.Struct({
    count: Count,
    /** How big the celebration of a completed daily is. */
    tier: Rarity,
  }),
  weekly: Schema.Struct({
    offered: Count,
    /** The most weeklies running at once. */
    active: Count,
    tier: Rarity,
  }),
})
export interface MissionRules extends Schema.Schema.Type<typeof MissionRules> {}

/**
 * The shop: a shelf of items drawn anew each local day, and food on offer every day, each so many a day, for gold.
 * The shop never sells a sigil, so gold never buys XP beyond food's short, flat boost.
 */
export const ShopRules = Schema.Struct({
  /** Items on the shelf each local day, drawn from the catalogue's items of these rarities and categories. */
  offers: Count,
  rarities: Schema.Array(Rarity),
  /** What the shelf draws from; food has its own place, and a sigil is never sold. */
  categories: Schema.Array(ItemCategory),
  /** Copies of each shelf item a day. */
  stock: Count,
  /** Gold for a shelf item, by its rarity. */
  prices: Schema.Record(Rarity, Count),
  /** Every food of the shop's rarities is on offer each day, `stock` of each, at its own prices. */
  food: Schema.Struct({ stock: Count, prices: Schema.Record(Rarity, Count) }),
}).check(
  Schema.makeFilter(
    (shop) =>
      !shop.categories.includes("sigil") || { path: ["categories"], issue: "the shop never sells a sigil" },
  ),
)
export interface ShopRules extends Schema.Schema.Type<typeof ShopRules> {}

/**
 * How caring for the pet lifts its mood, 0-100: food it eats, and a pat, of which only so many an hour count, so
 * petting it more earns nothing. Mood falls only by the daily drift, and nothing is lost when it is low.
 */
export const PetCare = Schema.Struct({
  fed: Count,
  petted: Count,
  pettedPerHour: Count,
})
export interface PetCare extends Schema.Schema.Type<typeof PetCare> {}

/** A species an egg can hatch as: its id, the name the welcome gives it, and a few words about it. */
export const PetSpecies = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u))),
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  about: Schema.String,
})
export interface PetSpecies extends Schema.Schema.Type<typeof PetSpecies> {}

/** The egg before it hatches: the species it hatches as, and the name it takes. */
export const Egg = Schema.Struct({ species: Schema.String, name: Name })
export interface Egg extends Schema.Schema.Type<typeof Egg> {}

/**
 * The pet's rules: how its mood drifts and what a happy one adds, when it evolves, how care lifts it, the species an
 * egg can be, and the egg a player who never picks one hatches.
 */
export const PetRules = Schema.Struct({
  moodDecayPerDay: Schema.Finite,
  /** A pet whose mood is above this is happy, and adds `happyXpBonusPct` to the flat boosts. */
  happyAbove: Schema.Finite,
  happyXpBonusPct: Count,
  evolveAt: Schema.Array(Count),
  care: PetCare,
  /** In the order the welcome offers them. */
  species: Schema.Array(PetSpecies).check(Schema.isMinLength(1)),
  egg: Egg,
}).check(
  Schema.makeFilter((pet) => {
    const ids = pet.species.map((species) => species.id)
    return new Set(ids).size === ids.length || { path: ["species"], issue: "each species needs an id of its own" }
  }),
  Schema.makeFilter(
    (pet) =>
      pet.species.some((species) => species.id === pet.egg.species) || {
        path: ["egg", "species"],
        issue: "the default egg must be one of the species",
      },
  ),
)
export interface PetRules extends Schema.Schema.Type<typeof PetRules> {}

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
    /**
     * Of the drops of each rarity, the share that is a sigil (when the rarity has sigils and other items): sigils
     * come only from drops, and rarely, so a better one keeps coming as the levels get further apart.
     */
    sigilShare: Schema.Record(Rarity, Probability),
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
  pet: PetRules,
  shop: ShopRules,
  streak: Schema.Struct({ xpPerDay: Count, maxXp: Count, restDaysPerWeek: Count }),
  prompt: PromptRules,
  /** Item definitions to fetch if newer. */
  catalogVersion: Count,
  missions: MissionRules,
  /** Active pack ids. */
  questPacks: Schema.Array(Schema.String),
})
export interface RulesConfig extends Schema.Schema.Type<typeof RulesConfig> {}
