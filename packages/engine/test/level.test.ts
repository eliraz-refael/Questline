import { describe, expect, it } from "vitest"
import { levelForXp, xpForLevel } from "../src/index.ts"

const curve = { base: 100, exponent: 1.6 }

describe("xpForLevel", () => {
  it("follows 100 x L^1.6, rounded down", () => {
    expect([0, 1, 2, 10, 100].map((level) => xpForLevel(curve, level))).toEqual([0, 100, 303, 3981, 158489])
  })
})

describe("levelForXp", () => {
  it("starts at level 0", () => {
    expect(levelForXp(curve, 0)).toEqual({ level: 0, intoLevel: 0, forNextLevel: 100 })
  })

  it("treats a negative total as 0 instead of returning NaN", () => {
    expect(levelForXp(curve, -5)).toEqual({ level: 0, intoLevel: 0, forNextLevel: 100 })
  })

  it("reaches a level exactly at its threshold, not one XP before", () => {
    for (let level = 1; level <= 300; level++) {
      const threshold = xpForLevel(curve, level)
      expect(levelForXp(curve, threshold).level).toBe(level)
      expect(levelForXp(curve, threshold - 1).level).toBe(level - 1)
    }
  })

  it("splits the total into the current level and the gap to the next", () => {
    const progress = levelForXp(curve, 500)
    expect(progress).toEqual({ level: 2, intoLevel: 500 - 303, forNextLevel: xpForLevel(curve, 3) - 303 })
  })
})
