import type { ItemDef, RulesConfig } from '@pathofdev/schema'
import type { OwnedItem, SigilView, Tier, Wardrobe } from '../types'
import { tierRank } from './celebrate'
import { cellsOf } from './cells'

// Sigils, as the pane and the band word them: one worn at a time, a multiplier on the XP graded prompts earn. The
// server prices every prompt and sends every multiplier; this file only reads them and says them in plain words.

/** A multiplier as the player reads it: `×2`, `×2.2`, `×1.25`. */
export const multiplierText = (multiplier: number): string => `×${Math.round(multiplier * 100) / 100}`

/**
 * A sigil's power as a definition carries it, read with care: an older server sends none, and a mark that isn't one
 * cell wide falls back to the band's own star, so a row never shifts.
 */
export const sigilOf = (def: Pick<ItemDef, 'sigil'>): SigilView | null => {
  const power = def.sigil
  if (typeof power !== 'object' || power === null) return null
  const { multiplier, glyph, color } = power
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1) return null
  const mark = typeof glyph === 'string' && cellsOf(glyph) === 1 ? glyph : '✦'
  return { multiplier, glyph: mark, color: typeof color === 'string' ? color : '' }
}

/** Whether the server deals in sigils: only one whose rules carry the ranges does. */
export const knowsSigilsOf = (rules: Partial<RulesConfig>): boolean => {
  const ranges: unknown = rules.prompt?.sigilMultiplier
  return typeof ranges === 'object' && ranges !== null
}

/** The sigil worn, if the snapshot names it. */
export const wornSigil = (wardrobe: Wardrobe | null): OwnedItem | null => {
  const entryId = wardrobe?.equipped['sigil']
  if (entryId === undefined) return null
  return wardrobe?.items.find((item) => item.entryId === entryId && item.sigil !== undefined) ?? null
}

/** One sigil the pane lists: an owned kind of sigil, or one worn that the snapshot can't name. */
export type SigilChoice = {
  /** Stable for the Buttons' keys: the item id, or `lost`. */
  key: string
  name: string
  rarity: Tier | null
  /** The entry to equip: the one worn, else the first owned. */
  entryId: string
  count: number
  sigil: SigilView | null
  lore: string | null
  isWorn: boolean
}

/** The owned sigils, the strongest first, copies counted, and one worn the snapshot can't name, so it can come off. */
export const sigilChoices = (wardrobe: Wardrobe | null): Array<SigilChoice> => {
  const wornId = wardrobe?.equipped['sigil']
  const byItem = new Map<string, SigilChoice>()
  for (const item of wardrobe?.items ?? []) {
    if (item.sigil === undefined) continue
    const seen = byItem.get(item.itemId)
    const isWorn = item.entryId === wornId
    byItem.set(item.itemId, {
      key: item.itemId,
      name: item.name,
      rarity: item.rarity,
      entryId: isWorn || seen === undefined ? item.entryId : seen.entryId,
      count: (seen?.count ?? 0) + 1,
      sigil: item.sigil,
      lore: item.lore,
      isWorn: isWorn || (seen?.isWorn ?? false),
    })
  }
  const owned = [...byItem.values()].sort(
    (a, b) =>
      (b.sigil?.multiplier ?? 1) - (a.sigil?.multiplier ?? 1) ||
      tierRank(b.rarity ?? 'common') - tierRank(a.rarity ?? 'common') ||
      a.name.localeCompare(b.name),
  )
  const isNamed = owned.some((choice) => choice.isWorn)
  const lost: Array<SigilChoice> =
    wornId === undefined || isNamed
      ? []
      : [
          {
            key: 'lost',
            name: 'Unknown sigil',
            rarity: null,
            entryId: wornId,
            count: 1,
            sigil: null,
            lore: null,
            isWorn: true,
          },
        ]
  return [...lost, ...owned]
}
