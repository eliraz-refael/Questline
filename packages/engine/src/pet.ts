import type { OwnedPet, RulesConfig } from "@questline/schema"
import { moodNow } from "./derive.ts"

// Caring for the pet: food, a pat, and the player's wins lift its mood, which drifts down slowly on its own. A happy
// pet adds to the flat XP boosts; a sad one only looks sleepy. It never gets sick, leaves or dies, nothing is lost when
// its mood is low, and petting it more than a few times an hour adds nothing, so care is a bonus, never a chore.

const hourMs = 3_600_000

/** The pet with its mood lifted by `amount` from where it has drifted to by `now`, at most 100. */
export const lifted = (pet: OwnedPet, rules: RulesConfig, now: string, amount: number): OwnedPet => ({
  ...pet,
  mood: { value: Math.min(100, moodNow(pet, rules, now) + amount), at: now },
})

/** The pats of the last hour, as of `now`. */
const recentPats = (pet: OwnedPet, now: string): ReadonlyArray<string> =>
  pet.petted.filter((at) => Date.parse(now) - Date.parse(at) < hourMs)

/**
 * A pat at `now`: it lifts the mood while the hour has pats left, and is kept so the hour counts it; past them it
 * lifts nothing. `gained` is how much the mood rose.
 */
export const patted = (
  pet: OwnedPet,
  rules: RulesConfig,
  now: string,
): { readonly pet: OwnedPet; readonly gained: number } => {
  const { care } = rules.pet
  const recent = recentPats(pet, now)
  if (recent.length >= care.pettedPerHour) return { pet: { ...pet, petted: [...recent] }, gained: 0 }
  const before = moodNow(pet, rules, now)
  const next = lifted({ ...pet, petted: [...recent, now] }, rules, now, care.petted)
  return { pet: next, gained: next.mood.value - before }
}
