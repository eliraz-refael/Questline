// What the band draws from: the session's values the mod keeps in `$.state`.

/** Whether the local server answers. */
export type Link = 'connecting' | 'online' | 'offline'

/** The character as the band shows it, worked out from the server's snapshot. */
export type BandView = {
  name: string
  level: number
  title: string
  /** The icon before "Lv", as the server names it for the level. */
  glyph: string
  xp: { total: number; intoLevel: number; forNextLevel: number }
  gold: number
  /** A local server in dev mode, which takes the dev commands: the pane shows its dev controls. */
  isDev: boolean
  pet: { species: string; name: string; form: number; mood: number } | null
}

/** A line at the end of the band for what the stream brought. */
export type GainLine = { text: string; tone: 'xp' | 'level' | 'loot' | 'gold' | 'quest' | 'pet' | 'quiet' }

/** The last line the stream brought, shown until the next one or until `until` (clock ms), when it fades. */
export type Gain = GainLine & { until: number }

/** How big a celebration is, as the server's events name it. */
export type Tier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

/**
 * Something the band celebrates, from one server event, or several of the small ones collapsed into one (`more`
 * counts the others).
 */
export type Celebration =
  | { kind: 'xp'; amount: number }
  | { kind: 'loot'; tier: Tier; name: string; gold: number; more: number }
  | { kind: 'level'; tier: Tier; from: number; to: number; glyph: string; title: string | null; evolved: boolean }
  | { kind: 'quest'; tier: Tier; title: string; rewards: string; more: number }

/** How the player wants celebrations: animated, as one still frame without the band growing, or not at all. */
export type Motion = 'full' | 'reduced' | 'off'

/**
 * The celebration playing now, at a frame; `seed` varies its sparks from one celebration to the next, and `load`
 * names the copy of the mod that plays it, so a frame another copy left behind is never drawn.
 */
export type Stage = { celebration: Celebration; tick: number; seed: number; motion: 'full' | 'reduced'; load: number }

/** The band's own slots, each drawn from a look: the mod's own, or the band style equipped there. */
export type BandSlot = 'xpBar' | 'levelDisplay' | 'topEdge' | 'goldDisplay'

/** One cell of a loop's frame along a slot's track: at a share of its length, moved `dx` cells. */
export type LookMark = { at: number; dx?: number; glyph?: string; color?: string }

/** One frame of a loop: glyphs and colors laid over the look's accents, and marks along the track. */
export type LookFrame = {
  glyphs?: Readonly<Record<string, string>>
  colors?: Readonly<Record<string, string>>
  marks?: ReadonlyArray<LookMark>
}

/** A soft-edged light that travels a slot's track: colors from its dim tail to its bright head, and frames of rest. */
export type LookSheen = { colors: ReadonlyArray<string>; rest: number }

/** A band style's look, as the server sends it: glyphs and colors by part, and a loop's frames, rate and sheen. */
export type BandLook = {
  glyphs: Readonly<Record<string, string>>
  colors: Readonly<Record<string, string>>
  frames: ReadonlyArray<LookFrame> | null
  fps: number | null
  sheen?: LookSheen
}

/** What a sigil does, as the server says: its multiplier on graded prompts' XP, and the mark and color it shows in. */
export type SigilView = { multiplier: number; glyph: string; color: string }

/** One owned item, its definition beside its entry. */
export type OwnedItem = {
  entryId: string
  itemId: string
  name: string
  rarity: Tier
  category: string
  slot: string | null
  look: BandLook | null
  lore: string | null
  /** A sigil's power; absent on every other item, and on what a copy of the mod from before sigils kept. */
  sigil?: SigilView
  /** Food's XP boost when the pet eats it; absent on every other item, and on what an older copy kept. */
  food?: FoodView
}

/** What food does when the pet eats it: so much more XP for so many minutes, or nothing but the meal. */
export type FoodView = { pct: number; minutes: number } | null

/**
 * What the player owns and what is equipped where (slot -> entry id). `knowsSigils` is true only from a server whose
 * rules carry sigils, which the pane's Sigil section waits for.
 */
export type Wardrobe = {
  items: ReadonlyArray<OwnedItem>
  equipped: Readonly<Record<string, string>>
  knowsSigils?: boolean
  /** True only from a server whose rules carry pet care: food then leaves Other items for the pet's card. */
  knowsCare?: boolean
}

