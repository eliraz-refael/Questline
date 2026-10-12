import { Schema, Struct, Tuple } from "effect"
import { ClaimState, InventoryEntry, ItemDef, Pet, Pity, PlayerStats } from "./domain.ts"
import { Count, Glyph, IsoDateTime, Multiplier, Name, Rarity, Slot, Ulid, XpTier } from "./primitives.ts"
import { MissionCadence, QuestRewards, QuestState } from "./quests.ts"
import { Egg } from "./rules.ts"

// Server events are the outcomes the mod renders, numbered by a per-player seq that only goes up. Each one below
// is the draft the rules engine emits; the write path adds the envelope as it appends the draft to the stream.
//
// Celebrations carry a `tier`, common to legendary: the mod maps it to an animation and plays a group of events
// with the same cause at the highest tier among them, so it hard-codes no rarity rules.

/** How big a celebration is. */
const tier = Rarity

const serverEvent = <Type extends string, Data extends Schema.Struct.Fields>(type: Type, data: Data) =>
  Schema.Struct({ type: Schema.Literal(type), data: Schema.Struct(data) })

/**
 * Fills the XP bar, floats "+120 XP". `reason` is the scoring fact, `quest` for a quest's reward, or `dev` for XP a
 * dev command granted. A graded prompt's grant names the weighted grade (0-10) that priced it, and the multiplier of
 * the sigil worn then, when one was.
 */
export const XpGranted = serverEvent("xp.granted", {
  amount: Count,
  tier: XpTier,
  reason: Schema.String,
  totalAfter: Count,
  grade: Schema.optionalKey(Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))),
  sigil: Schema.optionalKey(Multiplier),
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
/**
 * Updates the gold counter. `reason`: `drop`, `quest` for a quest's reward, `shop` for a purchase, `reroll` for a
 * duplicate re-rolled, or `dev` for gold a dev command set.
 */
export const GoldChanged = serverEvent("gold.changed", { delta: Schema.Int, totalAfter: Count, reason: Schema.String })
/** A pending, verified, rejected or expired claim, shown in the quest log. */
export const ClaimUpdated = serverEvent("claim.updated", ClaimState.fields)
/**
 * A local day's dailies, already running, or a local week's weeklies to pick from: they replace that cadence's
 * missions in the pane. An empty set says the old window's missions are gone and nothing new is offered.
 */
export const QuestOffered = serverEvent("quest.offered", { cadence: MissionCadence, quests: Schema.Array(QuestState) })
/** A weekly picked: it runs from now on. */
export const QuestAccepted = serverEvent("quest.accepted", { quest: QuestState })
/** A running weekly given up: back on offer, its progress gone. */
export const QuestAbandoned = serverEvent("quest.abandoned", { quest: QuestState })
/** Ticks the quest's bar. */
export const QuestProgress = serverEvent("quest.progress", { questId: Schema.String, progress: Count, goal: Count })
/**
 * Quest banner, named by its title; the rewards arrive as their own events (`xp.granted`, `gold.changed` with reason
 * `quest`, `loot.dropped`), and `rewards` says what the quest promised, for the banner to list before they play.
 */
export const QuestCompleted = serverEvent("quest.completed", {
  questId: Schema.String,
  title: Schema.String,
  tier,
  rewards: QuestRewards,
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
/**
 * Food the pet ate: its mood now and what the meal lifted it by, and the XP boost the food started, which only XP food
 * does; a treat only lifts the mood.
 */
export const PetFed = serverEvent("pet.fed", {
  entryId: Ulid,
  itemId: Schema.String,
  name: Schema.String,
  mood: Pet.fields.mood,
  gained: Schema.optionalKey(Schema.Finite),
  xpBoost: Schema.optionalKey(Schema.Struct({ pct: Count, minutes: Count })),
})
/** A pat: the mood it lifted (0 once the hour's pats are spent) and the mood now. */
export const PetPetted = serverEvent("pet.petted", { mood: Pet.fields.mood, gained: Schema.Finite })
/** One of today's offers bought: the new entry, its definition and the gold it cost. */
export const ShopBought = serverEvent("shop.bought", {
  offerId: Schema.String,
  entry: InventoryEntry,
  item: ItemDef,
  price: Count,
})
/**
 * A duplicate traded in, with gold, for another item of its rarity: what went, what came and the gold. It celebrates as
 * a drop of its `tier`.
 */
export const ItemRerolled = serverEvent("item.rerolled", {
  from: Schema.Struct({ entryId: Ulid, itemId: Schema.String, name: Schema.String }),
  entry: InventoryEntry,
  item: ItemDef,
  price: Count,
  tier,
})
/** A duplicate broken into shards of its rarity: the shards it gave and how many of that rarity the player now has. */
export const ItemSalvaged = serverEvent("item.salvaged", {
  entryId: Ulid,
  itemId: Schema.String,
  name: Schema.String,
  rarity: Rarity,
  shards: Count,
  totalAfter: Count,
})
/** Shards of a rarity made into a chosen item: the shards spent and left, and the new entry with its definition. */
export const ShardsCrafted = serverEvent("shards.crafted", {
  rarity: Rarity,
  spent: Count,
  totalAfter: Count,
  entry: InventoryEntry,
  item: ItemDef,
})
/** An item went into its slot, replacing what was there: a band style redraws its part of the band. */
export const ItemEquipped = serverEvent("item.equipped", { slot: Slot, entryId: Ulid })
/** A slot was emptied: the band draws its own look there again. */
export const ItemUnequipped = serverEvent("item.unequipped", { slot: Slot })
/** The character took a new name: the band and the pane's header show it. */
export const CharacterRenamed = serverEvent("character.renamed", { name: Name })
/** The egg picked in the welcome: what it hatches as, and under what name. */
export const EggChosen = serverEvent("egg.chosen", Egg.fields)
/** The first-run welcome was finished or skipped: every session stops offering it. */
export const WelcomeFinished = serverEvent("welcome.done", {})
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
  QuestOffered,
  QuestAccepted,
  QuestAbandoned,
  QuestProgress,
  QuestCompleted,
  AchievementUnlocked,
  PetHatched,
  PetChanged,
  PetFed,
  PetPetted,
  ShopBought,
  ItemRerolled,
  ItemSalvaged,
  ShardsCrafted,
  ItemEquipped,
  ItemUnequipped,
  CharacterRenamed,
  EggChosen,
  WelcomeFinished,
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
