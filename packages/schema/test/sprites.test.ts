import { it } from "@effect/vitest"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import type { SpriteRun } from "../src/index.ts"
import { emptyCell, petSprite, spriteRuns } from "../src/index.ts"

// A sprite's runs, as properties over any grid: they draw the grid back cell for cell, never overlap or cover an empty
// cell, and each is as long as it can be.

const Width = 6
const Grid = Schema.Array(Schema.String.check(Schema.isPattern(new RegExp(`^[.abc]{${Width}}$`)))).check(
  Schema.isMaxLength(8),
)

/** The rows `runs` draw on a blank grid of `height` rows. */
const drawn = (runs: ReadonlyArray<SpriteRun>, height: number): Array<string> => {
  const rows = Array.from({ length: height }, () => Array.from({ length: Width }, () => emptyCell))
  for (const run of runs) {
    for (let x = run.x; x < run.x + run.width; x++) {
      expect(rows[run.y]![x], "runs never overlap").toBe(emptyCell)
      rows[run.y]![x] = run.cell
    }
  }
  return rows.map((row) => row.join(""))
}

describe("spriteRuns", () => {
  it.prop("draw the grid back, cell for cell", [Grid], ([rows]) => {
    expect(drawn(spriteRuns(rows), rows.length)).toEqual(rows)
  })

  it.prop("cover only drawn cells, each run as long as it can be", [Grid], ([rows]) => {
    const runs = spriteRuns(rows)
    for (const run of runs) expect(run.cell).not.toBe(emptyCell)
    for (const [one, next] of runs.slice(0, -1).map((run, i) => [run, runs[i + 1]!] as const)) {
      if (one.y === next.y && one.x + one.width === next.x) expect(next.cell).not.toBe(one.cell)
    }
  })

  it("draw the pet in its palette's colours only", () => {
    const runs = spriteRuns(petSprite.rows)
    expect(new Set(runs.map((run) => run.cell))).toEqual(new Set(Object.keys(petSprite.palette)))
    expect(new Set(petSprite.rows.map((row) => row.length))).toEqual(new Set([14]))
    expect(petSprite.rows).toHaveLength(12)
  })
})
