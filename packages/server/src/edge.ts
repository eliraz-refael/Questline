import type { ClientEvent, EventResult, Input, WorkRef } from "@questline/schema"
import { ClientEvent as ClientEventSchema, clientEventTypes } from "@questline/schema"
import { Predicate, Result, Schema } from "effect"

// What the edge does to each client event before the write path sees it: decode it on its own, so one bad event
// never fails its batch, and keep its time inside the window the engine trusts.

/** An input the write path takes, with the key that makes a repeat of the same work count once. */
export interface Admitted {
  readonly id: string
  readonly input: Input
  /** Null for observations that are not a piece of work, like a finished turn or a graded prompt. */
  readonly naturalKey: string | null
}

export type Admission =
  | { readonly kind: "admitted"; readonly admitted: Admitted }
  | { readonly kind: "rejected"; readonly result: EventResult }

const day = 24 * 60 * 60 * 1000
/** Events older than this are refused; the engine's daily tallies only reach back this far. */
export const maxAge = 7 * day
/** Events from the future are pulled back to this far ahead of receipt. */
export const maxAhead = 5 * 60 * 1000

const decode = Schema.decodeUnknownResult(ClientEventSchema)

const idOf = (raw: unknown): string => (Predicate.hasProperty(raw, "id") && typeof raw.id === "string" ? raw.id : "")

/** A type this server doesn't know, likely from a newer mod, as opposed to a malformed event. */
const isUnknownType = (raw: unknown): boolean =>
  Predicate.hasProperty(raw, "type") &&
  typeof raw.type === "string" &&
  !clientEventTypes.some((type) => type === raw.type)

/** Decodes one client event and fits it to the time window, as of `now`, the batch's receipt time. */
export const admit = (raw: unknown, now: string): Admission => {
  const decoded = decode(raw)
  if (Result.isFailure(decoded)) {
    // An unknown type stays queued in the mod for a newer server; anything else malformed is dropped.
    const reason = isUnknownType(raw) ? "unknown_type" : "invalid"
    return { kind: "rejected", result: { id: idOf(raw), status: "rejected", reason } }
  }
  const event = decoded.success
  const receipt = Date.parse(now)
  const occurred = Date.parse(event.occurredAt)
  // The pattern lets through dates that don't exist, like month 13; those parse to NaN and would pass every check.
  if (Number.isNaN(occurred)) return { kind: "rejected", result: { id: event.id, status: "rejected", reason: "invalid" } }
  if (occurred < receipt - maxAge) return { kind: "rejected", result: { id: event.id, status: "rejected", reason: "too_old" } }
  const clamped: ClientEvent =
    occurred > receipt + maxAhead ? { ...event, occurredAt: new Date(receipt + maxAhead).toISOString() } : event
  return { kind: "admitted", admitted: { id: event.id, input: { kind: "client", event: clamped }, naturalKey: naturalKey(clamped) } }
}

/**
 * The same piece of work reported twice, by pr-watch and by `gh pr merge`, carries one key: repo + sha for a commit,
 * kind + repo + number for a change, review or issue, and the subject key for private work.
 */
export const naturalKey = (event: ClientEvent): string | null => {
  switch (event.type) {
    case "commit.made": {
      const commit = event.data.commit
      return commit.type === "github" ? `${event.type}:${commit.repo}@${commit.sha}` : `${event.type}:${commit.key}`
    }
    case "change.opened":
    case "change.merged":
    case "review.submitted":
      return workKey(event.type, event.data.change)
    case "issue.closed":
      return workKey(event.type, event.data.issue)
    case "turn.completed":
    case "tests.failed":
    case "tests.passed":
    case "repo.explored":
    case "prompt.graded":
    case "session.cleared":
    case "session.compacted":
    case "command.used":
    case "context.measured":
      return null
  }
}

const workKey = (type: string, work: WorkRef): string =>
  work.type === "github" ? `${type}:${work.repo}#${work.number}` : `${type}:${work.key}`
