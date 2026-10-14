import { engineVersion, initialState, project } from "@pathofdev/engine"
import type { Player as PlayerType, Snapshot, StreamResponse } from "@pathofdev/schema"
import { Count, Player, PlayerState, ServerEvent } from "@pathofdev/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { catalog, DevMode, minClientVersion, nowIso, rules } from "./game.ts"
import { QuestPacks } from "./quest-packs.ts"
import { ServerRandom } from "./random.ts"

// Who the players are, and reads of a player that never change one: the snapshot the mod draws, and the stream after
// a cursor. A player is made here, with their state; every later write goes through the PlayerWriter. Which player a
// request acts for is the server's `Authentication`: the local server's one player, or the public server's by token.

/** How the game names and times a new player. The local server plays as one, from the OS account. */
export interface LocalProfile {
  readonly displayName: string
  readonly characterName: string
  /** IANA zone, for local days. */
  readonly timezone: string
}

/** A player's GitHub account: the id is who they are, the login only what they are called today. */
export interface GithubIdentity {
  readonly userId: number
  readonly login: string
}

/** A player to make: a profile, and the GitHub account they signed in with, if any. */
export interface NewPlayer extends LocalProfile {
  readonly github: GithubIdentity | null
}

/** Which server a player lives on, which names the stream the mod keys its cursor, cache and queue on. */
export type ServerKind = "local" | "online"

/** A mod more than this many events behind reloads the snapshot instead. */
export const maxBehind = 1000

type Failure = SqlError | Schema.SchemaError

export class Players extends Context.Service<
  Players,
  {
    /** The local server's player, created on first start. */
    readonly local: (profile: LocalProfile) => Effect.Effect<PlayerType, Failure>
    /** Makes a player, with a fresh state and roll seed. A GitHub account that already has one is a defect. */
    readonly create: (player: NewPlayer) => Effect.Effect<PlayerType, Failure>
    /**
     * The player of a GitHub account, made on its first sign-in: the same player however often it is asked for,
     * even by two sign-ins at once.
     */
    readonly findOrCreate: (
      player: NewPlayer & { readonly github: GithubIdentity },
    ) => Effect.Effect<PlayerType, Failure>
    readonly snapshot: (player: PlayerType) => Effect.Effect<Snapshot, Failure>
    /** The stream after `after`, answered from what is committed now. */
    readonly streamAfter: (playerId: string, after: number) => Effect.Effect<StreamResponse, Failure>
  }
>()("pathofdev/Players") {
  /** The players of a `kind` server. */
  static readonly layer = (kind: ServerKind) => Layer.effect(Players, Effect.suspend(() => make(kind)))
}

/** The id the mod keys its cursor, cache and queue on: a player's stream on a `kind` server. */
export const serverIdOf = (kind: ServerKind, player: PlayerType): string => `${kind}-${player.id}`

const make = (kind: ServerKind) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const random = yield* ServerRandom
    const devMode = yield* DevMode
    const questPacks = yield* QuestPacks

    const playerColumns = sql`
      id, github_user_id::float8 AS "githubUserId", github_login AS "githubLogin",
      display_name AS "displayName", created_at AS "createdAt"
    `

    const firstPlayer = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Player,
      execute: () => sql`SELECT ${playerColumns} FROM players ORDER BY created_at LIMIT 1`,
    })

    const byGithub = SqlSchema.findOneOption({
      Request: Schema.Number,
      Result: Player,
      execute: (userId) => sql`SELECT ${playerColumns} FROM players WHERE github_user_id = ${userId}`,
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

    /**
     * Inserts the player and their state, unless their GitHub account already has a player: then it writes nothing
     * and answers none. A sign-in racing another waits on the unique id, then sees the row the other committed.
     */
    const insert = (profile: NewPlayer) =>
      Effect.gen(function* () {
        const now = yield* nowIso
        const rollSeed = yield* random.rollSeed
        const player: PlayerType = {
          id: yield* random.id(now),
          githubUserId: profile.github?.userId ?? null,
          githubLogin: profile.github?.login ?? null,
          displayName: profile.displayName,
          createdAt: now,
        }
        const inserted = yield* sql`
          INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
          VALUES (
            ${player.id}, ${player.githubUserId}, ${player.githubLogin}, ${player.displayName}, ${rollSeed},
            ${player.createdAt}
          )
          ON CONFLICT (github_user_id) DO NOTHING
          RETURNING id
        `
        if (inserted.length === 0) return Option.none<PlayerType>()
        const state = initialState({ characterName: profile.characterName, timezone: profile.timezone, now })
        yield* sql`
          INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
          VALUES (${player.id}, ${JSON.stringify(state)}::jsonb, 0, 0, 1, ${engineVersion}, ${rules.version})
        `
        return Option.some(player)
      })

    const create = (profile: NewPlayer) =>
      Effect.flatMap(
        insert(profile),
        Option.match({
          onSome: Effect.succeed,
          onNone: () => Effect.die(new Error(`GitHub user ${profile.github?.userId} already has a player`)),
        }),
      ).pipe(sql.withTransaction)

    const findOrCreate = (profile: NewPlayer & { readonly github: GithubIdentity }) =>
      Effect.gen(function* () {
        const found = yield* byGithub(profile.github.userId)
        if (Option.isSome(found)) return found.value
        const made = yield* insert(profile)
        if (Option.isSome(made)) return made.value
        // Another sign-in made the player between the look and the insert.
        const raced = yield* byGithub(profile.github.userId)
        if (Option.isSome(raced)) return raced.value
        return yield* Effect.die(new Error(`No player for GitHub user ${profile.github.userId} after a conflict`))
      }).pipe(sql.withTransaction)

    const local = (profile: LocalProfile) =>
      Effect.flatMap(
        firstPlayer(undefined),
        Option.match({ onSome: Effect.succeed, onNone: () => create({ ...profile, github: null }) }),
      )

    const snapshot = (player: PlayerType) =>
      Effect.gen(function* () {
        const row = yield* head(player.id).pipe(Effect.orDie)
        const now = yield* nowIso
        return project(
          row.state,
          { rules, catalog, questPacks: questPacks.active, now },
          {
            player,
            serverId: serverIdOf(kind, player),
            streamEpoch: row.stream_epoch,
            cursor: row.server_seq,
            dev: devMode.isOn,
          },
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

    return Players.of({ local, create, findOrCreate, snapshot, streamAfter })
  })
