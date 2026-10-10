import type { BandLook, BandView, Celebration, Loop, Stage, Tier } from '../types'
import { barCells } from './band'
import { isSmall, scriptOf } from './celebrate'
import type { Cell, Row, Run, Style } from './cells'
import { cellsOf, glyphSlot, glyphsOf, isWide, runsOf } from './cells'

// What each frame of a celebration looks like, as rows of styled runs the band draws. Every look is plain data
// (glyph sequences, colors) so a later cosmetic can swap one for another; the frames are worked out from the stage,
// the band's width and the rows it may take, so a redraw at the same tick draws the same frame.

/** A celebration's look: its glyph sequences, and its palette from the brightest color to the dimmest. */
export type Look = { glyphs: ReadonlyArray<string>; sparks: ReadonlyArray<string>; colors: ReadonlyArray<string> }

const white = '#ffffff'
const gold = '#ffd23f'

/** The item colors players know: grey, green, blue, purple, orange. */
export const rarityColors: Record<Tier, string> = {
  common: '#d0d0d0',
  uncommon: '#5fd75f',
  rare: '#4ea8ff',
  epic: '#c77dff',
  legendary: '#ffb627',
}

export const looks: Record<Tier | 'xp' | 'level', Look> = {
  // A glint runs along the new XP, a star twinkling at the bar's head.
  xp: {
    glyphs: ['✦', '✧', '·', '✧', '✦', '✧'],
    sparks: [],
    colors: [white, '#d7ffaf', '#87ff87', '#5fd75f'],
  },
  // A coin spins beside the drop and lands as gold.
  common: { glyphs: ['◐', '◓', '◑', '◒'], sparks: ['◈'], colors: ['#fff1a8', gold, '#e0a526', '#b8860b'] },
  // Two sparkles twinkle around the name, out of step.
  uncommon: {
    glyphs: ['˚', '✧', '✦', '❋', '✦', '✧'],
    sparks: [],
    colors: [white, '#c3f7c3', '#5fd75f', '#2e8b57'],
  },
  // The chest's light and the sparks that rise out of it.
  rare: { glyphs: ['░', '▒', '▓', '█'], sparks: ['✦', '✧', '·'], colors: [white, '#b8dcff', '#4ea8ff', '#1f5fbf'] },
  // Rings of sparks that burn out as they fly.
  epic: {
    glyphs: [],
    sparks: ['✸', '✦', '✦', '✧', '✧', '⋆', '⋆', '·', '·'],
    colors: [white, '#f0c3ff', '#c77dff', '#7b2cbf'],
  },
  // Bigger, longer rings in gold, under an aurora of rising blocks.
  legendary: {
    glyphs: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
    sparks: ['✸', '✸', '✦', '✦', '✧', '✧', '⋆', '⋆', '·', '·'],
    colors: [white, '#fff1a8', gold, '#ff9f1c'],
  },
  // A level-up's sparks are the level's own gold and ember.
  level: { glyphs: [], sparks: ['✦', '✧', '✧', '·', '·'], colors: [white, '#ffe8a3', '#ffc857', '#e07a5f'] },
}

/** The legendary aurora's hues, west to east. */
export const aurora: ReadonlyArray<string> = [
  '#3ddc97',
  '#4ce0d2',
  '#4cc9f0',
  '#4895ef',
  '#7b6cf6',
  '#b388ff',
  '#f15bb5',
]

/** Stars that twinkle over the big takeovers. */
const twinkles: ReadonlyArray<string> = ['·', '⋆', '✧', '˚']

/** "Epic drop" as `E P I C   D R O P`: the takeovers' banner lettering. */
export const spaced = (text: string): string => [...text.toUpperCase()].join(' ').replace(/ {3}/g, '   ')

/** A number in [0, 1) that depends only on its inputs, so a frame drawn again is the same frame. */
export const hash = (...values: ReadonlyArray<number>): number => {
  let h = 0x2545f491
  for (const value of values) {
    h = Math.imul(h ^ Math.floor(value), 0x9e3779b1)
    h ^= h >>> 15
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
  }
  return (h >>> 0) / 4_294_967_296
}

// A grid of cells, for the frames that place glyphs by position.

type Grid = Array<Array<Cell>>

const gridOf = (width: number, height: number): Grid =>
  Array.from({ length: height }, () => Array.from({ length: width }, () => ({ char: ' ' })))

