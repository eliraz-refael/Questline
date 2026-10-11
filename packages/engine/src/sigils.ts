import type { Context, ItemDef, PlayerState, RulesConfig } from "@questline/schema"

// A sigil is loot that multiplies the XP graded prompts earn while it is equipped, one at a time, and never runs out.
// Each sigil's multiplier is on its item definition, inside the range the rules give its rarity, so the multiplier
// prices are rules data like every other number. Sigils come only from drops: no shop, re-roll or shard craft makes
// one, so gold never buys XP.

/** A sigil: an item that multiplies prompt XP while it is equipped. */
export const isSigil = (item: ItemDef): boolean => item.category === "sigil" && item.sigil !== undefined

/** A sigil's multiplier held to its rarity's range in the rules: a catalogue out of step with them never pays more. */
export const sigilMultiplier = (rules: RulesConfig, item: ItemDef): number => {
  if (item.sigil === undefined) return 1
  const [min, max] = rules.prompt.sigilMultiplier[item.rarity]
  return Math.min(max, Math.max(min, item.sigil.multiplier))
}

/**
 * The multiplier of the sigil equipped now, at what its item definition carries in the catalogue in force; 1 with
 * none equipped, or one the catalogue no longer has.
 */
export const equippedSigil = (state: PlayerState, context: Pick<Context, "rules" | "catalog">): number => {
  const entryId = state.holdings.equipped.sigil
  if (entryId === undefined) return 1
  const entry = state.holdings.inventory.find((owned) => owned.id === entryId)
  const item = entry === undefined ? undefined : context.catalog.find((def) => def.id === entry.itemId)
  return item === undefined || !isSigil(item) ? 1 : sigilMultiplier(context.rules, item)
}
