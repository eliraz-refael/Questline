// What the band draws from: the session's values the mod keeps in `$.state`.

/** Whether the local server answers. */
export type Link = 'connecting' | 'online' | 'offline'

/** The character as the band shows it, worked out from the server's snapshot. */
export type BandView = {
  name: string
  level: number
  title: string
  xp: { total: number; intoLevel: number; forNextLevel: number }
  gold: number
  streakDays: number
  pet: { species: string; name: string; form: number; mood: number } | null
}

/** The last thing the stream brought, shown at the end of the band until the next one. */
export type Gain = { text: string; tone: 'xp' | 'level' | 'loot' | 'quiet' }

declare module 'claude-code' {
  interface PluginState {
    questline: { view: BandView | null; link: Link; gain: Gain | null }
  }
}
