import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { Context, Schema } from "effect"
import {
  BetaAddRequest,
  BetaChange,
  BetaList,
  CommandResponse,
  Deleted,
  DeleteRequest,
  EventsResponse,
  ExportHead,
  ExportPage,
  ExportPart,
  SessionClosed,
  SessionRequest,
  SessionResponse,
  SignedOut,
  SignInRequest,
  SignInResponse,
  StreamResponse,
} from "./api.ts"
import { EventsRequest } from "./client-events.ts"
import { Command } from "./commands.ts"
import type { Player } from "./domain.ts"
import { Count, Ulid } from "./primitives.ts"
import { ProfileChangeRequest, ProfileSettings } from "./profile.ts"

// The routes the mod uses, as one HttpApi definition: the server implements it, and the website and tests get a
// typed client from it. The mod stays a plain `$.http.fetch` caller that imports only the types.

/** The player a request acts for, which `Authentication` provides to each request on its own. */
export class CurrentPlayer extends Context.Service<CurrentPlayer, Player>()("pathofdev/CurrentPlayer") {}

/**
 * The request names no player the server knows: a missing, wrong or revoked token, or one whose account was deleted.
 * The mod reads it as signed out.
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** GitHub couldn't say who signed in: it was down, slow or limiting the server. Nothing was decided; try again later. */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()(
  "GitHubUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** The request's player may not do this: the beta list is the server's admins' alone. Nothing was written. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** The request named something that is not a GitHub login. Nothing was written. */
export class InvalidLogin extends Schema.TaggedError<InvalidLogin>()(
  "InvalidLogin",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The section to hide or show is none the page has, or the page's own change named one. Nothing was written. */
export class InvalidSection extends Schema.TaggedError<InvalidSection>()(
  "InvalidSection",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** An export page was asked for after a key its part has no shape for. Nothing was read. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()(
  "InvalidCursor",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** A delete named a login that isn't the account's: it says the player didn't mean this one. Nothing was deleted. */
export class ConfirmMismatch extends Schema.TaggedError<ConfirmMismatch>()(
  "ConfirmMismatch",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** What a request for an account the player deleted, from any of their tokens, is told with its 401. */
export const accountDeleted = "This account was deleted: sign in again"

/**
 * The player's save was last written by a newer build of the server than the one that answered: a deploy is rolling
 * out, or was rolled back. Nothing was written, so the save never goes back to a shape this build can't read; the mod
 * keeps its queue and tries again later.
 */
export class ServerBehind extends Schema.TaggedError<ServerBehind>()(
  "ServerBehind",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/**
 * Who a request acts for, worked out before its handler runs. Each server implements it: the local server answers
 * every request as its one player, and the public server by the request's bearer token.
 *
 *   request ─▶ Authentication(bearer credential, "" when none)
 *                 ├─ a player ─▶ CurrentPlayer ─▶ handler ─▶ PlayerWriter / Players, for that player
 *                 └─ none ─────▶ 401 Unauthorized, before the handler: nothing read, nothing written
 */
export class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentPlayer }>()(
  "pathofdev/Authentication",
  { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized },
) {}

/**
 * Who a request to the account's own routes acts for: the public server's player by their token alone, without the
 * beta's say, so a player taken off the beta still gets their data out, or deletes it, while their mod is signed in.
 */
export class AccountAuthentication extends HttpApiMiddleware.Service<
  AccountAuthentication,
  { provides: CurrentPlayer }
>()("pathofdev/AccountAuthentication", { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized }) {}

// Every route that acts for a player answers 401 too once the account is deleted under a request still in flight.
export class ModApi extends HttpApiGroup.make("mod", { topLevel: true })
  .add(
    HttpApiEndpoint.post("openSession", "/v1/sessions", {
      payload: SessionRequest,
      success: SessionResponse,
      error: [ServerBehind, Unauthorized],
    }),
    HttpApiEndpoint.delete("closeSession", "/v1/sessions/:id", {
      params: { id: Ulid },
      success: SessionClosed,
      error: [ServerBehind, Unauthorized],
    }),
    HttpApiEndpoint.post("sendEvents", "/v1/events", {
      payload: EventsRequest,
      success: EventsResponse,
      error: [ServerBehind, Unauthorized],
    }),
    HttpApiEndpoint.post("runCommand", "/v1/commands", {
      payload: Command,
      success: CommandResponse,
      error: [ServerBehind, Unauthorized],
    }),
    HttpApiEndpoint.get("stream", "/v1/stream", {
      query: { after: Count, session: Schema.optionalKey(Ulid) },
      success: StreamResponse,
      error: Unauthorized,
    }),
  )
  .middleware(Authentication) {}

/**
 * Signing in to the public server, which needs no game token yet: the mod trades a GitHub token for one, and gives it
 * back to sign out. A token that names no player is answered 401 on either, and a sign-in GitHub can't check right now
 * 503, which leaves the mod's sign-in as it was.
 */
export class AuthApi extends HttpApiGroup.make("auth", { topLevel: true }).add(
  HttpApiEndpoint.post("signIn", "/v1/auth/github", {
    payload: SignInRequest,
    success: SignInResponse,
    error: [Unauthorized, GitHubUnavailable],
  }),
  HttpApiEndpoint.post("signOut", "/v1/auth/logout", { success: SignedOut, error: Unauthorized }),
) {}

/**
 * The beta list, which the public server's admins keep from the mod: who it lets in, and adding or removing a login.
 * A signed-in player who is no admin is answered 403 on each, before the login is even read; never on the local server.
 */
export class BetaApi extends HttpApiGroup.make("beta", { topLevel: true })
  .add(
    HttpApiEndpoint.get("listBeta", "/v1/beta", { success: BetaList, error: Forbidden }),
    HttpApiEndpoint.post("addToBeta", "/v1/beta", {
      payload: BetaAddRequest,
      success: BetaChange,
      error: [Forbidden, InvalidLogin],
    }),
    HttpApiEndpoint.delete("removeFromBeta", "/v1/beta/:login", {
      params: { login: Schema.String },
      success: BetaChange,
      error: [Forbidden, InvalidLogin],
    }),
  )
  .middleware(Authentication) {}

/**
 * The player's own account on the public server, from the mod: what their public page shows, an export of everything
 * kept of them, a page at a time, and deleting it all. Each acts for the token's player whether or not the beta still
 * lets them in; never on the local server, whose save is the player's own disk.
 */
export class AccountApi extends HttpApiGroup.make("account", { topLevel: true })
  .add(
    HttpApiEndpoint.get("profileSettings", "/v1/account/profile", { success: ProfileSettings, error: Unauthorized }),
    HttpApiEndpoint.post("changeProfile", "/v1/account/profile", {
      payload: ProfileChangeRequest,
      success: ProfileSettings,
      error: [InvalidSection, Unauthorized],
    }),
    HttpApiEndpoint.get("exportHead", "/v1/account/export", { success: ExportHead, error: Unauthorized }),
    HttpApiEndpoint.get("exportPage", "/v1/account/export/:part", {
      params: { part: ExportPart },
      query: { after: Schema.optionalKey(Schema.String), upto: Schema.optionalKey(Count) },
      success: ExportPage,
      error: [InvalidCursor, Unauthorized],
    }),
    HttpApiEndpoint.post("deleteAccount", "/v1/account/delete", {
      payload: DeleteRequest,
      success: Deleted,
      error: [ConfirmMismatch, Unauthorized],
    }),
  )
  .middleware(AccountAuthentication) {}

/** The local server's routes: the mod's alone. */
export class PathOfDevApi extends HttpApi.make("pathofdev").add(ModApi) {}

/** The public server's routes: the mod's, the sign-in that gives it a game token, the beta list, and the account. */
export class OnlineApi extends HttpApi.make("pathofdev").add(ModApi).add(AuthApi).add(BetaApi).add(AccountApi) {}
