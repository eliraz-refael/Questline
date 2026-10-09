import type { OwnedPet, PlayerState, RulesConfig } from "@questline/schema"
import { daysBetween } from "./days.ts"
import { type LevelProgress, levelForXp } from "./level.ts"

// What the state doesn't store, worked out under the rules in force: a rules change moves these without a migration.

export const totalXp = (state: PlayerState): number => state.progress.xp.verified + state.progress.xp.reported

export const levelOf = (state: PlayerState, rules: RulesConfig): LevelProgress =>
  levelForXp(rules.levelCurve, totalXp(state) - state.progress.prestigeXp)

/** The title of the highest band reached; below the first band, the first band's title. */
export const titleFor = (rules: RulesConfig, level: number): string => {
  let title = rules.titles[0]?.title ?? ""
  for (const band of rules.titles) if (band.fromLevel <= level) title = band.title
  return title
}

/** Evolution stages a level unlocks: 0, then one more per `evolveAt` level reached. */
export const formsFor = (rules: RulesConfig, level: number): ReadonlyArray<number> => [
  0,
  ...rules.pet.evolveAt.filter((at) => at <= level).map((_, i) => i + 1),
]

/** The highest evolution stage a level unlocks: the last of `formsFor`. */
export const formFor = (rules: RulesConfig, level: number): number => rules.pet.evolveAt.filter((at) => at <= level).length

/** Mood decayed from its stored value to `now`. */
export const moodNow = (pet: OwnedPet, rules: RulesConfig, now: string): number =>
  Math.min(100, Math.max(0, pet.mood.value - rules.pet.moodDecayPerDay * daysBetween(pet.mood.at, now)))
