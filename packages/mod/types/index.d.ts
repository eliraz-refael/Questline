// What the band draws from: the session's values the mod keeps in `$.state`.

/** Whether the local server answers. */
export type Link = 'connecting' | 'online' | 'offline'

/** The character as the band shows it, worked out from the server's snapshot. */
export type BandView = {
  name: string
  level: number
  title: string
  /** The icon before "Lv", as the server names it for the level. */
  glyph: string
  xp: { total: number; intoLevel: number; forNextLevel: number }
  gold: number
  pet: { species: string; name: string; form: number; mood: number } | null
}

/** The last thing the stream brought, shown at the end of the band until the next one. */
export type Gain = { text: string; tone: 'xp' | 'level' | 'loot' | 'quiet' }

/** How big a celebration is, as the server's events name it. */
export type Tier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

/**
 * Something the band celebrates, from one server event, or several of the small ones collapsed into one (`more`
 * counts the others).
 */
export type Celebration =
  | { kind: 'xp'; amount: number }
  | { kind: 'loot'; tier: Tier; name: string; gold: number; more: number }
  | { kind: 'level'; tier: Tier; from: number; to: number; glyph: string; title: string | null; evolved: boolean }
  | { kind: 'quest'; tier: Tier; more: number }

/** How the player wants celebrations: animated, as one still frame without the band growing, or not at all. */
export type Motion = 'full' | 'reduced' | 'off'

/**
 * The celebration playing now, at a frame; `seed` varies its sparks from one celebration to the next, and `load`
 * names the copy of the mod that plays it, so a frame another copy left behind is never drawn.
 */
export type Stage = { celebration: Celebration; tick: number; seed: number; motion: 'full' | 'reduced'; load: number }

/** The band's own slots, each drawn from a look: the mod's own, or the band style equipped there. */
export type BandSlot = 'xpBar' | 'levelDisplay' | 'topEdge' | 'goldDisplay'

/** One cell of a loop's frame along a slot's track: at a share of its length, moved `dx` cells. */
export type LookMark = { at: number; dx?: number; glyph?: string; color?: string }

/** One frame of a loop: glyphs and colors laid over the look's accents, and marks along the track. */
export type LookFrame = {
  glyphs?: Readonly<Record<string, string>>
  colors?: Readonly<Record<string, string>>
  marks?: ReadonlyArray<LookMark>
}

/** A band style's look, as the server sends it: glyphs and colors by part, and a loop's frames and rate. */
export type BandLook = {
  glyphs: Readonly<Record<string, string>>
  colors: Readonly<Record<string, string>>
  frames: ReadonlyArray<LookFrame> | null
  fps: number | null
}

/** One owned item, its definition beside its entry. */
export type OwnedItem = {
  entryId: string
  itemId: string
  name: string
  rarity: Tier
  category: string
  slot: string | null
  look: BandLook | null
  lore: string | null
}

/** What the player owns and what is equipped where (slot -> entry id). */
export type Wardrobe = { items: ReadonlyArray<OwnedItem>; equipped: Readonly<Record<string, string>> }

/** The loops' clock: frames since they started, at `rate` a second. Null while they rest, which draws still looks. */
export type Loop = { tick: number; rate: number }

/** The `/questline` pane's tabs. */
export type PaneTab = 'inventory' | 'stats' | 'missions'

declare module 'claude-code' {
  interface PluginState {
    questline: {
      view: BandView | null
      link: Link
      gain: Gain | null
      stage: Stage | null
      /** The celebrations still to play, the one playing first, so a reload of the mod plays them again. */
      queue: ReadonlyArray<Celebration>
      wardrobe: Wardrobe | null
      loop: Loop | null
      tab: PaneTab
    }
  }
}
