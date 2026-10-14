import type { ServerBehind, SystemEvent } from "@pathofdev/schema"
import { Context, Duration, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { nowIso } from "./game.ts"
import { ServerRandom } from "./random.ts"
import { PlayerWriter } from "./writer.ts"

// Presence: which of a player's sessions are live. A mod that keeps its session live opens it with `POST /v1/sessions`,
// names it on every stream poll (the heartbeat) and closes it with `DELETE /v1/sessions/{id}` when the session ends.
// The `sessions` table holds the last time each was heard from, outside the log: heartbeats are never logged. What
// reaches the engine are the changes, as inputs through the write path: `session.opened`, and `session.closed` when
// the mod closes it (`ended`) or the sweep finds it unheard for too long (`lapsed`, stamped at its last-heard time).
// A save that a newer build of the server wrote is left alone: the write path's guard is asked before the table
// changes, so the session stays as it was too.

/** A session not heard from for this long has gone: a killed terminal never sends its end. */
export const lapseAfter = Duration.minutes(2)
/** How often the sweep looks for sessions that lapsed. */
export const sweepEvery = Duration.seconds(30)

type Failure = SqlError | Schema.SchemaError | ServerBehind

const Row = Schema.Struct({
  player_id: Schema.String,
  session_id: Schema.String,
  last_heard_at: Schema.String,
  close_reason: Schema.NullOr(Schema.Literals(["ended", "lapsed"])),
})

/** A session the sweep found unheard, as it found it. */
export interface Unheard {
  readonly player_id: string
  readonly session_id: string
  readonly last_heard_at: string
}

/**
 * Closes a session the sweep found unheard as lapsed, at its last-heard time, unless it has been heard from since: a
 * heartbeat takes no lock, so one can land between the sweep's look and this. True when it closed it.
 */
export const lapse = (row: Unheard) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const updated = yield* sql`
      UPDATE sessions SET closed_at = last_heard_at, close_reason = 'lapsed'
      WHERE player_id = ${row.player_id} AND session_id = ${row.session_id}
        AND closed_at IS NULL AND last_heard_at = ${row.last_heard_at}
      RETURNING session_id
    `
    return updated.length > 0
  })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const random = yield* ServerRandom
  const writer = yield* PlayerWriter
  // A table change and the input it logs go together, one at a time, so an open and a close of one session never
  // reach the engine in the other order.
  const lock = yield* Semaphore.make(1)

  const find = SqlSchema.findOneOption({
    Request: Schema.Struct({ playerId: Schema.String, sessionId: Schema.String }),
    Result: Row,
    execute: ({ playerId, sessionId }) => sql`
      SELECT player_id, session_id, last_heard_at, close_reason FROM sessions
      WHERE player_id = ${playerId} AND session_id = ${sessionId}
    `,
  })

  const lapsed = SqlSchema.findAll({
    Request: Schema.String,
    Result: Row,
    execute: (cutoff) => sql`
      SELECT player_id, session_id, last_heard_at, close_reason FROM sessions
      WHERE closed_at IS NULL AND last_heard_at < ${cutoff}
      ORDER BY last_heard_at
    `,
  })

  const record = (playerId: string, now: string, event: SystemEvent) =>
    Effect.flatMap(random.id(now), (id) =>
      writer.apply(playerId, now, [{ id, input: { kind: "system", event }, naturalKey: null }]),
    )

  /** Opens a session from `now`, or a lapsed one again; one open or ended stays as it is, heard from now. */
  const openAt = (playerId: string, sessionId: string, clientVersion: string | null, now: string) =>
    Effect.gen(function* () {
      const row = yield* find({ playerId, sessionId })
      if (Option.isNone(row)) {
        yield* sql`
          INSERT INTO sessions (
            player_id, session_id, client_version, opened_at, last_heard_at, closed_at, close_reason
          ) VALUES (${playerId}, ${sessionId}, ${clientVersion}, ${now}, ${now}, NULL, NULL)
        `
      } else if (row.value.close_reason === "lapsed") {
        yield* sql`
          UPDATE sessions
          SET opened_at = ${now}, last_heard_at = ${now}, closed_at = NULL, close_reason = NULL,
              client_version = COALESCE(${clientVersion}, client_version)
          WHERE player_id = ${playerId} AND session_id = ${sessionId}
        `
      } else {
        // Open: heard from now. Ended: the mod closed it, and a late request of its own never opens it again.
        if (row.value.close_reason === null) yield* heardAt(playerId, sessionId, now)
        return false
      }
      yield* record(playerId, now, { type: "session.opened", sessionId })
      return true
    })

  const heardAt = (playerId: string, sessionId: string, now: string) =>
    sql`
      UPDATE sessions SET last_heard_at = ${now}
      WHERE player_id = ${playerId} AND session_id = ${sessionId} AND closed_at IS NULL
      RETURNING session_id
    `

  const open = (playerId: string, sessionId: string, clientVersion: string | null) =>
    Effect.flatMap(nowIso, (now) =>
      lock.withPermits(1)(Effect.andThen(writer.guard(playerId), openAt(playerId, sessionId, clientVersion, now))))

  const heard = (playerId: string, sessionId: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso
      // The common case writes one row and logs nothing; only a lapsed session, heard from again, opens anew.
      const updated = yield* heardAt(playerId, sessionId, now)
      if (updated.length > 0) return
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* find({ playerId, sessionId })
          if (Option.isNone(row) || row.value.close_reason !== "lapsed") return
          yield* writer.guard(playerId)
          yield* openAt(playerId, sessionId, null, now)
        }),
      )
    })

  const close = (playerId: string, sessionId: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* find({ playerId, sessionId })
          if (Option.isNone(row) || row.value.close_reason === "ended") return false
          yield* writer.guard(playerId)
          // A lapsed one was closed already, at its last-heard time: it is only marked ended, so it never reopens.
          yield* sql`
            UPDATE sessions
            SET close_reason = 'ended', closed_at = COALESCE(closed_at, ${now})
            WHERE player_id = ${playerId} AND session_id = ${sessionId}
          `
          if (row.value.close_reason === "lapsed") return false
          yield* record(playerId, now, { type: "session.closed", sessionId, reason: "ended", at: now })
          return true
        }),
      )
    })

  const sweep = Effect.gen(function* () {
    const now = yield* nowIso
    const cutoff = new Date(Date.parse(now) - Duration.toMillis(lapseAfter)).toISOString()
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* lapsed(cutoff)
        let closed = 0
        for (const row of rows) {
          const event: SystemEvent = {
            type: "session.closed",
            sessionId: row.session_id,
            reason: "lapsed",
            at: row.last_heard_at,
          }
          // A save a newer build wrote is that build's to close: the session stays open until one runs again.
          const isNewer = yield* writer.guard(row.player_id).pipe(
            Effect.as(false),
            Effect.catchTag("ServerBehind", () => Effect.succeed(true)),
          )
          if (isNewer || !(yield* lapse(row).pipe(Effect.provideService(SqlClient.SqlClient, sql)))) continue
          closed += 1
          yield* record(row.player_id, now, event)
        }
        return closed
      }),
    )
  })

  return Presence.of({ open, heard, close, sweep })
})

