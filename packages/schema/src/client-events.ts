import { Schema } from "effect"
import { Count, GitSha, IsoDateTime, RepoSlug, Ulid } from "./primitives.ts"

// Client events are observations of work, never scores: the server decides what each one is worth.
// The mod sends only the fields below: never local paths, file contents, diffs, commands, prompts or transcripts.

/** `owner/name` from the git remote, or null outside a repo. */
const RepoOrNone = Schema.NullOr(RepoSlug)

/** Outside a repo, on a detached HEAD or before the first commit, the matching git fields are null. */
const TestRun = Schema.Struct({
  repo: RepoOrNone,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(GitSha),
  runner: Schema.String,
})

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
export const CommitMade = clientEvent("commit.made", { repo: RepoSlug, sha: GitSha })
/** `gh pr create` succeeds. Reported. */
export const PrOpened = clientEvent("pr.opened", { repo: RepoSlug, number: Count })
/** pr-watch sees the merge, or `gh pr merge` succeeds. A hint; the server verifies. */
export const PrMerged = clientEvent("pr.merged", { repo: RepoSlug, number: Count })
/** `gh pr review` succeeds. A hint; credit lands when the author acts on it. */
export const ReviewSubmitted = clientEvent("review.submitted", {
  repo: RepoSlug,
  number: Count,
  state: Schema.Literals(["approved", "changes_requested", "commented"]),
})
/** An issue the player opened closes. A hint; the server verifies. */
export const IssueClosed = clientEvent("issue.closed", { repo: RepoSlug, number: Count })
/** A test command exits non-zero. Reported; arms the next green. */
export const TestsFailed = clientEvent("tests.failed", TestRun.fields)
/** A test command passes after a failure. Reported. */
export const TestsPassed = clientEvent("tests.passed", TestRun.fields)
/** First session in a working directory. Reported. */
export const RepoExplored = clientEvent("repo.explored", { repo: RepoOrNone })

export const ClientEvent = Schema.Union([
  TurnCompleted,
  CommitMade,
  PrOpened,
  PrMerged,
  ReviewSubmitted,
  IssueClosed,
  TestsFailed,
  TestsPassed,
  RepoExplored,
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
