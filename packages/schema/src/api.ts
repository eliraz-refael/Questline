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
 * Whether `text` is a GitHub login: 1 to 39 letters, digits and hyphens, with no hyphen first. GitHub makes new logins
 * with no hyphen last or doubled either, but older accounts still have them, so those pass too.
 */
export const isGithubLogin = (text: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(text)

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

// ── the account, on the public server ────────────────────────────────────────────────────────────────────────────────

/**
 * What an export holds besides the head, each a part of its own, read a page at a time: the inputs the server logged,
 * the events it sent back, the loot rolls, the inputs it quarantined, and the sessions it heard from.
 */
export const exportParts = ["events", "serverEvents", "rolls", "quarantine", "sessions"] as const
export const ExportPart = Schema.Literals(exportParts)
export type ExportPart = typeof ExportPart.Type

/** One part as the head counts it: `upto` bounds the rows the export takes, null for a part that changes (sessions). */
export const ExportPartHead = Schema.Struct({ part: ExportPart, rows: Count, upto: Schema.NullOr(Count) })
export interface ExportPartHead extends Schema.Schema.Type<typeof ExportPartHead> {}

/**
 * `GET /v1/account/export`: everything kept of the player that fits in a row, read in one transaction, and how many
 * rows each part has up to where the head was read. The rows are the tables' own, as JSON: the player's row without
 * its roll seed (which would predict their loot), their save as stored, and each token's creation time only.
 */
export const ExportHead = Schema.Struct({
  format: Schema.Literal(1),
  exportedAt: Schema.String,
  player: Schema.Unknown,
  state: Schema.Unknown,
  tokens: Schema.Array(Schema.Unknown),
  /** Whether the beta still lets this GitHub account in: kept by the admins, it outlives a delete. */
  onBetaList: Schema.Boolean,
  parts: Schema.Array(ExportPartHead),
})
export interface ExportHead extends Schema.Schema.Type<typeof ExportHead> {}

/**
 * `GET /v1/account/export/{part}?after=<next>&upto=<upto>`: the part's rows after `after`, in key order, a page at most
 * a mebibyte of JSON (or one row past it); `next` is the `after` of the next page, null once the part has ended.
 */
export const ExportPage = Schema.Struct({ rows: Schema.Array(Schema.Unknown), next: Schema.NullOr(Schema.String) })
export interface ExportPage extends Schema.Schema.Type<typeof ExportPage> {}

/** `POST /v1/account/delete`: the GitHub login of the account, typed by the player to say they mean it. */
export const DeleteRequest = Schema.Struct({ login: Schema.String })
export interface DeleteRequest extends Schema.Schema.Type<typeof DeleteRequest> {}

/** The account is gone, every row of it; whether the beta still lets the GitHub account in, to start afresh. */
export const Deleted = Schema.Struct({ deleted: Schema.Literal(true), onBetaList: Schema.Boolean })
export interface Deleted extends Schema.Schema.Type<typeof Deleted> {}
