import type { BandLook, BandView, Loop } from '../types'
import type { Cell, Row, Run, Style } from './cells'
import { cellsOf, glyphSlot, runsOf } from './cells'
import type { Parts } from './looks'
import { markCell, partsOf, sheenCells } from './looks'
import { bar } from './view'

// The band's pieces, each drawn from a look: the XP bar, the level, the top edge and the gold. The band and the pane's
// previews draw with these same functions, so a preview is what the band will show.

const cellOf = (char: string, style: Style, bold?: boolean): Cell => ({ char, ...style, ...(bold ? { bold } : {}) })

/** Lays a frame's marks over a track of cells: each recolors its cell, or draws its glyph there. */
const markTrack = (cells: Array<Cell>, from: number, length: number, parts: Parts): void => {
  for (const mark of parts.marks) {
    const at = markCell(mark, length)
    const cell = at === null ? undefined : cells[from + at]
    if (at === null || cell === undefined) continue
    const glyph = mark.glyph !== undefined && cellsOf(mark.glyph) === 1 ? mark.glyph : cell.char
    const style = mark.color === undefined ? styleOfCell(cell) : { color: mark.color }
    cells[from + at] = { char: glyph, ...style, bold: true }
  }
}

/** Lights the first `span` cells of a track with the look's sheen where it is now, keeping their glyphs. */
const sheenTrack = (cells: Array<Cell>, from: number, span: number, parts: Parts): void => {
  if (parts.sheen === null) return
  for (const lit of sheenCells(parts.sheen.sheen, parts.sheen.tick, span)) {
    const cell = cells[from + lit.at]
    if (cell === undefined) continue
    cells[from + lit.at] = { char: cell.char, color: lit.color, ...(lit.isHead ? { bold: true } : {}) }
  }
}

const styleOfCell = (cell: Cell): Style => ({
  ...(cell.color === undefined ? {} : { color: cell.color }),
  ...(cell.dim === undefined ? {} : { dim: cell.dim }),
})

/** The XP bar's label, at its end. */
export const barLabel = (view: BandView): string => ` ${view.xp.intoLevel}/${view.xp.forNextLevel} xp`

/** The XP bar's cells for a band `columns` wide, and where the bar itself runs among them, between the caps. */
export type BarCells = { cells: Array<Cell>; from: number; width: number; filled: number; full: string }

export const barCells = (view: BandView, columns: number, look: BandLook | null, loop: Loop | null): BarCells => {
  const parts = partsOf('xpBar', look, loop)
  const left = parts.glyph('left')
  const right = parts.glyph('right')
  const total = Math.max(10, columns - cellsOf(barLabel(view)))
  const from = left === undefined ? 0 : 1
  const width = Math.max(1, total - from - (right === undefined ? 0 : 1))
  const { filled } = bar(view, width)
  const full = parts.glyph('full', '▰') ?? '▰'
  const empty = parts.glyph('empty', '▱') ?? '▱'
  const head = parts.glyph('head')
  const cells: Array<Cell> = []
  if (left !== undefined) cells.push(cellOf(left, parts.style('left')))
  for (let i = 0; i < width; i++) {
    if (i < filled) cells.push(cellOf(full, parts.style('full')))
    else if (i === filled && head !== undefined) cells.push(cellOf(head, parts.style('head'), true))
    else cells.push(cellOf(empty, parts.style('empty')))
  }
  if (right !== undefined) cells.push(cellOf(right, parts.style('right')))
  // The sheen lights the XP earned, not the bar still to fill.
  sheenTrack(cells, from, filled, parts)
  markTrack(cells, from, width, parts)
  return { cells, from, width, filled, full }
}

/** The label run, in the look's color. */
export const labelRun = (view: BandView, look: BandLook | null): Run => ({
  text: barLabel(view),
  ...partsOf('xpBar', look, null).style('label'),
})

/** The level glyph, then "Lv" and the level between the look's brackets, then the title. */
export const levelRow = (view: BandView, look: BandLook | null, loop: Loop | null): Row => {
  const parts = partsOf('levelDisplay', look, loop)
  const left = parts.glyph('left')
  const right = parts.glyph('right')
  // A view kept in the session's state from before glyphs has none until the snapshot comes in.
  const glyph = view.glyph || '⚔'
  const runs: Array<Run> = [{ text: `${glyphSlot(glyph)} `, ...parts.style('glyph'), bold: true }]
  if (left !== undefined) runs.push({ text: left, ...parts.style('left'), bold: true })
  runs.push({ text: `${parts.text('lv', 'Lv')} ${view.level}`, ...parts.style('level'), bold: true })
  if (right !== undefined) runs.push({ text: right, ...parts.style('right'), bold: true })
  runs.push({ text: ` ${view.title}`, ...parts.style('title') })
  return runs
}

/** The gold's icon and amount, and the look's spark after them. */
export const goldRow = (view: BandView, look: BandLook | null, loop: Loop | null): Row => {
  const parts = partsOf('goldDisplay', look, loop)
  const spark = parts.glyph('spark')
  const runs: Array<Run> = [
    { text: parts.glyph('icon', '◈') ?? '◈', ...parts.style('icon') },
    { text: ` ${view.gold}`, ...parts.style('amount') },
  ]
  if (spark !== undefined) runs.push({ text: ` ${spark}`, ...parts.style('spark') })
  return runs
}

const title = 'QUESTLINE'

/**
 * The band's top edge, `columns` cells wide: a title tab, then a run of line with a knot every so often, the look's
 * marks along it. Every glyph is one cell wide, so the pieces add up to `columns` exactly.
 */
export const edgeRow = (columns: number, look: BandLook | null, loop: Loop | null): Row => {
  const parts = partsOf('topEdge', look, loop)
  const glyph = (part: string, fallback: string) => parts.glyph(part, fallback) ?? fallback
  const line = cellOf(glyph('line', '─'), parts.style('line'))
  const tab = 4 + title.length + 4
  if (columns < tab + 2) return runsOf(Array.from({ length: columns }, () => line))
  const star = cellOf(glyph('star', '✦'), parts.style('star'), true)
  const space: Cell = { char: ' ' }
  const cells: Array<Cell> = [line, line, cellOf(glyph('left', '┤'), parts.style('left')), space]
  cells.push(star, space, ...[...title].map((char) => cellOf(char, parts.style('title'), true)), space, star)
  cells.push(space, cellOf(glyph('right', '├'), parts.style('right')))
  const dot = cellOf(glyph('dot', '·'), parts.style('dot'))
  const motif = [...Array.from({ length: 10 }, () => line), dot, cellOf(glyph('knot', '✧'), parts.style('knot')), dot]
  const from = cells.length
  for (let i = 0; cells.length < columns; i++) cells.push(motif[i % motif.length] ?? line)
  sheenTrack(cells, from, columns - from, parts)
  markTrack(cells, from, columns - from, parts)
  return runsOf(cells)
}
