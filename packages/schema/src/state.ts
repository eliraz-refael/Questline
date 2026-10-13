import { Schema } from "effect"
import { Boost, ClaimKind, ClaimStatus, InventoryEntry, Pet, Pity, PlayerStats } from "./domain.ts"
import { Count, IsoDate, IsoDateTime, Name, Percent, QualityDimension, Rarity, Slot, Ulid } from "./primitives.ts"
import { MissionCadence } from "./quests.ts"
import { Egg, ScoringFact } from "./rules.ts"
import { CheckoutRef, GitHubWork } from "./subjects.ts"

// The rules engine's state for one player: one JSON document in `player_state` and `snapshots`. It stores facts,
// not what they are worth: level, title and pet form are derived from it under the rules in force, and the
// Snapshot the mod draws is a projection of it.
//
// A rebalance replays the log into a fresh `progress`, keeps the live `holdings`, then grants whatever the new
// progress reached that the holdings don't record yet. So everything a player owns or was granted lives in
// `holdings`, which only the player's own choices (buying, feeding, crafting) ever shrink.

/** Scoring facts granted on one local day, counted for the daily caps. */
export const DayTally = Schema.Struct({
  day: IsoDate,
  counts: Schema.Record(ScoringFact, Schema.optionalKey(Count)),
})
export interface DayTally extends Schema.Schema.Type<typeof DayTally> {}

/** A failing test run waiting for a green one in the same session. */
export const ArmedTestRun = Schema.Struct({ sessionId: Ulid, checkout: Schema.NullOr(CheckoutRef) })
export interface ArmedTestRun extends Schema.Schema.Type<typeof ArmedTestRun> {}

/** A verified-tier hint on public work and what GitHub said about it. Private work opens none: it stays reported. */
export const Claim = Schema.Struct({
  claimId: Ulid,
  kind: ClaimKind,
  work: GitHubWork,
  status: ClaimStatus,
  openedAt: IsoDateTime,
  /** 30 days after opening; still pending then = expired. */
  expiresAt: IsoDateTime,
})
export interface Claim extends Schema.Schema.Type<typeof Claim> {}

/** A session's context peak, kept so a later measurement in the same session only raises it. */
export const SessionPeak = Schema.Struct({ sessionId: Ulid, peak: Percent })
export interface SessionPeak extends Schema.Schema.Type<typeof SessionPeak> {}

/**
 * A prompt that may make a parallel moment: its session, when it was made, and when that session's open span began,
 * which says the session was open as it was made.
 */
export const ParallelPrompt = Schema.Struct({ sessionId: Ulid, at: IsoDateTime, openedAt: IsoDateTime })
export interface ParallelPrompt extends Schema.Schema.Type<typeof ParallelPrompt> {}

/**
 * A mission of the current window: offered, running or done. Its title, goal and rewards come from the pack, so a
 * pack's new version reads at once; one the packs no longer have stays here, idle, until its window ends.
 */
export const Mission = Schema.Struct({
  questId: Schema.String,
  packId: Schema.String,
  cadence: MissionCadence,
  /** The local day it runs on, or the Monday of its local week. */
  window: IsoDate,
  /** Dailies run as soon as they are offered; weeklies wait to be picked. */
  status: Schema.Literals(["offered", "active", "completed"]),
  progress: Count,
  /** Context goals: each session measured while it ran and its peak, so it counts once and a crossing undoes it. */
  sessions: Schema.Array(SessionPeak),
  /** Parallel goals: the well-graded prompts not spent on a moment yet, the latest within the goal's minutes. */
  prompts: Schema.Array(ParallelPrompt),
})
export interface Mission extends Schema.Schema.Type<typeof Mission> {}

/**
 * A span a session was live, as the server's presence inputs say: from its `session.opened` to its `session.closed`,
 * null while it is open. A session the server let lapse and heard from again has a span for each time.
 */
export const SessionSpan = Schema.Struct({
  sessionId: Ulid,
  openedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
})
export interface SessionSpan extends Schema.Schema.Type<typeof SessionSpan> {}

const NonNegative = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** The counters the player stats are worked out from. */
export const StatCounters = Schema.Struct({
  clears: Count,
  compactions: PlayerStats.fields.compactions,
  /** Command name -> uses. */
  commands: Schema.Record(Schema.String, Count),
  context: Schema.Struct({
    /** Sessions that crossed each context fill. */
    crossed: PlayerStats.fields.contextCrossed,
    /** Sessions measured, and the sum of their peaks: the average peak is one over the other. */
    sessions: Count,
    peakSum: NonNegative,
    /** The latest sessions measured, latest last. */
    recent: Schema.Array(SessionPeak),
  }),
  /**
   * Graded prompts, the sum of their weighted quality grades (0-10 each), those regretted (`prompt.regretAt`), the
   * best grade, and the sum of each quality score over them, which the profile averages.
   */
  prompts: Schema.Struct({
    graded: Count,
    scoreSum: NonNegative,
    regretted: Count,
    best: PlayerStats.fields.grades.fields.best,
    dimensions: Schema.Record(QualityDimension, NonNegative),
  }),
})
export interface StatCounters extends Schema.Schema.Type<typeof StatCounters> {}

