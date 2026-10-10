import { Schema, Struct, Tuple } from "effect"
import { ClaimState, InventoryEntry, ItemDef, Pet, Pity, PlayerStats } from "./domain.ts"
import { Count, Glyph, IsoDateTime, Rarity, Slot, Ulid, XpTier } from "./primitives.ts"

// Server events are the outcomes the mod renders, numbered by a per-player seq that only goes up. Each one below
// is the draft the rules engine emits; the write path adds the envelope as it appends the draft to the stream.
//
// Celebrations carry a `tier`, common to legendary: the mod maps it to an animation and plays a group of events
// with the same cause at the highest tier among them, so it hard-codes no rarity rules.

/** How big a celebration is. */
const tier = Rarity

const serverEvent = <Type extends string, Data extends Schema.Struct.Fields>(type: Type, data: Data) =>
  Schema.Struct({ type: Schema.Literal(type), data: Schema.Struct(data) })

/** Fills the XP bar, floats "+120 XP". */
export const XpGranted = serverEvent("xp.granted", {
  amount: Count,
  tier: XpTier,
  reason: Schema.String,
  totalAfter: Count,
})
/** Dim note: daily cap reached for that event. */
export const XpCapped = serverEvent("xp.capped", { eventType: Schema.String, cap: Count })
/** Plays the equipped level-up effect, then the banner. */
export const LevelUp = serverEvent("level.up", {
  from: Count,
  to: Count,
  tier,
  /** The level glyph at `to`, which the celebration shows. */
  glyph: Glyph,
  title: Schema.optionalKey(Schema.String),
  evolution: Schema.optionalKey(Count),
})
/** The pet holds the item up; a rarity-coloured toast. */
export const LootDropped = serverEvent("loot.dropped", {
  entry: InventoryEntry,
  item: ItemDef,
  gold: Count,
  pity: Pity,
  tier,
})
/** Updates the gold counter. */
export const GoldChanged = serverEvent("gold.changed", { delta: Schema.Int, totalAfter: Count, reason: Schema.String })
/** A pending, verified, rejected or expired claim, shown in the quest log. */
export const ClaimUpdated = serverEvent("claim.updated", ClaimState.fields)
/** Ticks the quest's bar. */
export const QuestProgress = serverEvent("quest.progress", { questId: Schema.String, progress: Count, goal: Count })
/** Quest banner; the rewards arrive as their own events. */
export const QuestCompleted = serverEvent("quest.completed", {
  questId: Schema.String,
  tier,
  // Not specified in the design doc yet: what the banner lists before the reward events arrive.
  rewards: Schema.Array(Schema.String),
})
/** Achievement banner. */
export const AchievementUnlocked = serverEvent("achievement.unlocked", {
  achievementId: Schema.String,
  title: Schema.String,
})
/** The egg hatches: the sprite appears. */
export const PetHatched = serverEvent("pet.hatched", Pet.fields)
/** Redraws the sprite. */
export const PetChanged = serverEvent("pet.changed", {
  mood: Schema.optionalKey(Pet.fields.mood),
  form: Schema.optionalKey(Pet.fields.form),
  equipped: Schema.optionalKey(Pet.fields.equipped),
})
/** An item went into its slot, replacing what was there: a band style redraws its part of the band. */
export const ItemEquipped = serverEvent("item.equipped", { slot: Slot, entryId: Ulid })
/** A slot was emptied: the band draws its own look there again. */
export const ItemUnequipped = serverEvent("item.unequipped", { slot: Slot })
/** Streak flame in the band. */
export const StreakChanged = serverEvent("streak.changed", { days: Count, restDaysLeftThisWeek: Count })
/** Fetch `GET /v1/rules/{version}` and swap the config; no reload needed. */
export const RulesUpdated = serverEvent("rules.updated", { version: Count })
/** A server message (maintenance, update the mod). */
export const Notice = serverEvent("notice", { level: Schema.Literals(["info", "warning"]), text: Schema.String })
/** A rebalance changed XP: redraws the bar, no floating number. */
export const XpRecomputed = serverEvent("xp.recomputed", {
  verified: Count,
  reported: Count,
  totalAfter: Count,
  rulesVersion: Count,
})
/** A rebalance moved the level down; a quiet update, no banner. */
export const LevelChanged = serverEvent("level.changed", { from: Count, to: Count, title: Schema.String })
/** A quiet update of the stats in the pane: only the parts that changed. */
export const StatsChanged = serverEvent("stats.changed", {
  stats: PlayerStats.mapFields(Struct.map(Schema.optionalKey)),
})

export const ServerEventDraft = Schema.Union([
  XpGranted,
  XpCapped,
  LevelUp,
  LootDropped,
  GoldChanged,
  ClaimUpdated,
  QuestProgress,
  QuestCompleted,
  AchievementUnlocked,
  PetHatched,
  PetChanged,
  ItemEquipped,
  ItemUnequipped,
  StreakChanged,
  RulesUpdated,
  Notice,
  XpRecomputed,
  LevelChanged,
  StatsChanged,
])
export type ServerEventDraft = typeof ServerEventDraft.Type

export const ServerEvent = ServerEventDraft.mapMembers(
  Tuple.map(
    Schema.fieldsAssign({
      seq: Count,
      at: IsoDateTime,
      /** The client event or command id that led to it, if any; events sharing a cause play as one celebration. */
      cause: Schema.NullOr(Ulid),
    }),
  ),
)
export type ServerEvent = typeof ServerEvent.Type
export type ServerEventType = ServerEvent["type"]
