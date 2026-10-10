import type { PluginOptions } from 'claude-code'
import type { ServerEvent } from '@questline/schema'
import type { Celebration, Motion, Tier } from '../types'

// What the band celebrates and when: the server's events as celebrations, the queue they wait in, and how long each
// plays. The server names every tier; nothing here decides how big a moment is, only how a tier is staged.

const tiers: ReadonlyArray<Tier> = ['common', 'uncommon', 'rare', 'epic', 'legendary']

/** A tier from the wire; one this mod doesn't know yet plays as the smallest. */
export const tierOf = (value: string): Tier => tiers.find((tier) => tier === value) ?? 'common'

/** The celebration a server event brings, if any. `glyph` stands in for a level-up an older server sent without one. */
export const celebrationOf = (event: ServerEvent, glyph: string): Celebration | null => {
  switch (event.type) {
    case 'xp.granted':
      return event.data.amount > 0 ? { kind: 'xp', amount: event.data.amount } : null
    case 'loot.dropped':
      return { kind: 'loot', tier: tierOf(event.data.tier), name: event.data.item.name, gold: event.data.gold, more: 0 }
    case 'level.up': {
      const { from, to, tier, title, evolution } = event.data
      const named = typeof event.data.glyph === 'string' && event.data.glyph !== '' ? event.data.glyph : glyph
      const evolved = evolution !== undefined
      return { kind: 'level', tier: tierOf(tier), from, to, glyph: named, title: title ?? null, evolved }
    }
    case 'quest.completed':
      return { kind: 'quest', tier: tierOf(event.data.tier), more: 0 }
    default:
      return null
  }
}

/** The `animations` option: `full` unless the player picked `reduced` or `off`. */
export const motionOf = (options: PluginOptions): Motion => {
  const value = options['animations']
  return value === 'reduced' || value === 'off' ? value : 'full'
}

/** How big a celebration is, for the queue's order: an XP gain is the smallest, then the tiers in order. */
export const rankOf = (celebration: Celebration): number =>
  celebration.kind === 'xp' ? 0 : tiers.indexOf(celebration.tier) + 1

/** Common and uncommon moments play in the band's own rows; rare and up make it grow. */
export const isSmall = (celebration: Celebration): boolean => celebration.kind !== 'xp' && rankOf(celebration) <= 2

/** Past this many rare-or-bigger celebrations waiting, the smallest of them give way. */
export const maxBig = 3

const moreOf = (celebration: Celebration): number =>
  celebration.kind === 'loot' || celebration.kind === 'quest' ? celebration.more : 0

const withMore = (celebration: Celebration, more: number): Celebration =>
  celebration.kind === 'loot' || celebration.kind === 'quest' ? { ...celebration, more } : celebration

/**
 * The queue with one more celebration in it, smallest first so the biggest plays last; equals keep their order. A
 * backlog collapses: XP gains add up into one shimmer, the small drops into the best of them (the newest among
 * equals) counting the rest, and past `maxBig` big ones the smallest give way.
 */
export const joinQueue = (queue: ReadonlyArray<Celebration>, next: Celebration): Array<Celebration> => {
  const xp = queue.find((one) => one.kind === 'xp')
  const small = queue.find(isSmall)
  let merged: Array<Celebration>
  if (next.kind === 'xp' && xp?.kind === 'xp') {
    merged = queue.map((one) => (one === xp ? { kind: 'xp', amount: xp.amount + next.amount } : one))
  } else if (isSmall(next) && small !== undefined) {
    const kept = rankOf(small) > rankOf(next) ? small : next
    const more = moreOf(small) + moreOf(next) + 1
    merged = queue.map((one) => (one === small ? withMore(kept, more) : one))
  } else {
    merged = [...queue, next]
  }
  const ordered = merged.map((one, i) => ({ one, i })).sort((a, b) => rankOf(a.one) - rankOf(b.one) || a.i - b.i)
  const big = ordered.filter(({ one }) => rankOf(one) > 2)
  const dropped = new Set(big.slice(0, Math.max(0, big.length - maxBig)).map(({ i }) => i))
  return ordered.filter(({ i }) => !dropped.has(i)).map(({ one }) => one)
}

