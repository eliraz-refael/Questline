import type { ItemDef, Pity, Rarity, RulesConfig } from "@questline/schema"
import { draws } from "./random.ts"

const rarities: ReadonlyArray<Rarity> = ["common", "uncommon", "rare", "epic", "legendary"]
const rank = (rarity: Rarity): number => rarities.indexOf(rarity)

export interface Drop {
  readonly rarity: Rarity
  readonly item: ItemDef
  readonly gold: number
}

export type RarityWeights = Readonly<Record<Rarity, number>>

const pickRarity = (draw: number, weights: RarityWeights): Rarity => {
  const total = rarities.reduce((sum, rarity) => sum + weights[rarity], 0)
  let left = draw * total
  for (const rarity of rarities) {
    left -= weights[rarity]
    if (left < 0) return rarity
  }
  return "common"
}

/**
 * Roll `number`: whether anything drops at all, then a rarity by weight (the loot's own unless a trigger has its
 * odds), raised by the pity timers, then an item from that rarity's pool. A re-roll passes the rarity it keeps. A
 * rarity with no items falls back to the nearest lower one that has some; null when nothing drops or the catalogue
 * is empty.
 */
export const rollLoot = (
  seed: string,
  number: number,
  chance: number,
  rules: RulesConfig,
  catalog: ReadonlyArray<ItemDef>,
  pity: Pity,
  weights: RarityWeights = rules.loot.weights,
  keep?: Rarity,
): Drop | null => {
  const next = draws(seed, `roll:${number}`)
  if (next() >= chance) return null
  let rarity = keep ?? pickRarity(next(), weights)
  if (keep === undefined) {
    if (pity.sinceEpic >= rules.loot.pity.epicAfter && rank(rarity) < rank("epic")) rarity = "epic"
    else if (pity.sinceRare >= rules.loot.pity.rareAfter && rank(rarity) < rank("rare")) rarity = "rare"
  }
  for (let r = rank(rarity); r >= 0; r--) {
    const found = rarities[r]
    const pool = catalog.filter((item) => item.rarity === found)
    const item = pool[Math.floor(next() * pool.length)]
    if (found !== undefined && item !== undefined) return { rarity: found, item, gold: rules.loot.gold[found] }
  }
  return null
}

/** The weights with rare and better multiplied by `factor`, as a great prompt rolls. */
export const raiseRare = (weights: RarityWeights, factor: number): RarityWeights => ({
  ...weights,
  rare: weights.rare * factor,
  epic: weights.epic * factor,
  legendary: weights.legendary * factor,
})

/** Pity after a drop: rare or better resets the rare timer, epic or better resets both. */
export const pityAfter = (pity: Pity, rarity: Rarity): Pity =>
  rank(rarity) >= rank("epic")
    ? { sinceRare: 0, sinceEpic: 0 }
    : rank(rarity) >= rank("rare")
      ? { sinceRare: 0, sinceEpic: pity.sinceEpic + 1 }
      : { sinceRare: pity.sinceRare + 1, sinceEpic: pity.sinceEpic + 1 }
