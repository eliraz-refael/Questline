import { Schema } from "effect"
import {
  BandSlot,
  CharacterSlot,
  Count,
  Glyph,
  HexColor,
  IsoDate,
  IsoDateTime,
  Name,
  Percent,
  PetSlot,
  Rarity,
  Slot,
  Ulid,
} from "./primitives.ts"

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
  name: Name,
  level: Count,
  xp: Xp,
  /** From the rules config's level bands. */
  title: Schema.String,
  /** The icon before "Lv", from the rules config's glyph bands. */
  glyph: Glyph,
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
  name: Name,
  /** Evolution stage, 0-3. */
  form: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
  /** 0-100; drifts down by the config's rate, decayed when read. */
  mood: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** Slot -> inventory entry id. */
  equipped: Schema.Record(PetSlot, Schema.optionalKey(Ulid)),
})
export interface Pet extends Schema.Schema.Type<typeof Pet> {}

export const ItemCategory = Schema.Literals([
  "food",
  "wearable",
  "scene",
  "title",
  "artefact",
  "levelUpEffect",
  "bandStyle",
])
export type ItemCategory = typeof ItemCategory.Type

// Band styles: a look for one band slot, drawn by the mod from data alone, so a new one ships without a mod update.
// The mod draws each slot from named parts; a look names a glyph or a color for any of them, and the mod's own look
// fills the rest. Common to rare looks are still; epic and legendary loop through frames, each laying overrides of the
// slot's accents (single cells) and marks (one cell along the slot's track, the bar's cells or the edge's line) over
// the look, at a low frame rate.

/** The parts the mod draws a band slot from: which take a glyph, which a color, which a frame may change. */
export interface BandParts {
  readonly glyphs: ReadonlyArray<string>
  readonly colors: ReadonlyArray<string>
  /** Single cells a frame may change. */
  readonly accents: ReadonlyArray<string>
  /** Whether the slot has a run of cells a frame's marks land on. */
  readonly track: boolean
}

export const bandParts: Readonly<Record<BandSlot, BandParts>> = {
  /** `left` + the bar's cells (`full`, then `empty`, `head` on the first empty one) + `right`, then the label. */
  xpBar: {
    glyphs: ["full", "empty", "head", "left", "right"],
    colors: ["full", "empty", "head", "left", "right", "label"],
    accents: ["head", "left", "right"],
    track: true,
  },
  /** The level glyph, then `left` + `lv` and the level + `right`, then the title. */
  levelDisplay: {
    glyphs: ["lv", "left", "right"],
    colors: ["glyph", "level", "title", "left", "right"],
    accents: ["glyph", "left", "right"],
    track: false,
  },
  /** `line line left`, `star QUESTLINE star` (`title`), `right`, then the line with a `dot knot dot` every so often. */
  topEdge: {
    glyphs: ["line", "left", "right", "star", "knot", "dot"],
    colors: ["line", "left", "right", "star", "title", "knot", "dot"],
    accents: ["left", "right", "star"],
    track: true,
  },
  /** `icon` and the amount, then `spark` when the look has one. */
  goldDisplay: {
    glyphs: ["icon", "spark"],
    colors: ["icon", "amount", "spark"],
    accents: ["icon", "spark"],
    track: false,
  },
}

/** The most cells one frame of a loop may change in the band: its accents and marks together. */
export const maxAnimatedCells = 12
/** The fastest a loop may run, in frames a second. */
export const maxLoopFps = 6

/** One cell of a frame along the slot's track: at a share of its length, moved `dx` cells, recolored or redrawn. */
export const BandMark = Schema.Struct({
  at: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  dx: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -8, maximum: 8 })))),
  glyph: Schema.optionalKey(Glyph),
  color: Schema.optionalKey(HexColor),
}).check(Schema.makeFilter((mark) => mark.glyph !== undefined || mark.color !== undefined || "a mark draws something"))
export interface BandMark extends Schema.Schema.Type<typeof BandMark> {}

/** One frame of a loop: overrides of the slot's accents, and marks along its track. */
export const BandFrame = Schema.Struct({
  glyphs: Schema.optionalKey(Schema.Record(Schema.String, Glyph)),
  colors: Schema.optionalKey(Schema.Record(Schema.String, HexColor)),
  marks: Schema.optionalKey(Schema.Array(BandMark)),
})
export interface BandFrame extends Schema.Schema.Type<typeof BandFrame> {}