/**
 * The loops' clocks: frames played at each rate a worn look loops at (by the rate, as text), so every look steps
 * evenly at its own. Null while they rest, which draws still looks.
 */
export type Loop = { ticks: Readonly<Record<string, number>> }

/**
 * The Stats tab's numbers, as the server counted them. `best` and `profile` are null from a server older than this
 * mod, which counts neither.
 */
export type StatsView = {
  streak: { days: number; best: number | null; restDaysLeftThisWeek: number }
  prompts: { graded: number; today: number; average: number; best: number | null; regretted: number }
  /** Each quality score's average over the graded prompts, 0-10, in the rubric's order. */
  profile: ReadonlyArray<{ dimension: string; average: number }> | null
  /** Percent: the latest session's peak and the average, and the sessions that crossed each fill. */
  context: { lastSession: number; average: number; pct50: number; pct75: number; pct100: number }
  clears: number
  compactions: { manual: number; auto: number }
  /** Uses by command name, most used first. */
  commands: ReadonlyArray<{ name: string; uses: number }>
  xp: { verified: number; reported: number }
  /** Inventory entries owned. */
  items: number
  /**
   * The sigil worn, with its name; `worn` null when none is. Null itself from a server older than sigils, where the
   * tab shows no row for one.
   */
  sigil?: {
    worn: (SigilView & { name: string; rarity: Tier }) | null
    /** One is worn that the snapshot can't name, as the catalogue no longer has it. */
    isUnknown?: boolean
  } | null
}

/** What a mission grants when it completes, as the pack promises it: XP, gold, an XP boost, a drop of a rarity. */
export type MissionRewards = {
  xp: number
  gold: number
  loot: Tier | null
  /** Percent more XP for so many minutes; absent when it grants none, or from a copy of the mod before boosts. */
  boost?: { pct: number; minutes: number }
}

/** One mission as the pane and the band draw it, from the snapshot's quest state. */
export type MissionView = {
  questId: string
  title: string
  description: string | null
  /** daily or weekly; a cadence this mod doesn't know yet is listed with neither. */
  cadence: string
  /** offered: waiting to be picked; active: running; expired: its window ended unfinished. */
  status: 'offered' | 'active' | 'completed' | 'expired'
  progress: number
  goal: number
  /** What its goal counts, as the server names it (`parallel`: moments sessions ran together); null from older ones. */
  goalKind: string | null
  rewards: MissionRewards
  /** When its window ends, in clock ms; null when the server didn't say. */
  expiresAt: number | null
}

/**
 * The missions the snapshot carries, and the rules beside them: how many weeklies may run at once and the tier each
 * cadence celebrates at, which colors it. `isKnown` is false from a server older than missions.
 */
export type MissionsView = {
  isKnown: boolean
  quests: ReadonlyArray<MissionView>
  weeklyActive: number | null
  tiers: { daily: Tier | null; weekly: Tier | null }
}

/** One of today's offers, with its item as the snapshot defines it and how many the player owns already. */
export type OfferView = {
  offerId: string
  itemId: string
  name: string
  rarity: Tier
  category: string
  slot: string | null
  look: BandLook | null
  lore: string | null
  price: number
  /** Copies left today; null: no limit. */
  stock: number | null
  /** When the shop restocks, in clock ms; null when the server didn't say. */
  endsAt: number | null
  owned: number
  /** Food's boost, for food only. */
  food?: FoodView
}

/** An item owned more than once: a spare copy to trade in, and what a re-roll costs and a salvage gives. */
export type SpareView = {
  itemId: string
  name: string
  rarity: Tier
  category: string
  slot: string | null
  copies: number
  /** A copy not worn, the one a trade gives up. */
  entryId: string
  rerollGold: number | null
  salvageShards: number | null
}

/** An item the shards of its rarity can make now, and how many the player owns. */
export type CraftView = {
  itemId: string
  name: string
  rarity: Tier
  category: string
  slot: string | null
  owned: number
}

/**
 * The Shop tab: today's offers, the spare copies to trade in, the shards and what they make. `isKnown` is false from
 * a server older than the shop, whose rules carry none.
 */
