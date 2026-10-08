import { Schema } from "effect"
import { CharacterSlot, Count, IsoDate, IsoDateTime, PetSlot, Rarity, Slot, Ulid } from "./primitives.ts"

// The snapshot is everything the mod draws, sent whole when a session opens and kept current by server events.

export const Player = Schema.Struct({
  id: Ulid,
  /** The identity; null on a local server set up without a login. */
  githubUserId: Schema.NullOr(Schema.Int),
  /** Display only: logins can be renamed and reused. */
  githubLogin: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  /** GitHub facts count only from this time on. */
  createdAt: IsoDateTime,
})
export interface Player extends Schema.Schema.Type<typeof Player> {}

export const Xp = Schema.Struct({
  total: Count,
  verified: Count,
  reported: Count,
  intoLevel: Count,
  forNextLevel: Count,
})
export interface Xp extends Schema.Schema.Type<typeof Xp> {}

export const Streak = Schema.Struct({
  days: Count,
  restDaysLeftThisWeek: Count,
  lastDay: IsoDate,
})
export interface Streak extends Schema.Schema.Type<typeof Streak> {}

export const Character = Schema.Struct({
  playerId: Ulid,
  name: Schema.String,
  level: Count,
  xp: Xp,
  /** From the rules config's level bands. */
  title: Schema.String,
  prestige: Count,
  gold: Count,
  shards: Schema.Record(Rarity, Count),
  streak: Streak,
  /** Slot -> inventory entry id. */
  equipped: Schema.Record(CharacterSlot, Schema.optionalKey(Ulid)),
})
export interface Character extends Schema.Schema.Type<typeof Character> {}

export const Pet = Schema.Struct({
  /** "fox" | "slime" | "robot" | "owl" in the starter config. */
  species: Schema.String,
  name: Schema.String,
  /** Evolution stage, 0-3. */
  form: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
  /** 0-100; drifts down by the config's rate, decayed when read. */
  mood: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** Slot -> inventory entry id. */
  equipped: Schema.Record(PetSlot, Schema.optionalKey(Ulid)),
})
export interface Pet extends Schema.Schema.Type<typeof Pet> {}

export const ItemCategory = Schema.Literals(["food", "wearable", "scene", "title", "artefact", "levelUpEffect"])
export type ItemCategory = typeof ItemCategory.Type

/** A catalogue entry, versioned with the rules config. */
export const ItemDef = Schema.Struct({
  /** "slayer-cape" */
  id: Schema.String,
  name: Schema.String,
  rarity: Rarity,
  category: ItemCategory,
  slot: Schema.NullOr(Slot),
  /** Sprite sheet id, fetched once and cached. */
  sprite: Schema.NullOr(Schema.String),
  lore: Schema.NullOr(Schema.String),
  /** Food only. */
  effect: Schema.NullOr(Schema.Struct({ xpBoostPct: Count, minutes: Count })),
})
export interface ItemDef extends Schema.Schema.Type<typeof ItemDef> {}

export const ItemSource = Schema.Struct({
  kind: Schema.Literals(["drop", "quest", "shop", "craft", "achievement"]),
  ref: Schema.String,
})
export interface ItemSource extends Schema.Schema.Type<typeof ItemSource> {}

/** One owned instance of an item. */
export const InventoryEntry = Schema.Struct({
  id: Ulid,
  itemId: Schema.String,
  acquiredAt: IsoDateTime,
  source: ItemSource,
  dye: Schema.NullOr(Schema.String),
})
export interface InventoryEntry extends Schema.Schema.Type<typeof InventoryEntry> {}

export const QuestState = Schema.Struct({
  questId: Schema.String,
  packId: Schema.String,
  title: Schema.String,
  /** offered = today's dailies. */
  status: Schema.Literals(["offered", "active", "completed", "expired"]),
  progress: Count,
  goal: Count,
  expiresAt: Schema.NullOr(IsoDateTime),
})
export interface QuestState extends Schema.Schema.Type<typeof QuestState> {}

export const ClaimKind = Schema.Literals(["pr.merged", "review.submitted", "issue.closed"])
export type ClaimKind = typeof ClaimKind.Type

export const ClaimStatus = Schema.Literals(["pending", "verified", "needs_signin", "unverifiable", "expired"])
export type ClaimStatus = typeof ClaimStatus.Type

export const ClaimState = Schema.Struct({
  claimId: Ulid,
  kind: ClaimKind,
  /** "owner/name#212" */
  subject: Schema.String,
  status: ClaimStatus,
})
export interface ClaimState extends Schema.Schema.Type<typeof ClaimState> {}

export const ShopOffer = Schema.Struct({
  offerId: Schema.String,
  itemId: Schema.String,
  price: Count,
  stock: Schema.NullOr(Count),
  endsAt: IsoDateTime,
})
export interface ShopOffer extends Schema.Schema.Type<typeof ShopOffer> {}

export const Boost = Schema.Struct({
  source: Schema.String,
  xpBoostPct: Count,
  endsAt: IsoDateTime,
})
export interface Boost extends Schema.Schema.Type<typeof Boost> {}

export const Pity = Schema.Struct({ sinceRare: Count, sinceEpic: Count })
export interface Pity extends Schema.Schema.Type<typeof Pity> {}

export const Snapshot = Schema.Struct({
  /** The mod keeps cursor, cache, queue and token per server. */
  serverId: Schema.String,
  /** Changes if this player's stream restarts (reset, account re-created). */
  streamEpoch: Count,
  player: Player,
  character: Character,
  /** Null until hatched at level 1. */
  pet: Schema.NullOr(Pet),
  inventory: Schema.Array(InventoryEntry),
  quests: Schema.Array(QuestState),
  claims: Schema.Array(ClaimState),
  shop: Schema.Array(ShopOffer),
  boosts: Schema.Array(Boost),
  pity: Pity,
  achievements: Schema.Array(Schema.Struct({ id: Schema.String, unlockedAt: IsoDateTime })),
  /** Last server-event seq included, read from the same row as the state. */
  cursor: Count,
})
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