/** A band cosmetic's look: glyphs and colors by part and, for a loop, its frames and their rate. */
export const BandLook = Schema.Struct({
  glyphs: Schema.Record(Schema.String, Glyph),
  colors: Schema.Record(Schema.String, HexColor),
  /** Epic and legendary: played in a loop while equipped. */
  frames: Schema.NullOr(Schema.Array(BandFrame).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(48)))),
  /** Low by design; the mod pauses the loop during turns. */
  fps: Schema.NullOr(Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: maxLoopFps })))),
}).check(
  Schema.makeFilter((look) => (look.frames === null) === (look.fps === null) || "a loop needs both frames and a rate"),
)
export interface BandLook extends Schema.Schema.Type<typeof BandLook> {}

const isBandSlot = Schema.is(BandSlot)

const outside = (keys: ReadonlyArray<string>, allowed: ReadonlyArray<string>): string | undefined =>
  keys.find((key) => !allowed.includes(key))

/** What is wrong with a look for a slot, if anything: a part the slot doesn't draw, or a frame past the budget. */
const lookIssue = (look: BandLook, slot: BandSlot): string | undefined => {
  const parts = bandParts[slot]
  const glyph = outside(Object.keys(look.glyphs), parts.glyphs)
  if (glyph !== undefined) return `${slot} draws no glyph "${glyph}"`
  const color = outside(Object.keys(look.colors), parts.colors)
  if (color !== undefined) return `${slot} draws no color "${color}"`
  for (const frame of look.frames ?? []) {
    const changed = [...new Set([...Object.keys(frame.glyphs ?? {}), ...Object.keys(frame.colors ?? {})])]
    const fixed = outside(changed, parts.accents)
    if (fixed !== undefined) return `a frame may only change ${slot}'s accents, not "${fixed}"`
    const marks = frame.marks?.length ?? 0
    if (marks > 0 && !parts.track) return `${slot} has no track for marks`
    if (changed.length + marks > maxAnimatedCells) return `a frame may change at most ${maxAnimatedCells} cells`
  }
  return undefined
}

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
  /** Band styles only: the look its band slot draws. */
  look: Schema.NullOr(BandLook),
}).check(
  Schema.makeFilter((item) => {
    if (item.category !== "bandStyle") {
      return item.look === null || { path: ["look"], issue: "only a band style has a look" }
    }
    if (item.slot === null || !isBandSlot(item.slot)) return { path: ["slot"], issue: "a band style fills a band slot" }
    if (item.look === null) return { path: ["look"], issue: "a band style needs a look" }
    const issue = lookIssue(item.look, item.slot)
    return issue === undefined || { path: ["look"], issue }
  }),
)
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

export const ClaimKind = Schema.Literals(["change.merged", "review.submitted", "issue.closed"])
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

/** Counted by the server from stats events and graded prompts. They earn no XP; missions and achievements read them. */
export const PlayerStats = Schema.Struct({
  /** `/clear` uses. */
  clears: Count,
  compactions: Schema.Struct({ manual: Count, auto: Count }),
  /** "/code-review" -> 12 */
  commands: Schema.Record(Schema.String, Count),
  /** Sessions that crossed each context fill. */
  contextCrossed: Schema.Struct({ pct50: Count, pct75: Count, pct100: Count }),
  /** Percent. `lastSession` is the latest measured session's peak; a low average = "keeps context low". */
  contextPeak: Schema.Struct({ lastSession: Percent, average: Percent }),
  /**
   * `averageScore` is the weighted quality grade, 0-10, over every graded prompt. `regretted` counts the prompts that
   * walked back or corrected the player's own previous ask (a regret score above 0); it earns no XP.
   */
  prompts: Schema.Struct({
    graded: Count,
    gradedToday: Count,
    averageScore: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
    regretted: Count,
  }),
})
export interface PlayerStats extends Schema.Schema.Type<typeof PlayerStats> {}

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
  /** The definitions of the items the inventory holds, band looks included, so the mod draws them as they are. */
  items: Schema.Array(ItemDef),
  quests: Schema.Array(QuestState),
  claims: Schema.Array(ClaimState),
  shop: Schema.Array(ShopOffer),
  boosts: Schema.Array(Boost),
  pity: Pity,
  achievements: Schema.Array(Schema.Struct({ id: Schema.String, unlockedAt: IsoDateTime })),
  stats: PlayerStats,
  /** Last server-event seq included, read from the same row as the state. */
  cursor: Count,
})
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
