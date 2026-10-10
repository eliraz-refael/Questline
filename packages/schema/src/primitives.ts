import { Schema } from "effect"

// Shared scalars of the wire format: ids are ULIDs, times are ISO 8601 strings, money-like numbers are integers.

export const Ulid = Schema.String.pipe(Schema.check(Schema.isULID()))

export const IsoDateTime = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u)),
)

export const IsoDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)))

/** `owner/name` of a GitHub repo, in GitHub's character set so a local path can't pass for one. */
export const GitHubRepo = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u)),
)

/** SHA-1, or SHA-256 in repos created with `--object-format=sha256`. */
export const GitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)))

export const Count = Schema.Natural

export const Probability = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))

/** A share of something in percent, 0-100: how full the context is. */
export const Percent = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))

/** A character or pet name. */
export const Name = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)))

// Enums the mod reads are open on the wire: a newer server may send a value an older mod doesn't know, and the
// mod renders it with a fallback. The schemas stay closed because the server validates what it accepts.

export const Rarity = Schema.Literals(["common", "uncommon", "rare", "epic", "legendary"])
export type Rarity = typeof Rarity.Type

export const PetSlot = Schema.Literals(["head", "neck", "back", "hand", "aura"])
export type PetSlot = typeof PetSlot.Type

export const CharacterSlot = Schema.Literals(["levelUpEffect", "scene"])
export type CharacterSlot = typeof CharacterSlot.Type

export const Slot = Schema.Union([PetSlot, CharacterSlot])
export type Slot = typeof Slot.Type

export const XpTier = Schema.Literals(["verified", "reported"])
export type XpTier = typeof XpTier.Type

/** The scores that make a prompt's quality, and so its XP, each 0-10 against what the prompt needs. */
export const QualityDimension = Schema.Literals([
  "clarity",
  "grammar",
  "specificity",
  "instructive",
  "context",
  "doneCriteria",
  "focus",
])
export type QualityDimension = typeof QualityDimension.Type

/** Everything the prompt grader scores: the quality, plus `regret`, which only the player stats count. */
export const GradeDimension = Schema.Literals([...QualityDimension.literals, "regret"])
export type GradeDimension = typeof GradeDimension.Type
