import type { LevelCurve } from "@questline/schema"

/** Total XP needed to reach `level`: base * level^exponent, rounded down. Level 0 needs none. */
export const xpForLevel = (curve: LevelCurve, level: number): number => Math.floor(curve.base * level ** curve.exponent)

export interface LevelProgress {
  readonly level: number
  /** XP earned since the current level was reached. */
  readonly intoLevel: number
  /** XP between the current level and the next one. */
  readonly forNextLevel: number
}

/** The level a total XP reaches, and how far it is into that level. A negative total counts as 0. */
export const levelForXp = (curve: LevelCurve, xp: number): LevelProgress => {
  const total = Math.max(0, xp)
  // Invert the curve, then step to the exact level: the float inverse can land one off near a boundary.
  let level = Math.max(0, Math.floor((total / curve.base) ** (1 / curve.exponent)))
  while (level > 0 && xpForLevel(curve, level) > total) level--
  while (xpForLevel(curve, level + 1) <= total) level++
  const floor = xpForLevel(curve, level)
  return { level, intoLevel: total - floor, forNextLevel: xpForLevel(curve, level + 1) - floor }
}
