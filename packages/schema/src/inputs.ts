import { Schema } from "effect"
import { ClientEvent } from "./client-events.ts"
import { Command } from "./commands.ts"
import { Count, IsoDateTime, Ulid } from "./primitives.ts"
import { GitHubWork } from "./subjects.ts"

// What the rules engine's `step(state, input, context)` consumes. Every input is stored in the event log as raw
// JSON, so these schemas also decode year-old log rows (through upcasters once the shapes change).

/** A merge, review or closed issue confirmed on GitHub, keyed like `facts`: kind + work (repo + number). */
export const VerifiedFact = Schema.Struct({
  kind: Schema.Literals(["change.merged", "review.acted_on", "issue.closed"]),
  work: GitHubWork,
})
export interface VerifiedFact extends Schema.Schema.Type<typeof VerifiedFact> {}

/** Written by the server itself. */
export const SystemEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("fact.verified"), fact: VerifiedFact }),
  Schema.Struct({
    type: Schema.Literal("claim.resolved"),
    claimId: Ulid,
    status: Schema.Literals(["verified", "unverifiable", "expired"]),
  }),
  /** After a rebalance: grants what the replayed progress reached that the kept holdings don't record yet. */
  Schema.Struct({ type: Schema.Literal("rules.published"), version: Count }),
  Schema.Struct({ type: Schema.Literal("timezone.changed"), tz: Schema.String }),
  /**
   * XP a rules change carried over, so a saved player keeps their level and their place in it: a level curve that asks
   * more XP per level adds what that place now takes. A migration writes it, under the rules version that made it.
   */
  Schema.Struct({ type: Schema.Literal("xp.carried"), amount: Count, rulesVersion: Count }),
  /** A local day or week began: the step that takes it rolls the new window's missions, as every step does. */
  Schema.Struct({ type: Schema.Literal("quests.refresh") }),
  /** A mod that keeps its session live opened it, or was heard from again after it lapsed: open from receipt. */
  Schema.Struct({ type: Schema.Literal("session.opened"), sessionId: Ulid }),
  /**
   * A session went: the mod closed it (`ended`, at receipt), or the presence sweep found it unheard for too long
   * (`lapsed`, at the last time it was heard from).
   */
  Schema.Struct({
    type: Schema.Literal("session.closed"),
    sessionId: Ulid,
    reason: Schema.Literals(["ended", "lapsed"]),
    at: IsoDateTime,
  }),
])
export type SystemEvent = typeof SystemEvent.Type

export const Input = Schema.Union([
  /** An observation from the mod. */
  Schema.Struct({ kind: Schema.Literal("client"), event: ClientEvent }),
  /** A player choice. */
  Schema.Struct({ kind: Schema.Literal("command"), command: Command }),
  /** Written by the server itself. */
  Schema.Struct({ kind: Schema.Literal("system"), event: SystemEvent }),
])
export type Input = typeof Input.Type
