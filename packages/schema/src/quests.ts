import { Schema } from "effect"
import { Count, IsoDateTime } from "./primitives.ts"
import { ScoringFact } from "./rules.ts"

// Quest packs are plain JSON the server loads: from a folder on a local server, from the quest board on the public
// one. Packs hold data only, never code, so a community pack can't run anything on a player's machine.

export const QuestGoal = Schema.Struct({
  fact: ScoringFact,
  count: Count.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** Every filter given must match the fact. */
  filters: Schema.Struct({
    repoOwner: Schema.optionalKey(Schema.String),
    language: Schema.optionalKey(Schema.String),
    label: Schema.optionalKey(Schema.String),
    org: Schema.optionalKey(Schema.String),
  }),
})
export interface QuestGoal extends Schema.Schema.Type<typeof QuestGoal> {}

export const QuestDef = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** daily: 3 offered a day, pick 1; weekly: one verified goal; story: linked through `after`. */
  kind: Schema.Literals(["daily", "weekly", "story", "bounty", "seasonal"]),
  goal: QuestGoal,
  rewards: Schema.Struct({ xp: Count, gold: Count, itemIds: Schema.Array(Schema.String) }),
  /** Story chains: the quest in the same pack that must be completed first. */
  after: Schema.NullOr(Schema.String),
  /** Seasonal events and bounties run between these; null = no bound. */
  availableFrom: Schema.NullOr(IsoDateTime),
  availableUntil: Schema.NullOr(IsoDateTime),
})
export interface QuestDef extends Schema.Schema.Type<typeof QuestDef> {}

export const QuestPack = Schema.Struct({
  id: Schema.String,
  version: Count,
  title: Schema.String,
  quests: Schema.Array(QuestDef),
})
export interface QuestPack extends Schema.Schema.Type<typeof QuestPack> {}
