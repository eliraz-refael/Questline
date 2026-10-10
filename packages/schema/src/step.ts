import { Schema } from "effect"
import { CommandRefusal } from "./commands.ts"
import { ClaimKind, ItemDef, Pity } from "./domain.ts"
import { Count, IsoDateTime, Probability, Rarity, Ulid } from "./primitives.ts"
import { QuestPack } from "./quests.ts"
import { RulesConfig } from "./rules.ts"
import { ServerEventDraft } from "./server-events.ts"
import { PlayerState } from "./state.ts"
import { GitHubWork } from "./subjects.ts"

// What `step(state, input, context)` reads besides the state and the input, and what it returns. The engine has no
// clock, no randomness and no I/O, so time, chance and history arrive in the context.

/** One loot roll: its inputs and its result. The write path stores it in `rolls`; a replay reads it back. */
export const RollRecord = Schema.Struct({
  /** Per player, from 0; draws from hash(rollSeed, number). */
  number: Count,
  /**
   * turn: a finished agent turn; prompt: a graded prompt; verified: a verified fact; reward: a quest or milestone
   * that always drops; reroll: a duplicate traded in, which keeps its rarity.
   */
  trigger: Schema.Literals(["turn", "prompt", "verified", "reward", "reroll"]),
  /** Chance of any drop; 1 for everything but a turn or a prompt. */
  chance: Probability,
  pityBefore: Pity,
  rulesVersion: Count,
  /** Null when nothing dropped. */
  drop: Schema.NullOr(
    Schema.Struct({
      rarity: Rarity,
      itemId: Schema.String,
      gold: Count,
      /** The new inventory entry; duplicates are kept like any other item. */
      entryId: Ulid,
    }),
  ),
}).check(
  Schema.makeFilter(
    (roll) =>
      roll.trigger === "turn" ||
      roll.trigger === "prompt" ||
      roll.chance === 1 || { path: ["chance"], issue: "only a turn or a prompt can miss" },
  ),
)
export interface RollRecord extends Schema.Schema.Type<typeof RollRecord> {}

/** A verified-tier hint to check on GitHub: the write path opens a `claims` row, the verifier resolves it. */
export const ClaimDraft = Schema.Struct({
  claimId: Ulid,
  kind: ClaimKind,
  work: GitHubWork,
  expiresAt: IsoDateTime,
})
export interface ClaimDraft extends Schema.Schema.Type<typeof ClaimDraft> {}

/** What an input produced the first time it ran, stored with its log row so a replay reproduces it. */
export const Recorded = Schema.Struct({
  rolls: Schema.Array(RollRecord),
  /** Commands only; null = applied. */
  refusal: Schema.NullOr(CommandRefusal),
})
export interface Recorded extends Schema.Schema.Type<typeof Recorded> {}

export const Context = Schema.Struct({
  /** The log row's receipt time: the engine's only clock. */
  now: IsoDateTime,
  /** The log row's seq. With `now` and `rollSeed`, it derives the ids of whatever the input creates. */
  logSeq: Count,
  /** Secret, from `players`. */
  rollSeed: Schema.String,
  rules: RulesConfig,
  /** Item definitions at the rules' catalogue version. */
  catalog: Schema.Array(ItemDef),
  questPacks: Schema.Array(QuestPack),
  /** A live run makes rolls and decides commands; a replay takes both from the log. */
  mode: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("live") }),
    Schema.Struct({ kind: Schema.Literal("replay"), recorded: Recorded }),
  ]),
})
export interface Context extends Schema.Schema.Type<typeof Context> {}

/** The result of one step. A refused command returns the state unchanged and nothing else. */
export const Step = Schema.Struct({
  state: PlayerState,
  ...Recorded.fields,
  /** Appended to `server_events`, which adds seq, time and cause. */
  events: Schema.Array(ServerEventDraft),
  claims: Schema.Array(ClaimDraft),
})
export interface Step extends Schema.Schema.Type<typeof Step> {}