const isFree = (grid: Grid, x: number, y: number): boolean => grid[y]?.[x]?.char === ' '

/** Puts one glyph at a cell, if it fits whole; a glyph it covers half of goes too. */
const put = (grid: Grid, x: number, y: number, glyph: string, style: Style = {}): void => {
  const row = grid[y]
  const wide = isWide(glyph)
  if (row === undefined || x < 0 || x + (wide ? 1 : 0) >= row.length) return
  for (const at of wide ? [x, x + 1] : [x]) {
    if (row[at]?.char === '' && at > 0) row[at - 1] = { char: ' ' }
    if (row[at + 1]?.char === '') row[at + 1] = { char: ' ' }
  }
  row[x] = { char: glyph, ...style }
  if (wide) row[x + 1] = { char: '' }
}

/** Writes a text from a cell on, glyph by glyph. */
const write = (grid: Grid, x: number, y: number, text: string, style: Style | ((i: number) => Style) = {}): void => {
  let at = x
  for (const [i, glyph] of glyphsOf(text).entries()) {
    put(grid, at, y, glyph, typeof style === 'function' ? style(i) : style)
    at += isWide(glyph) ? 2 : 1
  }
}

/** Clears a stretch of a row, so sparks keep off the text written there. */
const clear = (grid: Grid, x: number, y: number, cells: number): void => {
  const row = grid[y]
  if (row === undefined) return
  for (let at = Math.max(0, x); at < Math.min(row.length, x + cells); at++) row[at] = { char: ' ' }
}

const rowsOf = (grid: Grid): Array<Row> => grid.map(runsOf)

const pick = <A>(items: ReadonlyArray<A>, i: number, fallback: A): A =>
  items[Math.max(0, Math.min(items.length - 1, i))] ?? fallback

const cycle = <A>(items: ReadonlyArray<A>, i: number, fallback: A): A =>
  items.length === 0 ? fallback : (items[((i % items.length) + items.length) % items.length] ?? fallback)

const ticksOf = (stage: Stage): number => scriptOf(stage.celebration, stage.motion).ticks

// The XP bar row: the bar as wide as the band leaves beside its label, in its look, and the flourishes that play on
// it.

/** The XP bar's cells for a band `columns` wide: the new XP shimmering on a gain, a fill and flash on a level-up. */
export const barRow = (
  view: BandView,
  columns: number,
  stage: Stage | null,
  look: BandLook | null = null,
  loop: Loop | null = null,
): Row => {
  const { cells, from, width, filled, full } = barCells(view, columns, look, loop)
  const track = cells.slice(from, from + width)
  const celebration = stage?.celebration
  if (stage !== null && celebration?.kind === 'xp') shimmer(track, filled, celebration.amount, view, stage, full)
  if (stage !== null && celebration?.kind === 'level' && stage.motion === 'full') fillAndFlash(track, stage.tick, full)
  return runsOf([...cells.slice(0, from), ...track, ...cells.slice(from + width)])
}

/** The cells the latest XP filled light up, a glint runs across them and a star twinkles at the bar's head. */
const shimmer = (
  cells: Array<Cell>,
  filled: number,
  amount: number,
  view: BandView,
  stage: Stage,
  full: string,
): void => {
  const { glyphs, colors } = looks.xp
  const gained = view.xp.forNextLevel === 0 ? 0 : Math.round((amount / view.xp.forNextLevel) * cells.length)
  // Ten cells at most, the head's star making the eleventh and twelfth: the in-band budget.
  const span = Math.min(filled, 10, Math.max(1, gained))
  const from = filled - span
  const last = ticksOf(stage) - 1
  const glint = stage.motion === 'full' ? from - 1 + Math.round((stage.tick * (span + 1)) / Math.max(1, last)) : -2
  const settled = stage.motion === 'full' && stage.tick === last
  for (let i = from; i < filled; i++) {
    const color = i === glint ? white : i === glint - 1 ? pick(colors, 1, white) : pick(colors, settled ? 3 : 2, white)
    cells[i] = { char: full, color, bold: true }
  }
  if (filled < cells.length) {
    const star = stage.motion === 'full' ? cycle(glyphs, stage.tick, '✦') : '✦'
    cells[filled] = { char: star, color: stage.tick % 2 === 0 ? '#ffffaf' : pick(colors, 1, white), bold: true }
  }
}

