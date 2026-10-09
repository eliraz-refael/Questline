import type { ItemDef, RulesConfig } from "@questline/schema"

// The starter config and catalogue a fresh local server begins with: the design doc's numbers. One deviation for
// the proof of concept: merges are reported XP until the verifier lands, so the loop has its big moment.

export const starterRules: RulesConfig = {
  version: 1,
  schemaVersion: 1,
  appliesFrom: null,
  levelCurve: { base: 100, exponent: 1.6 },
  titles: [
    { fromLevel: 1, title: "Apprentice" },
    { fromLevel: 10, title: "Adept" },
    { fromLevel: 25, title: "Artisan" },
    { fromLevel: 50, title: "Master" },
    { fromLevel: 75, title: "Grandmaster" },
    { fromLevel: 100, title: "Legend" },
  ],
  xp: {
    "change.merged": { xp: 250, tier: "reported", dailyCap: null, ownRepoXp: 120, tinyDiffPct: 25 },
    "change.opened": { xp: 0, tier: "reported", dailyCap: null },
    "commit.made": { xp: 3, tier: "reported", dailyCap: 20 },
    "review.acted_on": { xp: 80, tier: "verified", dailyCap: 10 },
    "issue.closed": { xp: 60, tier: "verified", dailyCap: 5 },
    "bug.fixed": { xp: 150, tier: "verified", dailyCap: 5 },
    "first.contribution": { xp: 300, tier: "verified", dailyCap: null },
    "tests.green": { xp: 20, tier: "reported", dailyCap: 5 },
    "repo.explored": { xp: 25, tier: "reported", dailyCap: 3 },
    "streak.day": { xp: 10, tier: "reported", dailyCap: 1 },
  },
  loot: {
    chancePerTurn: 0.12,
    chanceOnVerified: 1,
    weights: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 },
    pity: { rareAfter: 25, epicAfter: 80 },
    gold: { common: 10, uncommon: 25, rare: 70, epic: 175, legendary: 400 },
    shardsToCraft: 10,
    salvageShards: { common: 1, uncommon: 1, rare: 1, epic: 1, legendary: 1 },
    rerollGold: { common: 20, uncommon: 50, rare: 120, epic: 300, legendary: 800 },
  },
  pet: { moodDecayPerDay: 10, happyAbove: 70, happyXpBonusPct: 5, evolveAt: [10, 25, 50] },
  streak: { xpPerDay: 10, maxXp: 70, restDaysPerWeek: 1 },
  catalogVersion: 1,
  questPacks: [],
}

const item = (def: Pick<ItemDef, "id" | "name" | "rarity" | "category" | "slot"> & Partial<ItemDef>): ItemDef => ({
  sprite: null,
  lore: null,
  effect: null,
  ...def,
})

export const starterCatalog: ReadonlyArray<ItemDef> = [
  item({ id: "plain-cap", name: "Plain Cap", rarity: "common", category: "wearable", slot: "head" }),
  item({ id: "paper-scarf", name: "Paper Scarf", rarity: "common", category: "wearable", slot: "neck" }),
  item({
    id: "trail-mix",
    name: "Trail Mix",
    rarity: "common",
    category: "food",
    slot: null,
    effect: { xpBoostPct: 10, minutes: 60 },
  }),
  item({ id: "knit-scarf", name: "Knit Scarf", rarity: "uncommon", category: "wearable", slot: "neck" }),
  item({ id: "confetti-pop", name: "Confetti Pop", rarity: "uncommon", category: "levelUpEffect", slot: "levelUpEffect" }),
  item({ id: "terminal-green", name: "Terminal Green", rarity: "uncommon", category: "scene", slot: "scene" }),
  item({ id: "wizard-hat", name: "Wizard Hat", rarity: "rare", category: "wearable", slot: "head" }),
  item({ id: "fireworks", name: "Fireworks", rarity: "rare", category: "levelUpEffect", slot: "levelUpEffect" }),
  item({ id: "pixel-dragon", name: "Pixel Dragon", rarity: "epic", category: "levelUpEffect", slot: "levelUpEffect" }),
  item({
    id: "aurora-crown",
    name: "Aurora Crown",
    rarity: "legendary",
    category: "artefact",
    slot: "aura",
    lore: "Said to glow brighter with every merge.",
  }),
]
