import type { SessionSpan } from "@pathofdev/schema"
import { isLater } from "./days.ts"

// Presence: which sessions were open, and when, as the server's `session.opened` and `session.closed` inputs say. The
// engine never asks the clock or the server's sessions table; the spans are what the log told it, so a replay reads
// them the same.

/** How long a closed span is kept: a prompt is checked against its session as it arrives, not days later. */
export const keepClosedMs = 86_400_000
/** The most spans kept; the oldest closed ones go first. */
export const maxSpans = 200

/** The span of the session that `at` falls in, if the session was open then. */
export const spanAt = (spans: ReadonlyArray<SessionSpan>, sessionId: string, at: string): SessionSpan | undefined =>
  spans.find(
    (span) =>
      span.sessionId === sessionId &&
      !isLater(span.openedAt, at) &&
      (span.closedAt === null || isLater(span.closedAt, at)),
  )

/** A session opened at `now`; one already open stays as it is. */
export const openSpan = (spans: ReadonlyArray<SessionSpan>, sessionId: string, now: string): Array<SessionSpan> =>
  spans.some((span) => span.sessionId === sessionId && span.closedAt === null)
    ? [...spans]
    : [...spans, { sessionId, openedAt: now, closedAt: null }]

/**
 * A session's open span closed at `at`, kept between its opening and `now`: a lapse is stamped at the last time the
 * server heard from it, which can't be before it opened. A session not open stays as it is.
 */
export const closeSpan = (
  spans: ReadonlyArray<SessionSpan>,
  sessionId: string,
  at: string,
  now: string,
): Array<SessionSpan> =>
  spans.map((span) => {
    if (span.sessionId !== sessionId || span.closedAt !== null) return span
    const closedAt = isLater(span.openedAt, at) ? span.openedAt : isLater(at, now) ? now : at
    return { ...span, closedAt }
  })

/** The open spans, and the closed ones of the last day, the latest `maxSpans` of them. */
export const prunePresence = (spans: ReadonlyArray<SessionSpan>, now: string): Array<SessionSpan> => {
  const recent = spans.filter(
    (span) => span.closedAt === null || Date.parse(now) - Date.parse(span.closedAt) <= keepClosedMs,
  )
  const closed = recent.filter((span) => span.closedAt !== null)
  const excess = new Set(closed.slice(0, Math.max(0, recent.length - maxSpans)))
  return recent.filter((span) => !excess.has(span))
}
