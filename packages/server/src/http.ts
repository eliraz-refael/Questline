import type { CommandResponse, EventResult, ServerEvent } from "@pathofdev/schema"
import { clientEventTypes, CurrentPlayer, PathOfDevApi } from "@pathofdev/schema"
import { Clock, Duration, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import type { Admitted } from "./edge.ts"
import { admit } from "./edge.ts"
import { minClientVersion, nowIso, rules } from "./game.ts"
import { StreamHub } from "./hub.ts"
import { Players } from "./players.ts"
import { Presence } from "./presence.ts"
import type { Applied } from "./writer.ts"
import { PlayerWriter } from "./writer.ts"

// The routes the mod uses. Database and decoding failures here are defects: the mod retries the request, and every
// input is idempotent by id. Each handler reads the player it acts for from its own request, which the server's
// `Authentication` provides: the services are built once and shared by every player.

/** A held stream answers with nothing after this long, under the proxies' 30-second limit. */
export const streamTimeout = Duration.seconds(25)

/** The mod's version from `PathOfDev-Client`, or from `Questline-Client`, which a mod from before Path of Dev sends. */
export const clientOf = (headers: Readonly<Record<string, string | undefined>>): string | null =>
  headers["pathofdev-client"] ?? headers["questline-client"] ?? null

const resultOf = (applied: Applied): EventResult => ({
  id: applied.id,
  status: applied.status,
  ...(applied.reason === undefined ? {} : { reason: applied.reason }),
  ...(applied.original === undefined ? {} : { original: applied.original }),
})

export const ModHandlers = HttpApiBuilder.group(
  PathOfDevApi,
  "mod",
  Effect.fn(function* (handlers) {
    const players = yield* Players
    const writer = yield* PlayerWriter
    const hub = yield* StreamHub
    const presence = yield* Presence

    return handlers.handleAll({
      openSession: ({ payload, request }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          // A new local day or week rolls its missions first, so the snapshot shows them; the stream carries the offer.
          yield* writer.refreshQuests(player.id, yield* nowIso)
          // Only a mod that keeps its session live opens it: an older one would lapse between its polls.
          if (payload.presence === true) {
            yield* presence.open(player.id, payload.sessionId, clientOf(request.headers))
          }
          const snapshot = yield* players.snapshot(player)
          return { snapshot, rules, minClientVersion, acceptedEventTypes: clientEventTypes }
        }).pipe(Effect.orDie),

      closeSession: ({ params }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          return { closed: yield* presence.close(player.id, params.id) }
        }).pipe(Effect.orDie),

      sendEvents: ({ payload }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          const now = yield* nowIso
          const admissions = payload.events.map((raw) => admit(raw, now))
          const admitted = admissions.flatMap((one): Array<Admitted> => (one.kind === "admitted" ? [one.admitted] : []))
          const applied = yield* writer.apply(player.id, now, admitted)
          // Answer in the order sent: rejected events in place, the rest as the write path applied them.
          let next = 0
          const results = admissions.map((one): EventResult => {
            if (one.kind === "rejected") return one.result
            const done = applied[next++]
            return done === undefined ? { id: one.admitted.id, status: "rejected", reason: "internal" } : resultOf(done)
          })
          const events: Array<ServerEvent> = applied.flatMap((one) => (one.status === "accepted" ? one.events : []))
          return { results, events }
        }).pipe(Effect.orDie),

      runCommand: ({ payload }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          const now = yield* nowIso
          const applied = yield* writer.apply(player.id, now, [
            { id: payload.id, input: { kind: "command", command: payload }, naturalKey: null },
          ])
          const done = applied[0]
          const response: CommandResponse =
            done === undefined || done.status === "rejected"
              ? { status: "refused", code: "not_allowed", message: "The server could not run this command" }
              : done.refusal !== null
                ? { status: "refused", ...done.refusal }
                : { status: "ok", events: done.events }
          return response
        }).pipe(Effect.orDie),

      stream: ({ query }) =>
        Effect.gen(function* () {
          const player = yield* CurrentPlayer
          // The timeout runs from the poll's arrival, so the reads before the wait count against it too.
          const arrived = yield* Clock.currentTimeMillis
          // The poll is the heartbeat: hearing from the session keeps it live, and opens a lapsed one again. A failure
          // there is presence's alone: the stream still answers, and the next poll is heard again.
          if (query.session !== undefined) {
            yield* presence
              .heard(player.id, query.session)
              .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not hear from the session", cause)))
          }
          // Listen before reading, so a commit between the read and the wait still wakes this poll.
          const wakeup = yield* hub.listen(player.id)
          const first = yield* players.streamAfter(player.id, query.after)
          if (first.events.length > 0 || first.resync === true) return first
          const waited = (yield* Clock.currentTimeMillis) - arrived
          yield* Effect.timeoutOption(wakeup, Duration.millis(Math.max(0, Duration.toMillis(streamTimeout) - waited)))
          return yield* players.streamAfter(player.id, query.after)
        }).pipe(Effect.scoped, Effect.orDie),
    })
  }),
)

/** The HTTP routes with their handlers, needing the services the handlers read. */
export const ApiRoutes = HttpApiBuilder.layer(PathOfDevApi).pipe(Layer.provide(ModHandlers))
