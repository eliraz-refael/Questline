import { engineVersion, localDay, questsDue, step } from "@pathofdev/engine"
import type { CommandRefusal, Context as StepContext, Input, PlayerState, ServerEvent, Step } from "@pathofdev/schema"
import {
  CommandRefusal as CommandRefusalSchema,
  Count,
  PlayerState as PlayerStateSchema,
  ServerBehind,
  ServerEvent as ServerEventSchema,
} from "@pathofdev/schema"
import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Admitted } from "./edge.ts"
import { catalog, DevMode, inputSchemaVersion, rules } from "./game.ts"
import { StreamHub } from "./hub.ts"
import { QuestPacks } from "./quest-packs.ts"
import { ServerRandom } from "./random.ts"

// Every change to a player goes through `apply`, in one transaction that holds the player's row: client events,
// commands and, later, verified facts and rebalance grants. So there is exactly one place where state changes.
//
//   apply(player, now, inputs) ─ one transaction, the player's row held
//     ├─ last saved by a newer engine than this build's ──▶ ServerBehind (503), nothing written: a deploy is rolling
//     │                                                      out or back, and this build may not read that shape
//     └─ each input, in order
//          ├─ its id is logged ──────────────────────────▶ answered as it was the first time
//          ├─ its natural key is logged ─────────────────▶ duplicate of the first
//          ├─ the engine fails on it ────────────────────▶ rejected: logged, and kept in quarantine
//          └─ stepped ───────────────────────────────────▶ accepted: logged, its server events and rolls written
//     └─▶ player_state moves ─▶ commit ─▶ StreamHub.notify, when there are new events

/** What happened to one input. */
export interface Applied {
  readonly id: string
  readonly status: "accepted" | "duplicate" | "rejected"
  /** rejected: the engine failed on it, and it waits in quarantine. */
  readonly reason?: "internal"
  /** duplicate: the input this one repeats. */
  readonly original?: string
  /** A command the rules refused; null when applied. */
  readonly refusal: CommandRefusal | null
  /** The server events it caused; for a repeated id, the ones it caused the first time. */
  readonly events: ReadonlyArray<ServerEvent>
}

/** The engine's step, swappable so tests can make it fail. */
export type Stepper = (state: PlayerState, input: Input, context: StepContext) => Step

/** The state is read only once the guard lets the request through: a newer engine's shape may not decode here. */
const Head = Schema.Struct({
  state: Schema.Unknown,
  log_seq: Count,
  server_seq: Count,
  engine_version: Count,
  roll_seed: Schema.String,
})

/** Whether a save last written by engine `saved` is newer than this build's engine, which must then leave it alone. */
const isBehind = (saved: number): boolean => saved > engineVersion

const behind = "This server is older than the one that last saved this game: try again in a minute"

/** Fails when the save is newer than this build: nothing may be written over it. */
const guard = (saved: number) => (isBehind(saved) ? Effect.fail(new ServerBehind({ message: behind })) : Effect.void)

const decodeState = (state: unknown) => Effect.orDie(Schema.decodeUnknownEffect(PlayerStateSchema)(state))

const Logged = Schema.Struct({
  input_id: Schema.String,
  status: Schema.Literals(["accepted", "rejected"]),
  reason: Schema.NullOr(Schema.Literal("internal")),
  refusal: Schema.NullOr(CommandRefusalSchema),
})
type Logged = typeof Logged.Type

/** One event_log row as the write path writes it. */
interface LogRow {
  readonly playerId: string
  readonly logSeq: number
  readonly item: Admitted
  readonly now: string
  readonly status: "accepted" | "rejected"
  readonly refusal: CommandRefusal | null
}

const json = (value: unknown): string => JSON.stringify(value)

