import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { Context, Schema } from "effect"
import {
  CommandResponse,
  EventsResponse,
  SessionClosed,
  SessionRequest,
  SessionResponse,
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
    HttpApiEndpoint.post("openSession", "/v1/sessions", { payload: SessionRequest, success: SessionResponse }),
    HttpApiEndpoint.delete("closeSession", "/v1/sessions/:id", { params: { id: Ulid }, success: SessionClosed }),
    HttpApiEndpoint.post("sendEvents", "/v1/events", { payload: EventsRequest, success: EventsResponse }),
    HttpApiEndpoint.post("runCommand", "/v1/commands", { payload: Command, success: CommandResponse }),
    HttpApiEndpoint.get("stream", "/v1/stream", {
      query: { after: Count, session: Schema.optionalKey(Ulid) },
      success: StreamResponse,
    }),
  )
  .middleware(Authentication) {}

export class PathOfDevApi extends HttpApi.make("pathofdev").add(ModApi) {}