/** The bar fills up in three frames, flashes white then gold, and drops back to the new level's fill. */
const fillAndFlash = (cells: Array<Cell>, tick: number, full: string): void => {
  if (tick > 4) return
  const reach = tick < 3 ? Math.ceil((cells.length * (tick + 1)) / 3) : cells.length
  for (let i = 0; i < reach; i++) {
    const color = tick === 3 ? white : tick === 4 ? gold : i >= reach - 3 ? white : '#ffc857'
    cells[i] = { char: full, color, bold: true }
  }
}

// The in-band frame: beside the band's other pieces, where the latest gain shows, without any rows of its own.

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const articleOf = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a')

const nameOf = (celebration: Celebration): string =>
  celebration.kind === 'loot' ? celebration.name : celebration.kind === 'quest' ? 'Quest complete' : ''

const extras = (celebration: Celebration): Array<Run> => {
  const runs: Array<Run> = []
  if (celebration.kind === 'loot' && celebration.gold > 0)
    runs.push({ text: ` +${celebration.gold} gold`, color: gold, dim: true })
  if ((celebration.kind === 'loot' || celebration.kind === 'quest') && celebration.more > 0)
    runs.push({ text: ` · +${celebration.more} more`, dim: true })
  return runs
}

/**
 * What the gain's place shows while a celebration plays there: a common drop's coin spinning, an uncommon's
 * sparkles, or, when the band can't grow (`reduced`, or no rows to spare), a still frame of a bigger one. Null when
 * the celebration plays elsewhere: the XP bar, or rows of its own.
 */
export const slotRow = (stage: Stage, hasRows: boolean): Row | null => {
  const { celebration, tick } = stage
  if (celebration.kind === 'xp' || hasRows) return null
  const full = stage.motion === 'full'
  if (celebration.kind === 'level') {
    const title = celebration.title === null ? [] : [{ text: ` · ${celebration.title}`, color: '#ffc857' }]
    if (!full) {
      return [
        { text: `${celebration.glyph} `, color: 'claude', bold: true },
        { text: `Level ${celebration.to}!`, color: gold, bold: true },
        ...title,
      ]
    }
    // With no rows to grow by, the level ticks over in a white flash where the gain shows, sparks either side of it.
    const { sparks, colors } = looks.level
    const spark = (shift: number): Run => ({
      text: cycle(sparks, tick + shift, '✦'),
      color: cycle(colors, tick + shift, gold),
      bold: true,
    })
    return [
      spark(0),
      { text: ` ${celebration.glyph} `, color: 'claude', bold: true },
      { text: `Level ${tick >= 3 ? celebration.to : celebration.from}!`, color: tick === 3 ? white : gold, bold: true },
      ...title,
      { text: ' ' },
      spark(2),
    ]
  }
  const color = rarityColors[celebration.tier]
  const label = { text: ` · ${celebration.kind === 'quest' ? 'quest' : `${celebration.tier} drop`}`, dim: true }
  if (celebration.tier === 'common') {
    const { glyphs, sparks, colors } = looks.common
    const landed = !full || tick === ticksOf(stage) - 1
    const coin = landed ? cycle(sparks, 0, '◈') : cycle(glyphs, tick, '◐')
    return [
      { text: coin, color: landed ? gold : cycle(colors, tick, gold), bold: true },
      { text: ` ${nameOf(celebration)}`, color, bold: landed || tick >= 2 },
      label,
      ...extras(celebration),
    ]
  }
  const { glyphs, colors } = looks[celebration.tier === 'uncommon' ? 'uncommon' : celebration.tier]
  const left = full ? cycle(glyphs, tick, '✦') : '✦'
  const right = full ? cycle(glyphs, tick + 3, '✦') : '✦'
  return [
    { text: left, color: full ? cycle(colors, tick, color) : color, bold: true },
    { text: ` ${nameOf(celebration)} `, color, bold: true },
    { text: right, color: full ? cycle(colors, tick + 1, color) : color, bold: true },
    label,
    ...extras(celebration),
  ]
}

// The rows a big celebration grows the band by.

/** Rows each big celebration grows the band by at most, if the band has them to spare. */
const rowsWanted: Record<Tier, number> = { common: 0, uncommon: 0, rare: 4, epic: 8, legendary: 11 }
const minRows = 3