export class Presence extends Context.Service<
  Presence,
  {
    /**
     * Opens a session the mod keeps live, as of now, logging `session.opened`; a lapsed one opens again. True when
     * this call opened it; one already open is only heard from, and one the mod closed stays closed.
     */
    readonly open: (
      playerId: string,
      sessionId: string,
      clientVersion: string | null,
    ) => Effect.Effect<boolean, Failure>
    /** A stream poll named the session: heard from now, outside the log, or opened again if it had lapsed. */
    readonly heard: (playerId: string, sessionId: string) => Effect.Effect<void, Failure>
    /** The mod closed the session: `session.closed` as `ended`, now. False when it was closed or unknown already. */
    readonly close: (playerId: string, sessionId: string) => Effect.Effect<boolean, Failure>
    /** Closes every session unheard for `lapseAfter` as `lapsed`, at its last-heard time; answers how many. */
    readonly sweep: Effect.Effect<number, Failure>
  }
>()("pathofdev/Presence") {
  static readonly layer = Layer.effect(Presence, make)

  /**
   * The sweep as the server starts, then every `sweepEvery` for as long as it runs; a failed one is logged and the
   * next goes on. The first one closes what went unheard while the server was down, at its last-heard time, so a
   * prompt queued offline meanwhile counts toward no parallel mission.
   */
  static readonly sweeper = Layer.effectDiscard(
    Effect.gen(function* () {
      const presence = yield* Presence
      const once = presence.sweep.pipe(
        Effect.catchCause((cause) => Effect.logWarning("The presence sweep failed", cause)),
        Effect.andThen(Effect.sleep(sweepEvery)),
      )
      yield* Effect.forkScoped(Effect.forever(once))
    }),
  )
}
