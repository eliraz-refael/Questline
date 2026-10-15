import { Schema } from "effect"
import { EventResult } from "./client-events.ts"
import { CommandRefusal } from "./commands.ts"
import { Player, Snapshot } from "./domain.ts"
import { Count, Ulid } from "./primitives.ts"
import { RulesConfig } from "./rules.ts"
import { ServerEvent } from "./server-events.ts"

// Request and response bodies of the /v1 routes the mod uses. The mod sends `PathOfDev-Client: <version>` on
// every request.

/** `POST /v1/sessions` */
export const SessionRequest = Schema.Struct({
  sessionId: Ulid,
  /**
   * The mod keeps the session live: its stream polls name it, and it closes it when the session ends. Only such a
   * session is open to the game; an older mod's counts toward no parallel mission.
   */
  presence: Schema.optionalKey(Schema.Literal(true)),
})
export interface SessionRequest extends Schema.Schema.Type<typeof SessionRequest> {}

export const SessionResponse = Schema.Struct({
  snapshot: Snapshot,
  rules: RulesConfig,
  minClientVersion: Schema.String,
  /** Event types this server accepts, so a newer mod holds back types an older local server would reject. */
  acceptedEventTypes: Schema.Array(Schema.String),
})
export interface SessionResponse extends Schema.Schema.Type<typeof SessionResponse> {}

/** `DELETE /v1/sessions/{id}` response: whether this request closed it, rather than finding it closed or unknown. */
export const SessionClosed = Schema.Struct({ closed: Schema.Boolean })
export interface SessionClosed extends Schema.Schema.Type<typeof SessionClosed> {}

/** `POST /v1/events` response. `events` are for animating at once; only the stream moves the cursor. */
export const EventsResponse = Schema.Struct({
  results: Schema.Array(EventResult),
  events: Schema.Array(ServerEvent),
})
export interface EventsResponse extends Schema.Schema.Type<typeof EventsResponse> {}

/**
 * `GET /v1/stream?after=<cursor>&session=<id>`, answered at once or after 25 seconds with nothing. Each poll that
 * names its session keeps it live: the poll is the heartbeat.
 */
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

/** Whether `zone` is an IANA time zone this runtime knows, as the mod reads its own from `Intl`. */
export const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** An IANA time zone, for a player's local days. */
export const TimeZone = Schema.String.pipe(Schema.check(Schema.makeFilter((zone) => isTimeZone(zone) || "an IANA time zone")))

/**
 * `POST /v1/auth/github`: a GitHub token from the device flow, traded for a game token. The server asks GitHub once
 * whose token it is, then keeps it nowhere; it never leaves a `Redacted`, so no log or error prints it. `timezone` is
 * a new player's, for their local days.
 */
export const SignInRequest = Schema.Struct({
  githubToken: Schema.RedactedFromValue(Schema.String),
  timezone: TimeZone,
})
export interface SignInRequest extends Schema.Schema.Type<typeof SignInRequest> {}

/** The game token the mod sends as `Authorization: Bearer <token>` from now on, and the player it acts for. */
export const SignInResponse = Schema.Struct({ token: Schema.String, player: Player })
export interface SignInResponse extends Schema.Schema.Type<typeof SignInResponse> {}

/** `POST /v1/auth/logout`: the request's token is revoked, for good. */
export const SignedOut = Schema.Struct({ signedOut: Schema.Literal(true) })
export interface SignedOut extends Schema.Schema.Type<typeof SignedOut> {}

/**
 * Whether `text` is a GitHub login as GitHub makes them: 1 to 39 letters, digits and hyphens, with no hyphen first,
 * last or beside another.
 */
export const isGithubLogin = (text: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(text)

/** `POST /v1/beta`: a GitHub login to let into the beta. The handler checks it, once it has checked who asks. */
export const BetaAddRequest = Schema.Struct({ login: Schema.String })
export interface BetaAddRequest extends Schema.Schema.Type<typeof BetaAddRequest> {}

/**
 * Who the beta lets in, by where it comes from: a login an admin added (the table, which the API changes), a login
 * `ALLOWED_LOGINS` lists, or an admin of `ADMIN_GITHUB_IDS`, by GitHub user id, with the login their player last signed
 * in with (null before their first sign-in). The last two change only with a redeploy.
 */
export const BetaEntry = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("added"),
    login: Schema.String,
    addedAt: Schema.String,
    /** The GitHub user id of the admin who added it. */
    addedBy: Schema.Int,
  }),
  Schema.Struct({ source: Schema.Literal("env"), login: Schema.String }),
  Schema.Struct({ source: Schema.Literal("admin"), githubUserId: Schema.Int, login: Schema.NullOr(Schema.String) }),
])
export type BetaEntry = typeof BetaEntry.Type

/** `GET /v1/beta`: the logins added, oldest first, then those `ALLOWED_LOGINS` lists, then the admins. */
export const BetaList = Schema.Struct({ entries: Schema.Array(BetaEntry) })
export interface BetaList extends Schema.Schema.Type<typeof BetaList> {}

/**
 * `POST /v1/beta` and `DELETE /v1/beta/{login}`: what the change did. Adding a login already on the list, or removing
 * one not on it, changes nothing and says so; `message` says it in a line, and names what still lets a login in when
 * the API can't take it off (`ALLOWED_LOGINS`, or an admin's account).
 */
export const BetaChange = Schema.Struct({ login: Schema.String, changed: Schema.Boolean, message: Schema.String })
export interface BetaChange extends Schema.Schema.Type<typeof BetaChange> {}

/** The one error shape every route uses; `429` carries `retryAfterMs`. */
export const ApiError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryAfterMs: Schema.optionalKey(Count),
})
export interface ApiError extends Schema.Schema.Type<typeof ApiError> {}
