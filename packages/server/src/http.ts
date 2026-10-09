import type { CommandResponse, EventResult, ServerEvent } from "@questline/schema"
import { clientEventTypes, QuestlineApi } from "@questline/schema"
import { Duration, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import type { Admitted } from "./edge.ts"
import { admit } from "./edge.ts"
import { minClientVersion, rules } from "./game.ts"
import { StreamHub } from "./hub.ts"
import { CurrentPlayer, nowIso, Players } from "./players.ts"
import type { Applied } from "./writer.ts"
import { PlayerWriter } from "./writer.ts"

// The routes the mod uses. Database and decoding failures here are defects: the mod retries the request, and every
// input is idempotent by id.

/** A held stream answers with nothing after this long, under the proxies' 30-second limit. */
export const streamTimeout = Duration.seconds(25)

const resultOf = (applied: Applied): EventResult => ({
  id: applied.id,
  status: applied.status,
  ...(applied.reason === undefined ? {} : { reason: applied.reason }),
  ...(applied.original === undefined ? {} : { original: applied.original }),
})

export const ModHandlers = HttpApiBuilder.group(
  QuestlineApi,
  "mod",
  Effect.fn(function* (handlers) {
    const player = yield* CurrentPlayer
    const players = yield* Players
    const writer = yield* PlayerWriter
    const hub = yield* StreamHub

    return handlers.handleAll({
      openSession: () =>
        players.snapshot(player).pipe(
          Effect.map((snapshot) => ({ snapshot, rules, minClientVersion, acceptedEventTypes: clientEventTypes })),
          Effect.orDie,
        ),

      sendEvents: ({ payload }) =>
        Effect.gen(function* () {
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
          // Listen before reading, so a commit between the read and the wait still wakes this poll.
          const wakeup = yield* hub.listen(player.id)
          const first = yield* players.streamAfter(player.id, query.after)
          if (first.events.length > 0 || first.resync === true) return first
          yield* Effect.timeoutOption(wakeup, streamTimeout)
          return yield* players.streamAfter(player.id, query.after)
        }).pipe(Effect.scoped, Effect.orDie),
    })
  }),
)

/** The HTTP routes with their handlers, needing the services the handlers read. */
export const ApiRoutes = HttpApiBuilder.layer(QuestlineApi).pipe(Layer.provide(ModHandlers))