/** Everything a rebalance recomputes by replaying the log. */
export const Progress = Schema.Struct({
  /** Level and title are derived from the total. */
  xp: Schema.Struct({ verified: Count, reported: Count }),
  /** Lifetime count per fact kind: each piece of work once, whatever its XP or cap. Profiles and achievements read it. */
  totals: Schema.Record(ScoringFact, Schema.optionalKey(Count)),
  prestige: Count,
  /** XP that no longer counts toward the level: level = levelForXp(verified + reported - prestigeXp). */
  prestigeXp: Count,
  /** The last 7 local days. The edge clamps event times to 7 days back, so older days can't change. */
  tallies: Schema.Array(DayTally),
  /** Local days with activity, sorted, back to the current streak's start and never fewer than the last 7. */
  activeDays: Schema.Array(IsoDate),
  /** The longest streak reached, in days, as the active days stood when each was added. */
  bestStreak: Count,
  /** The missions of the current daily and weekly windows. */
  quests: Schema.Array(Mission),
  /** The windows the missions were last rolled for; a step in a later one rolls its missions. */
  questWindows: Schema.Struct({ daily: Schema.NullOr(IsoDate), weekly: Schema.NullOr(IsoDate) }),
  /** The sessions open now, and those closed in the last day, so a prompt can be checked against its session. */
  presence: Schema.Array(SessionSpan),
  /** Flat XP boosts, from food or missions, while they run; the strongest running one of each kind counts. */
  boosts: Schema.Array(Boost),
  tests: Schema.Struct({ armed: Schema.Array(ArmedTestRun) }),
  claims: Schema.Array(Claim),
  stats: StatCounters,
})
export interface Progress extends Schema.Schema.Type<typeof Progress> {}

export const OwnedPet = Schema.Struct({
  species: Pet.fields.species,
  name: Name,
  hatchedAt: IsoDateTime,
  /** Evolution stages unlocked, by level or early by an evolution stone. Old forms stay selectable. */
  forms: Schema.Array(Pet.fields.form),
  /** The stage shown, one of `forms`. */
  form: Pet.fields.form,
  /** Mood as of `at`; decayed by the rules' daily rate when read. */
  mood: Schema.Struct({ value: Pet.fields.mood, at: IsoDateTime }),
  /** The pats in the last hour that lifted its mood: only so many an hour count. */
  petted: Schema.Array(IsoDateTime),
}).check(Schema.makeFilter((pet) => pet.forms.includes(pet.form) || { path: ["form"], issue: "form must be unlocked" }))
export interface OwnedPet extends Schema.Schema.Type<typeof OwnedPet> {}

/** Everything a rebalance keeps: what the player owns, and the milestones already granted. */
export const Holdings = Schema.Struct({
  gold: Count,
  shards: Schema.Record(Rarity, Count),
  inventory: Schema.Array(InventoryEntry),
  /** Character and pet slots -> inventory entry id. */
  equipped: Schema.Record(Slot, Schema.optionalKey(Ulid)),
  /** Null until hatched at level 1. */
  pet: Schema.NullOr(OwnedPet),
  /**
   * The egg as the player picked it in the welcome, until it hatches as that species under that name; null when they
   * never picked one, so it hatches as the rules' default egg.
   */
  egg: Schema.NullOr(Egg),
  /** Highest level reached since the last prestige. Reaching a level at or below it again grants nothing. */
  peakLevel: Count,
  achievements: Schema.Array(Schema.Struct({ id: Schema.String, unlockedAt: IsoDateTime })),
  /** Missions whose rewards were granted, in the current windows: a mission completes once per window. */
  completedQuests: Schema.Array(
    Schema.Struct({ questId: Schema.String, packId: Schema.String, window: IsoDate, completedAt: IsoDateTime }),
  ),
  /** Kept with the holdings so a roll number is never drawn twice. */
  loot: Schema.Struct({ nextRoll: Count, pity: Pity }),
  /** Today's purchases per offer id, for stock; offers themselves are derived from the day and the catalogue. */
  shop: Schema.Struct({ day: IsoDate, bought: Schema.Record(Schema.String, Count) }),
})
export interface Holdings extends Schema.Schema.Type<typeof Holdings> {}

export const PlayerState = Schema.Struct({
  characterName: Name,
  /** When the player finished or skipped the first-run welcome; null until then, so it shows once. */
  welcomedAt: Schema.NullOr(IsoDateTime),
  /** IANA zone. Caps, streaks and dailies count local days in it; a replay reads it from here, not the clock. */
  timezone: Schema.String,
  progress: Progress,
  holdings: Holdings,
})
export interface PlayerState extends Schema.Schema.Type<typeof PlayerState> {}
