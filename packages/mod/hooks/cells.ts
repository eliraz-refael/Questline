// Cells and styled runs: the band lays its pieces out by cells, and an emoji takes two. Every row the band draws
// is a list of runs, each a stretch of text in one style.

/** A stretch of text in one style. */
export type Run = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Row = ReadonlyArray<Run>

export type Style = { color?: string; bold?: boolean; dim?: boolean }
/** One cell of a row; `''` is the right half of a wide glyph. */
export type Cell = Style & { char: string }

export const isWide = (glyph: string): boolean => {
  const code = glyph.codePointAt(0) ?? 0
  return (
    glyph.includes('\uFE0F') ||
    code >= 0x1f000 ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  )
}

/** The glyphs of a text as it draws them: a selector or a joiner stays with the glyph before it. */
export const glyphsOf = (text: string): Array<string> => {
  const glyphs: Array<string> = []
  let joining = false
  for (const char of text) {
    const last = glyphs.length - 1
    if (last >= 0 && (joining || char === '\uFE0F' || char === '\u200D')) glyphs[last] += char
    else glyphs.push(char)
    joining = char === '\u200D'
  }
  return glyphs
}

export const cellsOf = (text: string): number =>
  glyphsOf(text).reduce((cells, glyph) => cells + (isWide(glyph) ? 2 : 1), 0)

/** The level glyph in a slot two cells wide, so the band doesn't shift when a one-cell glyph turns into an emoji. */
export const glyphSlot = (glyph: string): string => `${glyph}${' '.repeat(Math.max(0, 2 - cellsOf(glyph)))}`

export const sameStyle = (a: Style, b: Style): boolean => a.color === b.color && a.bold === b.bold && a.dim === b.dim

export const styleOf = (cell: Cell): Style => ({
  ...(cell.color === undefined ? {} : { color: cell.color }),
  ...(cell.bold === undefined ? {} : { bold: cell.bold }),
  ...(cell.dim === undefined ? {} : { dim: cell.dim }),
})

/**
 * A run of cells as styled runs, the blank end left off; spaces keep no style, so they join either side. A blank
 * row is one space, so it still takes its row.
 */
export const runsOf = (cells: ReadonlyArray<Cell>): Row => {
  let end = cells.length
  while (end > 0 && (cells[end - 1]?.char === ' ' || cells[end - 1]?.char === '')) end--
  const runs: Array<Run> = []
  for (const cell of cells.slice(0, end)) {
    if (cell.char === '') continue
    const style = cell.char === ' ' ? {} : styleOf(cell)
    const last = runs[runs.length - 1]
    if (last !== undefined && (cell.char === ' ' || sameStyle(last, style))) last.text += cell.char
    else runs.push({ text: cell.char, ...style })
  }
  return runs.length === 0 ? [{ text: ' ' }] : runs
}

