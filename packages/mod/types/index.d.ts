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

/** The celebration playing now, at a frame; `seed` varies its sparks from one celebration to the next. */
export type Stage = { celebration: Celebration; tick: number; seed: number; motion: 'full' | 'reduced' }

declare module 'claude-code' {
  interface PluginState {
    questline: { view: BandView | null; link: Link; gain: Gain | null; stage: Stage | null }
  }
}
