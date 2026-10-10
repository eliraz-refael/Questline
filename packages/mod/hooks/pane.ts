import type { BandLook, BandSlot, PaneTab, Tier, Wardrobe } from '../types'
import { bandSlots, equippedIn, loops } from './looks'

// The `/questline` pane: a hub of tabs, each a view of the game. This file says what the tabs are and what the
// inventory lists; register.tsx draws them. A later tab is one more entry here and one more body there.

/** The pane's id, which `$.ui.open` and the `ui.render` matcher share. */
export const paneId = 'questline'

/** The tabs in order; one not ready yet shows dim, as what is coming. */
export const tabs: ReadonlyArray<{ id: PaneTab; label: string; isReady: boolean }> = [
  { id: 'inventory', label: 'Inventory', isReady: true },
  { id: 'stats', label: 'Stats', isReady: false },
  { id: 'missions', label: 'Missions', isReady: false },
]

/** A tab the pane can show: the one asked for when it is ready, else the first that is. */
export const tabOf = (asked: PaneTab | null): PaneTab =>
  tabs.find((tab) => tab.id === asked && tab.isReady)?.id ?? 'inventory'

const slotNames: Record<BandSlot, string> = {
  xpBar: 'XP bar',
  levelDisplay: 'Level',
  topEdge: 'Top edge',
  goldDisplay: 'Gold',
}

const rank: Record<Tier, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }

/** One look a band slot can wear: the mod's own (`entryId` null), or an owned band style. */
export type Choice = {
  /** Stable for the Buttons' keys: the item id, or `own`. */
  key: string
  name: string
  rarity: Tier | null
  /** The entry to equip: the one equipped, else the first owned. */
  entryId: string | null
  /** Copies owned. */
  count: number
  look: BandLook | null
  lore: string | null
  isWorn: boolean
  isLooping: boolean
  /** What the pane says in place of a rarity: the mod's own look, or an equipped item the snapshot can't name. */
  note: string | null
}

export type Section = { slot: BandSlot; title: string; choices: ReadonlyArray<Choice> }

/** The band slots in the band's order, each with the mod's own look first, then the owned ones, rarest first. */
export const lookSections = (wardrobe: Wardrobe | null): Array<Section> =>
  bandSlots.map((slot) => {
    const worn = equippedIn(wardrobe, slot)
    const owned = (wardrobe?.items ?? []).filter((item) => item.slot === slot && item.look !== null)
    const byItem = new Map<string, Choice>()
    for (const item of owned) {
      const seen = byItem.get(item.itemId)
      const isWorn = worn?.entryId === item.entryId
      byItem.set(item.itemId, {
        key: item.itemId,
        name: item.name,
        rarity: item.rarity,
        entryId: isWorn || seen === undefined ? item.entryId : seen.entryId,
        count: (seen?.count ?? 0) + 1,
        look: item.look,
        lore: item.lore,
        isWorn: isWorn || (seen?.isWorn ?? false),
        isLooping: loops(item.look),
        note: null,
      })
    }
    // An entry equipped there that the snapshot has no definition for (a later catalogue dropped it) still shows,
    // so it can be taken off.
    const entryId = wardrobe?.equipped[slot]
    const lost: Array<Choice> =
      entryId === undefined || worn !== null
        ? []
        : [
            {
              key: 'lost',
              name: 'Unknown style',
              rarity: null,
              entryId,
              count: 1,
              look: null,
              lore: null,
              isWorn: true,
              isLooping: false,
              note: 'no longer in the catalogue',
            },
          ]
    const styles = [...byItem.values()].sort(
      (a, b) => rank[b.rarity ?? 'common'] - rank[a.rarity ?? 'common'] || a.name.localeCompare(b.name),
    )
    const own: Choice = {
      key: 'own',
      name: 'Classic',
      rarity: null,
      entryId: null,
      count: 1,
      look: null,
      lore: null,
      isWorn: lost.length === 0 && !styles.some((choice) => choice.isWorn),
      isLooping: false,
      note: 'the band as it comes',
    }
    return { slot, title: slotNames[slot], choices: [own, ...lost, ...styles] }
  })

/** Everything else owned, by name, rarest first, with how many of each. */
export type OtherItem = { itemId: string; name: string; rarity: Tier; kind: string; count: number }

export const otherItems = (wardrobe: Wardrobe | null): Array<OtherItem> => {
  const counted = new Map<string, OtherItem>()
  for (const item of wardrobe?.items ?? []) {
    if (item.look !== null) continue
    const seen = counted.get(item.itemId)
    const count = (seen?.count ?? 0) + 1
    const { itemId, name, rarity } = item
    counted.set(itemId, { itemId, name, rarity, kind: kindOf(item.category), count })
  }
  return [...counted.values()].sort((a, b) => rank[b.rarity] - rank[a.rarity] || a.name.localeCompare(b.name))
}

const kinds: Record<string, string> = {
  food: 'food',
  wearable: 'pet wear',
  scene: 'scene',
  title: 'title',
  artefact: 'artefact',
  levelUpEffect: 'level-up effect',
}

const kindOf = (category: string): string => kinds[category] ?? category
