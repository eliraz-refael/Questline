import { Schema } from "effect"
import { EventResult } from "./client-events.ts"
import { CommandRefusal } from "./commands.ts"
import { Snapshot } from "./domain.ts"
import { Count, Ulid } from "./primitives.ts"
import { RulesConfig } from "./rules.ts"
import { ServerEvent } from "./server-events.ts"

// Request and response bodies of the /v1 routes the mod uses. The mod sends `Questline-Client: <version>` on
// every request.

/** `POST /v1/sessions` */
export const SessionRequest = Schema.Struct({ sessionId: Ulid })
export interface SessionRequest extends Schema.Schema.Type<typeof SessionRequest> {}

export const SessionResponse = Schema.Struct({
  snapshot: Snapshot,
  rules: RulesConfig,
  minClientVersion: Schema.String,
  /** Event types this server accepts, so a newer mod holds back types an older local server would reject. */
  acceptedEventTypes: Schema.Array(Schema.String),
})
export interface SessionResponse extends Schema.Schema.Type<typeof SessionResponse> {}

/** `POST /v1/events` response. `events` are for animating at once; only the stream moves the cursor. */
export const EventsResponse = Schema.Struct({
  results: Schema.Array(EventResult),
  events: Schema.Array(ServerEvent),
})
export interface EventsResponse extends Schema.Schema.Type<typeof EventsResponse> {}

/** `GET /v1/stream?after=<cursor>`, answered at once or after 25 seconds with nothing. */
export const StreamResponse = Schema.Struct({
  events: Schema.Array(ServerEvent),
  cursor: Count,
  /** The cursor is too old, ahead of this stream, or from another server or epoch: reload the snapshot. */
  resync: Schema.optionalKey(Schema.Literal(true)),
  /** Newer than the mod's copy: fetch `GET /v1/rules/{version}`. */
  rulesVersion: Count,
  minClientVersion: Schema.String,
})
export interface StreamResponse extends Schema.Schema.Type<typeof StreamResponse> {}

/** `POST /v1/commands` response. `ok` events are also delivered on the stream. */
export const CommandResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), events: Schema.Array(ServerEvent) }),
  Schema.Struct({ status: Schema.Literal("refused"), ...CommandRefusal.fields }),
])
export type CommandResponse = typeof CommandResponse.Type

/** The one error shape every route uses; `429` carries `retryAfterMs`. */
export const ApiError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryAfterMs: Schema.optionalKey(Count),
})
export interface ApiError extends Schema.Schema.Type<typeof ApiError> {}
