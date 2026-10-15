import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { Context, Schema } from "effect"
import {
  CommandResponse,
  EventsResponse,
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

// The routes the mod uses, as one HttpApi definition: the server implements it, and the website and tests get a
// typed client from it. The mod stays a plain `$.http.fetch` caller that imports only the types.

/** The player a request acts for, which `Authentication` provides to each request on its own. */
export class CurrentPlayer extends Context.Service<CurrentPlayer, Player>()("pathofdev/CurrentPlayer") {}

/** The request names no player the server knows: a missing, wrong or revoked token. The mod reads it as signed out. */
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

export class ModApi extends HttpApiGroup.make("mod", { topLevel: true })
  .add(
    HttpApiEndpoint.post("openSession", "/v1/sessions", {
      payload: SessionRequest,
      success: SessionResponse,
      error: ServerBehind,
    }),
    HttpApiEndpoint.delete("closeSession", "/v1/sessions/:id", {
      params: { id: Ulid },
      success: SessionClosed,
      error: ServerBehind,
    }),
    HttpApiEndpoint.post("sendEvents", "/v1/events", {
      payload: EventsRequest,
      success: EventsResponse,
      error: ServerBehind,
    }),
    HttpApiEndpoint.post("runCommand", "/v1/commands", {
      payload: Command,
      success: CommandResponse,
      error: ServerBehind,
    }),
    HttpApiEndpoint.get("stream", "/v1/stream", {
      query: { after: Count, session: Schema.optionalKey(Ulid) },
      success: StreamResponse,
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

/** The local server's routes: the mod's alone. */
export class PathOfDevApi extends HttpApi.make("pathofdev").add(ModApi) {}

/** The public server's routes: the mod's, and the sign-in that gives it a game token. */
export class OnlineApi extends HttpApi.make("pathofdev").add(ModApi).add(AuthApi) {}
