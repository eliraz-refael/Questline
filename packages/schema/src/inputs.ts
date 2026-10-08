import { Schema } from "effect"
import { ClientEvent } from "./client-events.ts"
import { Command } from "./commands.ts"
import { Count, Ulid } from "./primitives.ts"
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