/**
 * The rows the band grows by for a rare, epic or legendary celebration in full motion: a chest that opens, or a
 * level banner, for rare; a burst of sparks over the band with the name in the middle for epic and legendary,
 * under an aurora for legendary. None when it plays in-band, or `room` is too small for it.
 */
export const stageRows = (stage: Stage, columns: number, room: number): Array<Row> => {
  const { celebration } = stage
  if (stage.motion !== 'full' || celebration.kind === 'xp' || isSmall(celebration)) return []
  const height = Math.min(rowsWanted[celebration.tier], room)
  if (height < minRows || columns < 30) return []
  if (celebration.tier !== 'rare') return burstRows(stage, columns, height)
  return celebration.kind === 'level'
    ? levelRows(stage, celebration, columns, height)
    : chestRows(stage, columns, height)
}

/** The chest, nine cells wide: a gold-trimmed lid, a wooden body with a gem in the rarity's color, and the base. */
const chest = { lid: '┏━━━━━━━┓', base: '┗━━━━━━━┛', wood: '▒▒▒', trim: '#d4a017', woodColor: '#a47148' }

const chestRows = (stage: Stage, columns: number, height: number): Array<Row> => {
  const { celebration, tick } = stage
  if (celebration.kind === 'xp' || celebration.kind === 'level') return []
  const { glyphs, sparks, colors } = looks.rare
  const grid = gridOf(columns, height)
  // With four rows the lid lifts into the top one; with three the light breaks out of a lid that stays.
  const top = height - 3
  const isOpen = tick >= 4
  // It rocks twice, then the gem flashes, then it opens.
  const x = 2 + (tick === 1 ? 1 : tick === 2 ? -1 : 0)
  const gem = tick === 3 ? white : rarityColors[celebration.tier]
  const lidRow = isOpen && top > 0 ? top - 1 : top
  write(grid, x, lidRow, chest.lid, { color: chest.trim, bold: true })
  if (isOpen) {
    // The light pours out of the open chest, brightest in the middle, pulsing.
    const light = [1, 2, 3, 3, 3, 2, 1].map((depth) => pick(glyphs, depth, '█'))
    write(grid, x, top, '┃', { color: chest.trim })
    write(grid, x + 1, top, light.join(''), (i) => ({
      color: pick(colors, Math.abs(i - 3) === 0 ? 0 : Math.abs(i - 3) <= 1 + (tick % 2) ? 1 : 2, white),
    }))
    write(grid, x + 8, top, '┃', { color: chest.trim })
  }
  const body = top + 1
  write(grid, x, body, '┃', { color: chest.trim })
  write(grid, x + 1, body, chest.wood, { color: chest.woodColor })
  write(grid, x + 4, body, '◆', { color: gem, bold: true })
  write(grid, x + 5, body, chest.wood, { color: chest.woodColor })
  write(grid, x + 8, body, '┃', { color: chest.trim })
  write(grid, x, body + 1, chest.base, { color: chest.trim })
  // Sparks rise out of the light, a few a frame, each burning out as it climbs.
  if (isOpen) {
    for (let j = 0; j < 10; j++) {
      const born = 4 + (j % 6)
      const age = tick - born
      if (age < 0 || age >= sparks.length) continue
      const sx = x + 4 + Math.round((hash(j, stage.seed) - 0.5) * 14)
      const sy = top - Math.floor(age / 2) - (j % 2)
      const spark = cycle(sparks, age, '·')
      if (isFree(grid, sx, sy)) put(grid, sx, sy, spark, { color: pick(colors, age + 1, white), bold: age === 0 })
    }
  }
  // The banner, then the name typed out once the lid is up, then the gold it brought.
  const textX = x + 15
  const banner = spaced(celebration.kind === 'quest' ? 'Quest' : 'Rare drop')
  write(grid, textX, Math.max(0, body - 1), banner, { color: rarityColors.rare, dim: !isOpen })
  const name = nameOf(celebration)
  if (isOpen) {
    const letters = glyphsOf(name)
    const shown = tick >= 8 ? letters.length : Math.ceil((letters.length * (tick - 3)) / 5)
    const typing = shown < letters.length
    const typed = `${typing ? ' ' : '✦'} ${letters.slice(0, shown).join('')}${typing ? '▌' : ''}`
    write(grid, textX, body, typed, (i) =>
      i === 0 ? { color: pick(colors, 1, white), bold: true } : { color: rarityColors.rare, bold: true },
    )
    // Typed out, it twinkles.
    const twinkle = tick % 2 === 0 ? '✦' : '✧'
    if (!typing) write(grid, textX + 3 + cellsOf(name), body, twinkle, { color: pick(colors, 1, white) })
    if (!typing && celebration.kind === 'loot' && celebration.gold > 0)
      write(grid, textX + 2, body + 1, `+${celebration.gold} gold`, { color: gold, dim: true })
  }
  return rowsOf(grid)
}

