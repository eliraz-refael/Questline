import { engineVersion, initialState, project, ulids } from "@questline/engine"
import type { Player as PlayerType, Snapshot, StreamResponse } from "@questline/schema"
import { Count, Player, PlayerState, ServerEvent } from "@questline/schema"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { randomBytes } from "node:crypto"
import { catalog, minClientVersion, rules } from "./game.ts"

// Reads of a player that never change one: who the player is, the snapshot the mod draws, and the stream after a
// cursor. Writes go through the PlayerWriter.

/** Who the local server plays as. It has exactly one player and no sign-in. */
export interface LocalProfile {
  readonly displayName: string
  readonly characterName: string
  /** IANA zone, for local days. */
  readonly timezone: string
}

/** The player a request acts for: on the local server, its one player. */
export class CurrentPlayer extends Context.Service<CurrentPlayer, PlayerType>()("questline/CurrentPlayer") {}

/** A mod more than this many events behind reloads the snapshot instead. */
export const maxBehind = 1000

type Failure = SqlError | Schema.SchemaError

export class Players extends Context.Service<
  Players,
  {
    /** The local server's player, created on first start. */
    readonly local: (profile: LocalProfile) => Effect.Effect<PlayerType, Failure>
    readonly snapshot: (player: PlayerType) => Effect.Effect<Snapshot, Failure>
    /** The stream after `after`, answered from what is committed now. */
    readonly streamAfter: (playerId: string, after: number) => Effect.Effect<StreamResponse, Failure>
  }
>()("questline/Players") {
  static readonly layer = Layer.effect(Players, Effect.suspend(() => make))
}

export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

/** The id the mod keys its cursor, cache and queue on. */
export const serverIdOf = (player: PlayerType): string => `local-${player.id}`

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const playerColumns = sql`
    id, github_user_id::float8 AS "githubUserId", github_login AS "githubLogin",
    display_name AS "displayName", created_at AS "createdAt"
  `

  const firstPlayer = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Player,
    execute: () => sql`SELECT ${playerColumns} FROM players ORDER BY created_at LIMIT 1`,
  })

  const head = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ state: PlayerState, server_seq: Count, stream_epoch: Count }),
    execute: (playerId) => sql`SELECT state, server_seq, stream_epoch FROM player_state WHERE player_id = ${playerId}`,
  })

  const eventsAfter = SqlSchema.findAll({
    Request: Schema.Struct({ playerId: Schema.String, after: Count }),
    Result: ServerEvent,
    execute: ({ playerId, after }) => sql`
      SELECT seq, at, cause, type, data FROM server_events
      WHERE player_id = ${playerId} AND seq > ${after}
      ORDER BY seq
      LIMIT ${maxBehind}
    `,
  })

  const create = (profile: LocalProfile) =>
    Effect.gen(function* () {
      const now = yield* nowIso
      const rollSeed = randomBytes(32).toString("hex")
      const player: PlayerType = {
        id: ulids(randomBytes(16).toString("hex"), 0, now)(),
        githubUserId: null,
        githubLogin: null,
        displayName: profile.displayName,
        createdAt: now,
      }
      const state = initialState({ characterName: profile.characterName, timezone: profile.timezone, now })
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
        VALUES (${player.id}, NULL, NULL, ${player.displayName}, ${rollSeed}, ${player.createdAt})
      `
      yield* sql`
        INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
        VALUES (${player.id}, ${JSON.stringify(state)}::jsonb, 0, 0, 1, ${engineVersion}, ${rules.version})
      `
      return player
    }).pipe(sql.withTransaction)

  const local = (profile: LocalProfile) =>
    Effect.flatMap(firstPlayer(undefined), Option.match({ onSome: Effect.succeed, onNone: () => create(profile) }))

  const snapshot = (player: PlayerType) =>
    Effect.gen(function* () {
      const row = yield* head(player.id).pipe(Effect.orDie)
      const now = yield* nowIso
      return project(
        row.state,
        { rules, catalog, questPacks: [], now },
        { player, serverId: serverIdOf(player), streamEpoch: row.stream_epoch, cursor: row.server_seq },
      )
    })

  const streamAfter = (playerId: string, after: number) =>
    Effect.gen(function* () {
      const row = yield* head(playerId).pipe(Effect.orDie)
      const base = { rulesVersion: rules.version, minClientVersion }
      // Ahead of this stream (another server, a reset) or too far behind: reload the snapshot.
      if (after > row.server_seq || row.server_seq - after > maxBehind) {
        const resync: StreamResponse = { ...base, events: [], cursor: row.server_seq, resync: true }
        return resync
      }
      const events = yield* eventsAfter({ playerId, after })
      const response: StreamResponse = { ...base, events, cursor: events[events.length - 1]?.seq ?? after }
      return response
    })

  return Players.of({ local, snapshot, streamAfter })
})