/** A queue rebuilt from celebrations in arrival order, as `joinQueue` would have built it. */
export const queueOf = (celebrations: ReadonlyArray<Celebration>): Array<Celebration> =>
  celebrations.reduce<Array<Celebration>>(joinQueue, [])

/** How a celebration plays: so many frames, each held so long. */
export type Script = { frameMs: number; ticks: number }

/** Frames a second, and each full-motion celebration's length in frames: about 1, 2, 3 and 4.5 seconds. */
export const fps = 6
const ticksByRank: ReadonlyArray<number> = [6, 6, 6, 12, 18, 27]
/** The still frame `reduced` shows instead, by rank. */
const holdByRank: ReadonlyArray<number> = [1000, 1200, 1200, 2000, 2500, 3000]

export const scriptOf = (celebration: Celebration, motion: 'full' | 'reduced'): Script => {
  const rank = rankOf(celebration)
  return motion === 'reduced'
    ? { frameMs: holdByRank[rank] ?? 1000, ticks: 1 }
    : { frameMs: Math.round(1000 / fps), ticks: ticksByRank[rank] ?? 6 }
}

/** Between two celebrations, and after a turn before the first: the answer lands before the band moves. */
export const gapMs = 350
export const idleMs = 600

/** The chime an epic or legendary celebration plays in full motion, on the frame its name is revealed. */
export const chimeOf = (
  celebration: Celebration,
  motion: Motion,
): { tick: number; tier: 'epic' | 'legendary' } | null =>
  motion !== 'full' || celebration.kind === 'xp' || rankOf(celebration) < 4
    ? null
    : { tick: 3, tier: celebration.tier === 'legendary' ? 'legendary' : 'epic' }

// The chime: a few bell-like sine notes, each a soft strike with a long fall, written as a 16-bit mono WAV.

const rate = 22_050
const chimes: Record<'epic' | 'legendary', ReadonlyArray<number>> = {
  // A rising fifth, then the octave: B5, F#6, B6.
  epic: [987.77, 1479.98, 1975.53],
  // A rising major arpeggio up to the high octave: C6, E6, G6, C7.
  legendary: [1046.5, 1318.51, 1567.98, 2093],
}

const made: Partial<Record<'epic' | 'legendary', string>> = {}

/** The chime for a tier, as base64 WAV bytes, made once. */
export const chimeWav = (tier: 'epic' | 'legendary'): string => (made[tier] ??= chimeBytes(tier))

const chimeBytes = (tier: 'epic' | 'legendary'): string => {
  const notes = chimes[tier]
  const stepS = tier === 'legendary' ? 0.11 : 0.13
  const ringS = tier === 'legendary' ? 1.1 : 0.85
  const seconds = stepS * (notes.length - 1) + ringS
  const samples = Math.round(seconds * rate)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let n = 0; n < samples; n++) {
    const t = n / rate
    let value = 0
    for (const [i, hz] of notes.entries()) {
      const since = t - i * stepS
      if (since < 0) continue
      // A 4 ms strike, then an exponential fall; a quiet octave above gives it the shimmer of a bell.
      const envelope = Math.min(1, since / 0.004) * Math.exp(-since * 5)
      value += envelope * (Math.sin(2 * Math.PI * hz * since) + 0.25 * Math.sin(4 * Math.PI * hz * since))
    }
    // The tail fades to silence so the clip never ends on a click.
    const tail = Math.min(1, (seconds - t) / 0.05)
    view.setInt16(44 + n * 2, Math.round(Math.max(-1, Math.min(1, value * 0.28 * tail)) * 32_767), true)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096))
  return btoa(binary)
}