/** A rare level-up: sparks rise past a banner whose level ticks over, the glyph either side. */
const levelRows = (
  stage: Stage,
  celebration: Extract<Celebration, { kind: 'level' }>,
  columns: number,
  height: number,
): Array<Row> => {
  const { tick } = stage
  const { sparks, colors } = looks.level
  const grid = gridOf(columns, height)
  const banner = Math.min(height - 2, 1)
  const words = spaced('Level up')
  const x = 2
  const numberX = x + 4 + cellsOf(words) + 3
  // A column of sparks rises from the bottom row, each starting a frame after the last.
  const reach = Math.min(columns - 4, numberX + 14)
  for (let j = 0; j < 14; j++) {
    const age = tick - (j % 9)
    const sy = height - 1 - Math.floor(age * 0.75)
    if (age < 0 || sy < 0 || age > sparks.length) continue
    const sx = 1 + Math.floor(hash(j, stage.seed, 7) * reach)
    put(grid, sx, sy, cycle(sparks, age, '·'), { color: pick(colors, age, white), bold: age === 0 })
  }
  // The banner's letters arrive over the first frames; the number ticks over on the fourth, in a white flash.
  const letters = glyphsOf(words)
  const shown = Math.min(letters.length, Math.ceil((letters.length * (tick + 1)) / 3))
  const level = tick >= 3 ? celebration.to : celebration.from
  const after = numberX + cellsOf(`Lv ${level}`) + 2
  clear(grid, x - 1, banner, after + 4 - x)
  write(grid, x, banner, glyphSlot(celebration.glyph), { color: 'claude', bold: true })
  write(grid, x + 4, banner, letters.slice(0, shown).join(''), { color: 'claude', bold: true })
  write(grid, numberX, banner, `Lv ${level}`, { color: tick === 3 ? white : gold, bold: true })
  write(grid, after, banner, glyphSlot(celebration.glyph), { color: 'claude', bold: true })
  if (celebration.title !== null && tick >= 5) {
    const line = `You are now ${articleOf(celebration.title)} ${celebration.title}`
    clear(grid, x + 3, banner + 1, cellsOf(line) + 2)
    write(grid, x + 4, banner + 1, line, { color: '#ffc857' })
  }
  return rowsOf(grid)
}

/** The lines the burst frames around: a banner, the name, and one line under it. */
const burstText = (celebration: Celebration): { banner: string; name: string; under: string } => {
  if (celebration.kind === 'level') {
    const { title, evolved } = celebration
    const under = title !== null ? `You are now ${articleOf(title)} ${title}` : evolved ? 'Your pet evolved' : ''
    return { banner: spaced('Level up'), name: `Level ${celebration.to}`, under }
  }
  if (celebration.kind === 'quest') return { banner: spaced('Quest'), name: 'Quest complete', under: '' }
  if (celebration.kind === 'xp') return { banner: '', name: '', under: '' }
  const banner =
    celebration.tier === 'legendary'
      ? `★  ${spaced('Legendary drop')}  ★`
      : spaced(`${capitalised(celebration.tier)} drop`)
  return { banner, name: celebration.name, under: celebration.gold > 0 ? `+${celebration.gold} gold` : '' }
}

/**
 * Epic and legendary: rings of sparks burst out from the middle of the band one after another and burn out as they
 * fly, stars twinkle over the rest, and the name is revealed in a white flash, then shimmers. Legendary is taller,
 * longer, gold, and under an aurora.
 */
