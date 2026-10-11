import { Schema } from "effect"
import { CommandName } from "./client-events.ts"
import { Count, IsoDateTime, ItemCategory, Percent, QualityDimension, Rarity } from "./primitives.ts"
import { ScoringFact } from "./rules.ts"

// Quest packs are plain JSON the server loads: from a folder on a local server, from the quest board on the public
// one. Packs hold data only, never code, so a community pack can't run anything on a player's machine. The daily and
// weekly quests are called missions.

const Goal = Count.pipe(Schema.check(Schema.isGreaterThan(0)))
const Score = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))

/** A scoring fact counted `count` times in the mission's window, each piece of work once, capped or not. */
export const FactGoal = Schema.Struct({
  kind: Schema.Literal("fact"),
  fact: ScoringFact,
  count: Goal,
  /** prompt.graded only: the least each named quality score must reach, as clarity 8 or more. */
  scores: Schema.optionalKey(Schema.Record(QualityDimension, Schema.optionalKey(Score))),
  /** prompt.graded only: the least the weighted grade must reach. */
  grade: Schema.optionalKey(Score),
}).check(
  Schema.makeFilter(
    (goal) =>
      goal.fact === "prompt.graded" ||
      (goal.scores === undefined && goal.grade === undefined) || { path: ["fact"], issue: "only a prompt has scores" },
  ),
)
export interface FactGoal extends Schema.Schema.Type<typeof FactGoal> {}

/** `/clear` used `count` times. */
export const ClearsGoal = Schema.Struct({ kind: Schema.Literal("clears"), count: Goal })
/** Compactions, of one trigger or either. */
export const CompactionsGoal = Schema.Struct({
  kind: Schema.Literal("compactions"),
  trigger: Schema.optionalKey(Schema.Literals(["manual", "auto"])),
  count: Goal,
})
/** A slash command run `count` times, by the name it ran under (not the stats' `custom` overflow). */
export const CommandGoal = Schema.Struct({ kind: Schema.Literal("command"), command: CommandName, count: Goal })
/** `count` sessions measured in the window whose context peak stays under `under` percent. */
export const ContextGoal = Schema.Struct({ kind: Schema.Literal("context"), under: Percent, count: Goal })

/** What a quest asks for: scoring facts, with filters a fact carries, or the player stats. */
export const QuestGoal = Schema.Union([FactGoal, ClearsGoal, CompactionsGoal, CommandGoal, ContextGoal])
export type QuestGoal = typeof QuestGoal.Type

/** A drop that always lands: `item` by id, else a roll at `rarity`, from one category when `pool` names it. */
export const QuestLoot = Schema.Struct({
  rarity: Rarity,
  pool: Schema.optionalKey(ItemCategory),
  item: Schema.optionalKey(Schema.String),
})
export interface QuestLoot extends Schema.Schema.Type<typeof QuestLoot> {}

/** What completing a quest grants, each as its own server event. Every kind is optional, so new kinds join as keys. */
export const QuestRewards = Schema.Struct({
  xp: Schema.optionalKey(Count),
  gold: Schema.optionalKey(Count),
  loot: Schema.optionalKey(QuestLoot),
})
export interface QuestRewards extends Schema.Schema.Type<typeof QuestRewards> {}

/** daily and weekly are the missions; chains, bounties and seasonal quests are not offered yet. */
export const QuestCadence = Schema.Literals(["daily", "weekly", "chain", "bounty", "seasonal"])
export type QuestCadence = typeof QuestCadence.Type

/** The cadences the engine offers: a mission runs for a local day or a local week, Monday to Sunday. */
export const MissionCadence = Schema.Literals(["daily", "weekly"])
export type MissionCadence = typeof MissionCadence.Type

export const QuestDef = Schema.Struct({
  /** Unique in its pack. */
  id: Schema.String,
  title: Schema.String,
  /** Shown as is in the missions pane. */
  description: Schema.optionalKey(Schema.String),
  lore: Schema.optionalKey(Schema.String),
  cadence: QuestCadence,
  goal: QuestGoal,
  rewards: QuestRewards,
  /** Offered only in a window that starts in [availableFrom, availableUntil); a missing bound is no bound. */
  availableFrom: Schema.optionalKey(IsoDateTime),
  availableUntil: Schema.optionalKey(IsoDateTime),
})
export interface QuestDef extends Schema.Schema.Type<typeof QuestDef> {}

export const QuestPack = Schema.Struct({
  id: Schema.String,
  version: Count,
  title: Schema.String,
  quests: Schema.Array(QuestDef),
}).check(
  Schema.makeFilter((pack) => {
    const ids = pack.quests.map((quest) => quest.id)
    return new Set(ids).size === ids.length || { path: ["quests"], issue: "quest ids must be unique in a pack" }
  }),
)
export interface QuestPack extends Schema.Schema.Type<typeof QuestPack> {}

/** A mission as the mod draws it: the pack's words and numbers with the player's progress. */
export const QuestState = Schema.Struct({
  questId: Schema.String,
  packId: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  cadence: QuestCadence,
  /** auto: runs on its own (dailies); pick: offered, waiting to be accepted (weeklies, up to the rules' number). */
  start: Schema.Literals(["auto", "pick"]),
  /** offered = waiting to be picked; expired = its window ended before the server rolled the next one. */
  status: Schema.Literals(["offered", "active", "completed", "expired"]),
  progress: Count,
  goal: Count,
  rewards: QuestRewards,
  /** When its window ends: the next local midnight, or the one that starts the next local week. */
  expiresAt: Schema.NullOr(IsoDateTime),
})
export interface QuestState extends Schema.Schema.Type<typeof QuestState> {}