const make = (stepper: Stepper) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const random = yield* ServerRandom
    const hub = yield* StreamHub
    const devMode = yield* DevMode
    const questPacks = yield* QuestPacks

    const lock = SqlSchema.findOne({
      Request: Schema.String,
      Result: Head,
      execute: (playerId) => sql`
        SELECT s.state, s.log_seq, s.server_seq, s.engine_version, p.roll_seed
        FROM player_state s JOIN players p ON p.id = s.player_id
        WHERE s.player_id = ${playerId}
        FOR UPDATE OF s
      `,
    })

    const findById = SqlSchema.findOneOption({
      Request: Schema.Struct({ playerId: Schema.String, id: Schema.String }),
      Result: Logged,
      execute: ({ playerId, id }) => sql`
        SELECT input_id, status, reason, refusal FROM event_log WHERE player_id = ${playerId} AND input_id = ${id}
      `,
    })

    const findByKey = SqlSchema.findOneOption({
      Request: Schema.Struct({ playerId: Schema.String, key: Schema.String }),
      Result: Schema.Struct({ input_id: Schema.String }),
      execute: ({ playerId, key }) => sql`
        SELECT input_id FROM event_log WHERE player_id = ${playerId} AND natural_key = ${key}
      `,
    })

    const eventsCausedBy = SqlSchema.findAll({
      Request: Schema.Struct({ playerId: Schema.String, cause: Schema.String }),
      Result: ServerEventSchema,
      execute: ({ playerId, cause }) => sql`
        SELECT seq, at, cause, type, data FROM server_events
        WHERE player_id = ${playerId} AND cause = ${cause}
        ORDER BY seq
      `,
    })

    /** A repeated id answers as it did the first time. */
    const repeat = (playerId: string, logged: Logged) =>
      Effect.map(
        eventsCausedBy({ playerId, cause: logged.input_id }),
        (events): Applied => ({
          id: logged.input_id,
          status: logged.status,
          ...(logged.reason === null ? {} : { reason: logged.reason }),
          refusal: logged.refusal,
          events,
        }),
      )

    const log = (row: LogRow) => sql`
      INSERT INTO event_log (
        player_id, log_seq, input_id, natural_key, schema_version, input, received_at,
        engine_version, rules_version, catalog_version, status, reason, refusal
      ) VALUES (
        ${row.playerId}, ${row.logSeq}, ${row.item.id},
        ${row.status === "accepted" ? row.item.naturalKey : null},
        ${inputSchemaVersion}, ${json(row.item.input)}::jsonb, ${row.now},
        ${engineVersion}, ${rules.version}, ${rules.catalogVersion}, ${row.status},
        ${row.status === "rejected" ? "internal" : null},
        ${row.refusal === null ? null : json(row.refusal)}::jsonb
      )
    `

    const apply = (playerId: string, now: string, inputs: ReadonlyArray<Admitted>) =>
      Effect.gen(function* () {
        const head = yield* lock(playerId).pipe(Effect.orDie)
        yield* guard(head.engine_version)
        let state = yield* decodeState(head.state)
        let logSeq = head.log_seq
        let serverSeq = head.server_seq
        const applied: Array<Applied> = []

        for (const item of inputs) {
          const seen = yield* findById({ playerId, id: item.id })
          if (Option.isSome(seen)) {
            applied.push(yield* repeat(playerId, seen.value))
            continue
          }
          if (item.naturalKey !== null) {
            const first = yield* findByKey({ playerId, key: item.naturalKey })
            if (Option.isSome(first)) {
              applied.push({ id: item.id, status: "duplicate", original: first.value.input_id, refusal: null, events: [] })
              continue
            }
          }

          logSeq += 1
          const context: StepContext = {
            now,
            logSeq,
            rollSeed: head.roll_seed,
            rules,
            catalog,
            questPacks: questPacks.active,
            mode: { kind: "live" },
            ...(devMode.isOn ? { dev: true } : {}),
          }
          const ran = yield* Effect.result(Effect.try(() => stepper(state, item.input, context)))

          if (Result.isFailure(ran)) {
            // One bad input never blocks its batch: it is logged as rejected and kept for a look.
            const row: LogRow = { playerId, logSeq, item, now, status: "rejected", refusal: null }
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* log(row)
                yield* sql`
                  INSERT INTO quarantine (player_id, input_id, input, error, received_at)
                  VALUES (${playerId}, ${item.id}, ${json(item.input)}::jsonb, ${String(ran.failure.cause)}, ${now})
                `
              }),
            )
            applied.push({ id: item.id, status: "rejected", reason: "internal", refusal: null, events: [] })
            continue
          }

          const outcome = ran.success
          const events = outcome.events.map(
            (draft, i): ServerEvent => ({ ...draft, seq: serverSeq + 1 + i, at: now, cause: item.id }),
          )
          // A savepoint per input; a failure while writing one still fails the batch, which the mod retries.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* log({ playerId, logSeq, item, now, status: "accepted", refusal: outcome.refusal })
              for (const event of events) {
                yield* sql`
                  INSERT INTO server_events (player_id, seq, at, cause, type, data)
                  VALUES (${playerId}, ${event.seq}, ${event.at}, ${event.cause}, ${event.type}, ${json(event.data)}::jsonb)
                `
              }
              for (const roll of outcome.rolls) {
                yield* sql`
                  INSERT INTO rolls (player_id, number, log_seq, record)
                  VALUES (${playerId}, ${roll.number}, ${logSeq}, ${json(roll)}::jsonb)
                `
              }
            }),
          )
          // Claims wait for the verifier; this engine version opens none.
          state = outcome.state
          serverSeq += events.length
          applied.push({ id: item.id, status: "accepted", refusal: outcome.refusal, events })
        }

        yield* sql`
          UPDATE player_state
          SET state = ${json(state)}::jsonb, log_seq = ${logSeq}, server_seq = ${serverSeq},
              engine_version = ${engineVersion}, rules_version = ${rules.version}
          WHERE player_id = ${playerId}
        `
        return { applied, moved: serverSeq > head.server_seq }
      }).pipe(
        sql.withTransaction,
        // After the commit, never inside it: a waiter woken early would read the stream before the rows exist.
        // Only new events wake waiters; a repeated id answers with old ones.
        Effect.tap(({ moved }) => (moved ? hub.notify(playerId) : Effect.void)),
        Effect.map(({ applied }) => applied),
      )

    const current = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ state: Schema.Unknown, engine_version: Count }),
      execute: (playerId) => sql`SELECT state, engine_version FROM player_state WHERE player_id = ${playerId}`,
    })

    const refreshQuests = (playerId: string, now: string) =>
      Effect.gen(function* () {
        const row = yield* current(playerId).pipe(Effect.orDie)
        yield* guard(row.engine_version)
        const state = yield* decodeState(row.state)
        if (!questsDue(state, now)) return []
        // Keyed by the local day, so two sessions opening at once roll it once.
        const naturalKey = `quests.refresh:${localDay(now, state.timezone)}`
        const id = yield* random.id(now)
        const input: Input = { kind: "system", event: { type: "quests.refresh" } }
        return yield* apply(playerId, now, [{ id, input, naturalKey }])
      })

    const savedBy = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ engine_version: Count }),
      execute: (playerId) => sql`SELECT engine_version FROM player_state WHERE player_id = ${playerId}`,
    })

    const check = (playerId: string) => Effect.flatMap(Effect.orDie(savedBy(playerId)), (row) => guard(row.engine_version))

    return PlayerWriter.of({ apply, refreshQuests, guard: check })
  })

