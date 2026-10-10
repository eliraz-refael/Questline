import { Schema } from "effect"
import { Count, GradeDimension, IsoDateTime, Percent, Ulid } from "./primitives.ts"
import { CheckoutRef, CommitRef, RepoRef, WorkRef } from "./subjects.ts"

// Client events are observations of work, never scores: the server decides what each one is worth. The one
// exception is a prompt's grade, which the server still prices. The mod sends only the fields below: never local
// paths, file contents, diffs, shell commands, prompt text or transcripts.
// To the public server it sends work in a private repo, or one it can't confirm is public, in the private form.

/** Null outside a repo. */
const TestRun = Schema.Struct({ checkout: Schema.NullOr(CheckoutRef), runner: Schema.String })

const clientEvent = <Type extends string, Data extends Schema.Struct.Fields>(type: Type, data: Data) =>
  Schema.Struct({
    /** ULID made by the mod; the idempotency key. */
    id: Ulid,
    type: Schema.Literal(type),
    /** The mod's clock; the server clamps it to [receipt - 7 days, receipt + 5 minutes]. */
    occurredAt: IsoDateTime,
    /** A ULID the mod mints, so events queued offline carry one too. */
    sessionId: Ulid,
    data: Schema.Struct(data),
  })

/** An agent turn finishes. Reported; drives the loot roll. */
export const TurnCompleted = clientEvent("turn.completed", { durationMs: Count, toolCalls: Count })
/** `git commit` succeeds. Reported. */
export const CommitMade = clientEvent("commit.made", { commit: CommitRef })
/** `gh pr create` succeeds. Reported. */
export const ChangeOpened = clientEvent("change.opened", { change: WorkRef })
/** pr-watch sees the merge, or `gh pr merge` succeeds. A hint; the server verifies public work. */
export const ChangeMerged = clientEvent("change.merged", { change: WorkRef })
/** `gh pr review` succeeds. A hint; credit lands when the author acts on it. */
export const ReviewSubmitted = clientEvent("review.submitted", {
  change: WorkRef,
  state: Schema.Literals(["approved", "changes_requested", "commented"]),
})
/** An issue the player opened closes. A hint; the server verifies public work. */
export const IssueClosed = clientEvent("issue.closed", { issue: WorkRef })
/** A test command exits non-zero. Reported; arms the next green. */
export const TestsFailed = clientEvent("tests.failed", TestRun.fields)
/** A test command passes after a failure. Reported. */
export const TestsPassed = clientEvent("tests.passed", TestRun.fields)
/** First session in a working directory. Reported. */
export const RepoExplored = clientEvent("repo.explored", { repo: Schema.NullOr(RepoRef) })

/** One score from the grader's strict JSON. */
export const GradeScore = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))

/**
 * The grader scored a prompt the player typed at the prompt box (6+ words). Reported. Scores only: the prompt text
 * and the grader's note stay in the mod.
 */
export const PromptGraded = clientEvent("prompt.graded", {
  scores: Schema.Record(GradeDimension, GradeScore),
  /** The rubric the grade was made with. */
  rubricVersion: Count,
  /** Word count of the submitted prompt, pasted text included. */
  words: Count,
  /** Which grader made it. */
  grader: Schema.Literals(["haiku", "jev"]),
})

/**
 * A slash command by name, never its arguments: `/code-review`, or `/plugin:command`. The player's own commands go
 * as `custom`, since their names may reveal private work.
 */
export const CommandName = Schema.Union([
  Schema.Literal("custom"),
  Schema.String.pipe(Schema.check(Schema.isPattern(/^\/[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u))),
])

// Stats events earn no XP: the server folds them into the player stats that missions and achievements read.

/** `/clear` ends a session. */
export const SessionCleared = clientEvent("session.cleared", {})
/** The conversation is compacted, by the player or automatically. */
export const SessionCompacted = clientEvent("session.compacted", { trigger: Schema.Literals(["manual", "auto"]) })
/** The player runs a slash command. */
export const CommandUsed = clientEvent("command.used", { command: CommandName })
/** After each turn: how full the context is. The server works out thresholds crossed and each session's peak. */
export const ContextMeasured = clientEvent("context.measured", { pct: Percent })

export const ClientEvent = Schema.Union([
  TurnCompleted,
  CommitMade,
  ChangeOpened,
  ChangeMerged,
  ReviewSubmitted,
  IssueClosed,
  TestsFailed,
  TestsPassed,
  RepoExplored,
  PromptGraded,
  SessionCleared,
  SessionCompacted,
  CommandUsed,
  ContextMeasured,
])
export type ClientEvent = typeof ClientEvent.Type
export type ClientEventType = ClientEvent["type"]

export const clientEventTypes: ReadonlyArray<ClientEventType> = ClientEvent.members.map(
  (member) => member.fields.type.literal,
)

/**
 * `POST /v1/events` body. Each event is decoded on its own with `ClientEvent`, so one malformed or unknown
 * event is answered `rejected` while the rest of the batch goes on.
 */
export const EventsRequest = Schema.Struct({
  events: Schema.Array(Schema.Unknown).pipe(Schema.check(Schema.isMaxLength(100))),
})
export interface EventsRequest extends Schema.Schema.Type<typeof EventsRequest> {}

export const EventResult = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["accepted", "duplicate", "rejected"]),
  /** unknown_type stays queued in the mod for a newer server. */
  reason: Schema.optionalKey(Schema.Literals(["invalid", "unknown_type", "too_old", "internal"])),
  /** duplicate: the id of the event it repeats. */
  original: Schema.optionalKey(Ulid),
})
export interface EventResult extends Schema.Schema.Type<typeof EventResult> {}
