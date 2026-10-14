import type { Player as PlayerType } from "@pathofdev/schema"
import { Player } from "@pathofdev/schema"
import type { Option } from "effect"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Buffer } from "node:buffer"
import { createHash, randomBytes } from "node:crypto"
import { nowIso } from "../game.ts"
import { playerColumns } from "../players.ts"

// Game tokens: what a signed-in mod sends as `Authorization: Bearer <token>`. A token is `pod_` and 32 random bytes
// from the OS in base64url, shown once, at sign-in. The database keeps only its SHA-256, so a copy of the table signs
// nobody in, and a token is found only in the exact spelling it was minted in. Revoking one deletes its row: final.

export const tokenPrefix = "pod_"

const tokenBytes = 32

/** The token that spells `bytes`. */
export const tokenOf = (bytes: Uint8Array): string => tokenPrefix + Buffer.from(bytes).toString("base64url")

/** The bytes a token spells, or null when it is not one as `tokenOf` writes it. */
export const bytesOf = (token: string): Uint8Array | null => {
  const body = token.startsWith(tokenPrefix) ? token.slice(tokenPrefix.length) : ""
  if (!/^[A-Za-z0-9_-]{43}$/.test(body)) return null
  const bytes = new Uint8Array(Buffer.from(body, "base64url"))
  // 43 characters hold 258 bits: only the spelling whose last 2 are zero is the token.
  return bytes.length === tokenBytes && tokenOf(bytes) === token ? bytes : null
}

/** What the database keeps of a token. */
export const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex")

type Failure = SqlError | Schema.SchemaError

export class Tokens extends Context.Service<
  Tokens,
  {
    /** A new token for the player, kept as its hash: the only time it is ever seen whole. */
    readonly mint: (playerId: string) => Effect.Effect<string, SqlError>
    /** The player a token names; none for anything but a token minted and not revoked. */
    readonly playerOf: (token: string) => Effect.Effect<Option.Option<PlayerType>, Failure>
    /** Revokes a token for good; false when it names nothing. */
    readonly revoke: (token: string) => Effect.Effect<boolean, SqlError>
  }
>()("pathofdev/Tokens") {
  static readonly layer = Layer.effect(
    Tokens,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const byHash = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Player,
        execute: (hash) => sql`
          SELECT ${playerColumns(sql)} FROM players
          WHERE id = (SELECT player_id FROM api_tokens WHERE token_hash = ${hash})
        `,
      })

      const mint = (playerId: string) =>
        Effect.gen(function* () {
          const token = tokenOf(yield* Effect.sync(() => randomBytes(tokenBytes)))
          yield* sql`
            INSERT INTO api_tokens (token_hash, player_id, created_at)
            VALUES (${hashOf(token)}, ${playerId}, ${yield* nowIso})
          `
          return token
        })

      // Anything that is not a token is turned away before the database is asked.
      const playerOf = (token: string) =>
        bytesOf(token) === null ? Effect.succeedNone : byHash(hashOf(token))

      const revoke = (token: string) =>
        bytesOf(token) === null
          ? Effect.succeed(false)
          : Effect.map(
            sql`DELETE FROM api_tokens WHERE token_hash = ${hashOf(token)} RETURNING token_hash`,
            (rows) => rows.length > 0,
          )

      return Tokens.of({ mint, playerOf, revoke })
    }),
  )
}