const burstRows = (stage: Stage, columns: number, height: number): Array<Row> => {
  const { celebration, tick, seed } = stage
  if (celebration.kind === 'xp') return []
  const isLegendary = celebration.tier === 'legendary'
  const look = celebration.kind === 'level' ? looks.level : looks[isLegendary ? 'legendary' : 'epic']
  const colors = look.colors
  const ticks = ticksOf(stage)
  const grid = gridOf(columns, height)
  const sky = isLegendary && height >= 6 ? 1 : 0
  const cy = sky + Math.floor((height - sky) / 2)
  const cx = Math.floor(columns / 2)
  // The rings: one every few frames, none in the last few, so the burst dies down before the band shrinks back.
  const every = isLegendary ? 3 : 4
  const sparksPerRing = isLegendary ? 22 : 16
  for (let launch = 0; launch < ticks - 6; launch += every) {
    const age = tick - launch
    if (age < 0 || age >= look.sparks.length) continue
    const spin = hash(launch, seed) * Math.PI * 2
    for (let j = 0; j < sparksPerRing; j++) {
      const angle = spin + (j / sparksPerRing) * Math.PI * 2
      const reach = (age + 1) * 0.12 * (0.8 + 0.4 * hash(launch, j, seed))
      const sx = Math.round(cx + Math.cos(angle) * reach * (columns / 2))
      const sy = Math.round(cy + Math.sin(angle) * reach * ((height - sky) / 1.6))
      if (sy < sky) continue
      const glyph = cycle(look.sparks, age, '·')
      put(grid, sx, sy, glyph, { color: pick(colors, Math.floor(age / 2), white), bold: age <= 1 })
    }
  }
  // Twinkling stars, thinning out over the last frames.
  const fade = Math.min(1, (ticks - tick) / 5)
  const density = (isLegendary ? 0.035 : 0.022) * fade
  for (let y = sky; y < height; y++) {
    for (let x = 0; x < columns; x++) {
      if (!isFree(grid, x, y) || hash(x, y, Math.floor(tick / 2), seed) >= density) continue
      const shade = 1 + Math.floor(hash(y, x, seed) * (colors.length - 1))
      const star = cycle(twinkles, Math.floor(hash(x, seed, y) * 4) + tick, '·')
      put(grid, x, y, star, { color: pick(colors, shade, white) })
    }
  }
  if (sky > 0) skyRow(grid, columns, tick, ticks)
  // The text, cleared of sparks around it: the banner first, the name in a flash, the line under it last.
  const text = burstText(celebration)
  const line = (y: number, value: string, style: Style | ((i: number) => Style)) => {
    const cells = cellsOf(value)
    const x = cx - Math.floor(cells / 2)
    clear(grid, x - 2, y, cells + 4)
    write(grid, x, y, value, style)
  }
  const accent = celebration.kind === 'level' ? gold : rarityColors[celebration.tier]
  if (tick >= 1 && cy - 1 >= sky) line(cy - 1, text.banner, { color: accent, bold: isLegendary })
  if (tick >= 3) {
    const glyph = celebration.kind === 'level' ? glyphSlot(celebration.glyph) : ''
    const name = celebration.kind === 'level' ? `${glyph} ${text.name} ${glyph}`.trim() : `✦  ${text.name}  ✦`
    // A highlight sweeps across the name; the reveal frame is all white.
    const sweep = (tick - 4) * 2
    const shade = (i: number) =>
      Math.abs(i - sweep) <= 1 ? white : Math.abs(i - sweep) === 2 ? pick(colors, 1, white) : accent
    line(cy, name, (i) => ({ color: tick === 3 ? white : shade(i), bold: true }))
  }
  if (tick >= 6 && text.under !== '' && cy + 1 < height)
    line(cy + 1, text.under, { color: celebration.kind === 'loot' ? gold : '#ffc857' })
  return rowsOf(grid)
}

/** The aurora along the top row: two waves in the blocks' heights, its hues drifting east, rising and setting. */
const skyRow = (grid: Grid, columns: number, tick: number, ticks: number): void => {
  const blocks = looks.legendary.glyphs
  const rise = Math.min(1, (tick + 1) / 3, (ticks - tick) / 3)
  for (let x = 0; x < columns; x++) {
    const wave = (Math.sin(x * 0.21 + tick * 0.7) + Math.sin(x * 0.083 - tick * 0.45)) / 2
    const level = Math.floor(((wave + 1) / 2) * (blocks.length - 1) * rise)
    const hue = cycle(aurora, Math.floor((x / columns) * aurora.length + tick * 0.35), '#4cc9f0')
    put(grid, x, 0, cycle(blocks, level, '▁'), { color: hue })
  }
}