export type ShopView = {
  isKnown: boolean
  gold: number
  offers: ReadonlyArray<OfferView>
  spares: ReadonlyArray<SpareView>
  shards: ReadonlyArray<{ rarity: Tier; count: number }>
  /** Shards a craft takes; null when the rules don't say. */
  shardsToCraft: number | null
  craftable: ReadonlyArray<CraftView>
}

/** Food the player owns, by kind, for the pet's card. */
export type MealView = {
  entryId: string
  itemId: string
  name: string
  rarity: Tier
  copies: number
  food: FoodView
  lore: string | null
}

/**
 * The pet's card: its mood and what lifts it, as the rules say, the food owned and the food boost running. `isKnown` is
 * false from a server older than pet care, which takes neither food nor a pat.
 */
export type CareView = {
  isKnown: boolean
  /** A mood above this is happy; null when the rules don't say. */
  happyAbove: number | null
  /** What a happy pet adds to the flat XP boosts, in percent. */
  happyBonus: number | null
  /** What a meal and a pat lift the mood by, and how many pats an hour count. */
  fed: number | null
  petted: number | null
  pettedPerHour: number | null
  meals: ReadonlyArray<MealView>
  /** The strongest food boost running, until clock ms `endsAt`. */
  boost: { pct: number; endsAt: number } | null
}

/** The `/pathofdev` pane's tabs; the last is the first-run welcome, which a player may open again. */
export type PaneTab = 'inventory' | 'shop' | 'stats' | 'missions' | 'welcome'

/** A species an egg can hatch as, as the rules list it. */
export type SpeciesView = { id: string; name: string; about: string }

/**
 * What the welcome's grading step says, from the rules and the `minWords` option: each number null when the rules
 * don't say, and the step then says it without one.
 */
export type GradingView = {
  /** A typed prompt shorter than this goes ungraded. */
  minWords: number
  /** XP for a perfect grade. */
  maxXp: number | null
  /** How a day's graded prompts taper, in order: up to the `upTo`-th earn `pct` percent; null = every one after. */
  perDay: ReadonlyArray<{ upTo: number | null; pct: number }> | null
  /** The quality scores that count toward XP, in the rubric's order. */
  counted: ReadonlyArray<string>
  /** The chance of a drop at a perfect grade, 0-1. */
  lootAtTen: number | null
  /** A grade from which a drop's rare-and-better odds rise, and by what factor. */
  greatAt: number | null
  greatFactor: number | null
}

/**
 * The first-run welcome, as the snapshot and the rules give it. `isKnown` is false from a server older than the
 * welcome, whose rules list no species: the mod then never offers it.
 */
export type WelcomeView = {
  isKnown: boolean
  /** The player finished or skipped it: it never opens on its own again. */
  isDone: boolean
  species: ReadonlyArray<SpeciesView>
  /** The egg as it hatches, picked or the rules' default; null once it has hatched, or from an older server. */
  egg: { species: string; name: string } | null
  grading: GradingView
}

/** The welcome's steps, in order. */
export type WelcomeStep = 'hello' | 'name' | 'pet' | 'grading' | 'ready'

/**
 * Where the player is in the welcome, and what they typed and picked that no step has saved yet: null for what they
 * haven't touched, which reads as the server has it. `error` is the server's word on the last save, shown in place.
 */
export type Wizard = {
  step: WelcomeStep
  name: string | null
  species: string | null
  petName: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // Under the mod's plugin id: the engine keys the mod's state, its store and the player's options by it.
    pathofdev: {
      view: BandView | null
      link: Link
      gain: Gain | null
      stage: Stage | null
      /** The celebrations still to play, the one playing first, so a reload of the mod plays them again. */
      queue: ReadonlyArray<Celebration>
      wardrobe: Wardrobe | null
      stats: StatsView | null
      /** Under a new key: a copy of the mod from before kept `{ tick, rate }` under `loop`. */
      loops: Loop | null
      tab: PaneTab
      missions: MissionsView | null
      /** The running weekly whose Abandon was pressed once: the pane asks before its progress goes. */
      abandoning: string | null
      /** The id the session goes by with the server, so a reload of the mod keeps it rather than opening another. */
      session: string | null
      shop: ShopView | null
      care: CareView | null
      welcome: WelcomeView | null
      /** The welcome's step and drafts while it shows; null when it starts afresh. */
      wizard: Wizard | null
    }
  }
}
