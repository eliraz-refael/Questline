// The pixel pet, as the landing page (site/index.html) and the profile pages draw it: a grid of cells, one letter
// each, "." for none, and a colour per letter. The site keeps its own copy, since it is a static page with no build;
// engine/test/site.test.ts checks the two stay the same.
//
//   rows ─▶ spriteRuns ─▶ [{x, y, width, cell}]   each row's runs of one letter, "." left out
//                            └─▶ one <rect> each, filled from the palette (server/html.ts spriteSvg)

/** A sprite: its rows, each the same length, and the colour of each letter they use. */
export interface Sprite {
  readonly rows: ReadonlyArray<string>
  readonly palette: Readonly<Record<string, string>>
}

/** The pet, 14 by 12: every species draws as it for now. */
export const petSprite: Sprite = {
  rows: [
    "..o........o..",
    ".obo......obo.",
    ".obbo....obbo.",
    ".obbboooobbbo.",
    "obbbbbbbbbbbbo",
    "obbewbbbbewbbo",
    "obbeebbbbeebbo",
    "obcbbbbbbbbcbo",
    "obbbbllllbbbbo",
    ".obbbllllbbbo.",
    "..obbbbbbbbo..",
    "...oo....oo...",
  ],
  palette: { o: "#2a1f4a", b: "#9d8cff", l: "#d9d0ff", e: "#14101f", w: "#ffffff", c: "#ff8fb1" },
}

/** The letter of a cell with nothing drawn. */
export const emptyCell = "."

/** A run of cells of one letter along a row. */
export interface SpriteRun {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly cell: string
}

/** Each row's runs of one letter, left to right and top to bottom; empty cells make none. */
export const spriteRuns = (rows: ReadonlyArray<string>): ReadonlyArray<SpriteRun> =>
  rows.flatMap((row, y) =>
    [...row.matchAll(/(.)\1*/gsu)].flatMap((match) =>
      match[1] === emptyCell ? [] : [{ x: match.index, y, width: match[0].length, cell: match[1]! }]
    )
  )
