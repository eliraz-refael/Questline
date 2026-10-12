import type { ItemDef, Pity, Rarity, RulesConfig } from "@pathofdev/schema"
import { draws } from "./random.ts"
import { isSigil } from "./sigils.ts"

const rarities: ReadonlyArray<Rarity> = ["common", "uncommon", "rare", "epic", "legendary"]
/** A rarity's place, common first. */
export const rarityRank = (rarity: Rarity): number => rarities.indexOf(rarity)
const rank = rarityRank

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
 * odds), raised by the pity timers, then an item from that rarity's pool (a sigil only `loot.sigilShare` of the time).
 * A re-roll passes the rarity it keeps. A rarity with no items falls back to the nearest lower one that has some; null
 * when nothing drops or the catalogue is empty.
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
    if (found === undefined) continue
    const pool = poolOf(catalog.filter((item) => item.rarity === found), rules.loot.sigilShare[found], next)
    const item = pool[Math.floor(next() * pool.length)]
    if (item !== undefined) return { rarity: found, item, gold: rules.loot.gold[found] }
  }
  return null
}

/**
 * The items a drop of one rarity is drawn from: its sigils `share` of the time, else the rest, so a sigil stays a rare
 * find however many items its rarity has. A rarity with only one kind draws from what it has.
 */
const poolOf = (items: ReadonlyArray<ItemDef>, share: number, next: () => number): ReadonlyArray<ItemDef> => {
  const sigils = items.filter(isSigil)
  if (sigils.length === 0 || sigils.length === items.length) return items
  return next() < share ? sigils : items.filter((item) => !isSigil(item))
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
