import type { ServerEvent, Snapshot } from '@questline/schema'
import type { BandView, Gain, OwnedItem, Wardrobe } from '../types'
import { tierOf } from './celebrate'

// What the band draws, worked out from the server's snapshot and stream; no game rule is computed here.

export const viewOf = (snapshot: Snapshot): BandView => ({
  name: snapshot.character.name,
  level: snapshot.character.level,
  title: snapshot.character.title,
  // An older server's snapshot names no glyph: the band's first one stands in.
  glyph: snapshot.character.glyph || '⚔',
  xp: {
    total: snapshot.character.xp.total,
    intoLevel: snapshot.character.xp.intoLevel,
    forNextLevel: snapshot.character.xp.forNextLevel,
  },
  gold: snapshot.character.gold,
  pet:
    snapshot.pet === null
      ? null
      : { species: snapshot.pet.species, name: snapshot.pet.name, form: snapshot.pet.form, mood: snapshot.pet.mood },
})

/** What the player owns, by the definitions the snapshot carries, and what is equipped where. */
export const wardrobeOf = (snapshot: Snapshot): Wardrobe => {
  // An older server's snapshot carries no definitions: nothing it can't name is shown.
  const defs = Array.isArray(snapshot.items) ? snapshot.items : []
  const inventory = Array.isArray(snapshot.inventory) ? snapshot.inventory : []
  const byId = new Map(defs.map((def) => [def.id, def]))
  const items = inventory.flatMap((entry): Array<OwnedItem> => {
    const def = byId.get(entry.itemId)
    if (def === undefined) return []
    const { name, category, slot, lore } = def
    const look = def.look ?? null
    return [{ entryId: entry.id, itemId: def.id, name, rarity: tierOf(def.rarity), category, slot, look, lore }]
  })
  const equipped: Record<string, string> = {}
  const worn = [...Object.entries(snapshot.character.equipped ?? {}), ...Object.entries(snapshot.pet?.equipped ?? {})]
  for (const [slot, entryId] of worn)
    if (typeof entryId === 'string') equipped[slot] = entryId
  return { items, equipped }
}

/** The egg hatches once the character reaches level 1. */
export const canHatch = (view: BandView): boolean => view.pet === null && view.level >= 1

/** The XP bar as filled and empty cells. */
export const bar = (view: BandView, width: number): { filled: number; empty: number } => {
  const share = view.xp.forNextLevel === 0 ? 0 : view.xp.intoLevel / view.xp.forNextLevel
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return { filled, empty: width - filled }
}

// Placeholder sprites until the pixel art lands: one face per species, a little bigger per form.
const faces: Record<string, ReadonlyArray<string>> = {
  fox: ['ᓚᘏᗢ', 'ᓚᘏᗢ✧', '✧ᓚᘏᗢ✧', '✦ᓚᘏᗢ✦'],
  slime: ['(•ᴗ•)', '(•ᴗ•)✧', '✧(•ᴗ•)✧', '✦(•ᴗ•)✦'],
  robot: ['[o_o]', '[o_o]✧', '✧[o_o]✧', '✦[o_o]✦'],
  owl: ['{◉,◉}', '{◉,◉}✧', '✧{◉,◉}✧', '✦{◉,◉}✦'],
}

export const sprite = (pet: NonNullable<BandView['pet']>): string => {
  const forms = faces[pet.species] ?? faces['fox'] ?? ['?']
  return forms[Math.min(pet.form, forms.length - 1)] ?? '?'
}

export const hearts = (mood: number): string => (mood > 70 ? '♥♥♥' : mood > 40 ? '♥♥' : '♥')

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** What one server event shows: a line at the end of the band, and for the big moments a toast. */
export const announce = (event: ServerEvent): { gain?: Gain; toast?: string } => {
  switch (event.type) {
    case 'xp.granted':
      return { gain: { text: `+${event.data.amount} xp · ${event.data.reason}`, tone: 'xp' } }
    case 'xp.capped':
      return { gain: { text: `${event.data.eventType}: daily cap reached`, tone: 'quiet' } }
    case 'level.up': {
      const title = event.data.title === undefined ? '' : ` · ${event.data.title}`
      return { gain: { text: `Level ${event.data.to}!`, tone: 'level' }, toast: `⬆ Level ${event.data.to}${title}` }
    }
    case 'loot.dropped': {
      const { item, gold } = event.data
      const text = `${capitalised(item.rarity)} drop: ${item.name}`
      return { gain: { text, tone: 'loot' }, toast: `✦ ${text}${gold > 0 ? ` (+${gold} gold)` : ''}` }
    }
    case 'pet.hatched':
      return { toast: `🥚 ${event.data.name} hatched!` }
    case 'streak.changed':
      return event.data.days > 1 ? { gain: { text: `${event.data.days}-day streak`, tone: 'xp' } } : {}
    default:
      return {}
  }
}