export class PlayerWriter extends Context.Service<
  PlayerWriter,
  {
    /**
     * Applies the inputs in order, as received at `now`, and answers for each one. Fails with `ServerBehind`, having
     * written nothing, when a newer build of the server last saved the player.
     */
    readonly apply: (
      playerId: string,
      now: string,
      inputs: ReadonlyArray<Admitted>,
    ) => Effect.Effect<ReadonlyArray<Applied>, SqlError | Schema.SchemaError | ServerBehind>
    /**
     * Rolls the missions of a local day or week begun since the player's last step, as `now`, so a session opened on
     * a new day shows its missions before any event arrives. Does nothing when none is due.
     */
    readonly refreshQuests: (
      playerId: string,
      now: string,
    ) => Effect.Effect<ReadonlyArray<Applied>, SqlError | Schema.SchemaError | ServerBehind>
    /**
     * Fails with `ServerBehind` when a newer build of the server last saved the player, as `apply` would: for a write
     * outside the log, such as a session's row, made before the input it goes with.
     */
    readonly guard: (playerId: string) => Effect.Effect<void, SqlError | Schema.SchemaError | ServerBehind>
  }
>()("pathofdev/PlayerWriter") {
  static readonly make = (stepper: Stepper) => Layer.effect(PlayerWriter, make(stepper))
  static readonly layer = PlayerWriter.make(step)
}
