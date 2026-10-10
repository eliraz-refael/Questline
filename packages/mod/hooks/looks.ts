import type { BandLook, BandSlot, Loop, LookFrame, LookMark, OwnedItem, Wardrobe } from '../types'
import type { Style } from './cells'
import { cellsOf } from './cells'

// The band's looks: the mod's own, which it draws wherever nothing is equipped, and the band styles the server sends
// as data. A slot is drawn from named parts (the schema's `bandParts` lists them); a look names glyphs and colors for
// any of them over the mod's own, and a loop lays one frame's accents and marks over that. Nothing here knows any
// look but the mod's own: every other one arrives with the snapshot.

export const bandSlots: ReadonlyArray<BandSlot> = ['xpBar', 'levelDisplay', 'topEdge', 'goldDisplay']

const still = { frames: null, fps: null }

/** The band as it is drawn with nothing equipped. Its colors are the theme's, so it follows the person's theme. */
export const ownLooks: Record<BandSlot, BandLook> = {
  xpBar: { glyphs: { full: '▰', empty: '▱' }, colors: { full: 'success' }, ...still },
  levelDisplay: { glyphs: { lv: 'Lv' }, colors: { glyph: 'claude', level: 'claude' }, ...still },
  topEdge: {
    glyphs: { line: '─', left: '┤', right: '├', star: '✦', knot: '✧', dot: '·' },
    colors: {
      line: 'claude',
      left: 'claude',
      right: 'claude',
      star: 'claude',
      title: 'claude',
      knot: 'claude',
      dot: 'claude',
    },
    ...still,
  },
  goldDisplay: { glyphs: { icon: '◈' }, colors: { icon: 'suggestion', amount: 'suggestion' }, ...still },
}

/** Parts the mod's own look draws dim, until a band style gives them a color of its own. */
const dimParts: Record<BandSlot, ReadonlyArray<string>> = {
  xpBar: ['empty'],
  levelDisplay: [],
  topEdge: ['line', 'left', 'right', 'knot', 'dot'],
  goldDisplay: [],
}

/** The budget of an in-band loop: no faster than this, and no more marks a frame than this. */
export const maxFps = 6
export const maxMarks = 12

/** Whether a look loops: frames to play, at a rate. */
export const loops = (look: BandLook | null): boolean =>
  look !== null && look.frames !== null && look.frames.length > 1 && look.fps !== null && look.fps > 0

/** The frame a look is at on the loops' clock, or null when it is still or the loops rest. */
export const frameOf = (look: BandLook | null, loop: Loop | null): LookFrame | null => {
  if (loop === null || look === null || !loops(look) || look.frames === null || look.fps === null) return null
  const fps = Math.min(maxFps, look.fps)
  return look.frames[Math.floor((loop.tick * fps) / Math.max(1, loop.rate)) % look.frames.length] ?? null
}

/** What a slot is drawn with at one moment: its parts' glyphs and styles, and the marks along its track. */
export type Parts = {
  /** The part's glyph, or `fallback` when the look has none or one that isn't one cell wide. */
  readonly glyph: (part: string, fallback?: string) => string | undefined
  /** Any text the part draws, such as "Lv". */
  readonly text: (part: string, fallback: string) => string
  readonly style: (part: string) => Style
  readonly marks: ReadonlyArray<LookMark>
}

/** The parts of `slot` under `look` (null: the mod's own) at the loops' moment `loop` (null: still). */
export const partsOf = (slot: BandSlot, look: BandLook | null, loop: Loop | null): Parts => {
  const own = ownLooks[slot]
  const frame = frameOf(look, loop)
  const glyphs = { ...own.glyphs, ...look?.glyphs, ...frame?.glyphs }
  const colors = { ...own.colors, ...look?.colors, ...frame?.colors }
  const colored = { ...look?.colors, ...frame?.colors }
  return {
    glyph: (part, fallback) => {
      const glyph = glyphs[part]
      return glyph !== undefined && cellsOf(glyph) === 1 ? glyph : (own.glyphs[part] ?? fallback)
    },
    text: (part, fallback) => glyphs[part] ?? fallback,
    style: (part) => {
      const color = colors[part]
      const dim = colored[part] === undefined && dimParts[slot].includes(part)
      return { ...(color === undefined ? {} : { color }), ...(dim ? { dim } : {}) }
    },
    marks: (frame?.marks ?? []).slice(0, maxMarks),
  }
}

/** The cell a mark lands on along a track `length` cells long, or null off its ends. */
export const markCell = (mark: LookMark, length: number): number | null => {
  const at = Math.round(Math.max(0, Math.min(1, mark.at)) * Math.max(0, length - 1)) + Math.round(mark.dx ?? 0)
  return at >= 0 && at < length ? at : null
}

const isBandSlot = (slot: string | null): slot is BandSlot => bandSlots.some((band) => band === slot)

/** The item equipped in a slot, if the wardrobe has it. */
export const equippedIn = (wardrobe: Wardrobe | null, slot: string): OwnedItem | null => {
  const entryId = wardrobe?.equipped[slot]
  return wardrobe?.items.find((item) => item.entryId === entryId) ?? null
}

/** The band style worn in each band slot; a slot left out draws the mod's own look. */
export const wornLooks = (wardrobe: Wardrobe | null): Partial<Record<BandSlot, BandLook>> => {
  const worn: Partial<Record<BandSlot, BandLook>> = {}
  for (const slot of bandSlots) {
    const item = equippedIn(wardrobe, slot)
    if (item !== null && item.slot === slot && item.look !== null) worn[slot] = item.look
  }
  return worn
}

/** Every band style owned, which the pane previews. */
export const ownedLooks = (wardrobe: Wardrobe | null): Array<BandLook> =>
  (wardrobe?.items ?? []).flatMap((item) => (isBandSlot(item.slot) && item.look !== null ? [item.look] : []))

/** The loops' clock rate for these looks: the fastest of those that loop, within the budget; 0 when none loops. */
export const rateOf = (looks: ReadonlyArray<BandLook>): number =>
  Math.min(maxFps, Math.max(0, ...looks.flatMap((look) => (loops(look) && look.fps !== null ? [look.fps] : []))))
