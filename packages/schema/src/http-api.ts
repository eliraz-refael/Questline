import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CommandResponse, EventsResponse, SessionRequest, SessionResponse, StreamResponse } from "./api.ts"
import { EventsRequest } from "./client-events.ts"
import { Command } from "./commands.ts"
import { Count } from "./primitives.ts"

// The routes the mod uses, as one HttpApi definition: the server implements it, and the website and tests get a
// typed client from it. The mod stays a plain `$.http.fetch` caller that imports only the types.

export class ModApi extends HttpApiGroup.make("mod", { topLevel: true }).add(
  HttpApiEndpoint.post("openSession", "/v1/sessions", { payload: SessionRequest, success: SessionResponse }),
  HttpApiEndpoint.post("sendEvents", "/v1/events", { payload: EventsRequest, success: EventsResponse }),
  HttpApiEndpoint.post("runCommand", "/v1/commands", { payload: Command, success: CommandResponse }),
  HttpApiEndpoint.get("stream", "/v1/stream", { query: { after: Count }, success: StreamResponse }),
) {}

export class QuestlineApi extends HttpApi.make("questline").add(ModApi) {}
