import type { BetaEntry } from "@pathofdev/schema"
import { Context, Duration, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { nowIso } from "../game.ts"

// The closed beta: who plays on the public server. Three lists let a player in, and any one of them is enough:
//
//   ALLOWED_LOGINS    env, read at boot ──────────────┐  by GitHub login, in any case
//   beta_logins       table, the admins keep it ──────┼─▶ allows(account) ─▶ in, or 401 "not in the beta"
//   ADMIN_GITHUB_IDS  env, read at boot ──────────────┘  by GitHub user id, never by login: a login can be reused
//                                                        after a rename, an id never
//
// It is asked at sign-in and again on every request, so taking a login off locks that player out on their next
// request, token or not; and so it is answered from memory, with no query. The table's logins sit in a Ref:
//
//   boot ─────────────▶ load ─┐
//   every 30 s ───────▶ load ─┼─▶ Ref(table's logins, lower case) ─▶ allows: admins ∋ id ∨ env ∋ login ∨ Ref ∋ login
//   admin add/remove ─▶ write ┘      the write, then the Ref at once
//
// The server runs one replica, so an admin's change is in the Ref before its answer leaves; the 30-second load is the
// safety net, for rows written straight to the table. Loads and writes take one lock, so a load that read the table
// just before a write never puts back what the write changed. A load that fails is logged, and the Ref kept.

/** How often the table is read again into memory. */
export const refreshEvery = Duration.seconds(30)

/** The logins `raw` lists, as `ALLOWED_LOGINS` writes them: separated by commas or white space, in any case. */
export const loginsOf = (raw: string): ReadonlySet<string> =>
  new Set(raw.split(/[\s,]+/u).flatMap((login) => (login === "" ? [] : [login.toLowerCase()])))

/** Whether `login` is on the list: GitHub logins are one account whatever their case. A player with none is not. */
export const isAllowed = (logins: ReadonlySet<string>, login: string | null): boolean =>
  login !== null && logins.has(login.toLowerCase())

/**
 * The GitHub user ids `raw` lists, as `ADMIN_GITHUB_IDS` writes them: separated by commas or white space; none when it
 * is empty. Null when any of them is not a GitHub user id (a whole number from 1), so a typo stops the boot.
 */
export const adminIdsOf = (raw: string): ReadonlyArray<number> | null => {
  const ids = raw.split(/[\s,]+/u).filter((id) => id !== "")
  return ids.every((id) => /^[1-9][0-9]{0,14}$/.test(id)) ? ids.map(Number) : null
}

/** Who the beta lets in, as the public server reads it from its env at boot. */
export interface BetaConfig {
  /** The logins `ALLOWED_LOGINS` lists, as it writes them. */
  readonly allowedLogins: string
  /** The GitHub user ids of the server's admins. */
  readonly adminGithubIds: ReadonlyArray<number>
}

/** An account as the allowlist asks about it: a player, or who GitHub says signs in. */
export interface BetaAccount {
  readonly githubUserId: number | null
  readonly githubLogin: string | null
}

/** What else lets a login in, past the table: `ALLOWED_LOGINS`, or an admin whose player goes by it now. */
export interface Standing {
  readonly isListed: boolean
  readonly isAdmin: boolean
}

type Failure = SqlError | Schema.SchemaError

const Added = Schema.Struct({ login: Schema.String, addedBy: Schema.Int, addedAt: Schema.String })
const AdminPlayer = Schema.Struct({ githubUserId: Schema.Int, githubLogin: Schema.NullOr(Schema.String) })

export class Allowlist extends Context.Service<
  Allowlist,
  {
    /** Whether the account plays: an admin by id, or a login on either list. Answered from memory. */
    readonly allows: (account: BetaAccount) => Effect.Effect<boolean>
    /** Whether the GitHub user id is one of the server's admins'. */
    readonly isAdmin: (githubUserId: number | null) => boolean
    /** Everyone the beta lets in: the logins added, oldest first, then `ALLOWED_LOGINS`'s, then the admins. */
    readonly entries: Effect.Effect<ReadonlyArray<BetaEntry>, Failure>
    /** Adds a login to the table, for the admin `by`; false when it was there already, in any case. */
    readonly add: (login: string, by: number) => Effect.Effect<boolean, SqlError>
    /** Takes a login off the table, in any case; false when it was not there. */
    readonly remove: (login: string) => Effect.Effect<boolean, SqlError>
    /** What else lets `login` in: the lists the API can't change. */
    readonly standing: (login: string) => Effect.Effect<Standing, Failure>
    /** Reads the table again into memory. */
    readonly refresh: Effect.Effect<void, SqlError>
  }
>()("pathofdev/Allowlist") {
  /**
   * The beta of `config` over the table, loaded now and read again every `refreshEvery` for as long as the layer
   * lives. An empty `ALLOWED_LOGINS`, table and admin list let nobody in.
   */
  static readonly layer = (config: BetaConfig) => Layer.effect(Allowlist, make(config))
}

const make = (config: BetaConfig) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const listed = loginsOf(config.allowedLogins)
    const admins = new Set(config.adminGithubIds)
    const lock = yield* Semaphore.make(1)

    const load = Effect.map(
      sql<{ login: string }>`SELECT lower(login) AS login FROM beta_logins`,
      (rows): ReadonlySet<string> => new Set(rows.map((row) => row.login)),
    )
    const added = yield* Ref.make(yield* load)

    const refresh = lock.withPermits(1)(Effect.flatMap(load, (logins) => Ref.set(added, logins)))

    const isAdmin = (githubUserId: number | null) => githubUserId !== null && admins.has(githubUserId)

    const allows = (account: BetaAccount) =>
      isAdmin(account.githubUserId) || isAllowed(listed, account.githubLogin)
        ? Effect.succeed(true)
        : Effect.map(Ref.get(added), (logins) => isAllowed(logins, account.githubLogin))

    const add = (login: string, by: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const inserted = yield* sql`
            INSERT INTO beta_logins (login, added_by, added_at) VALUES (${login}, ${by}, ${yield* nowIso})
            ON CONFLICT DO NOTHING
            RETURNING login
          `
          yield* Ref.update(added, (logins) => new Set(logins).add(login.toLowerCase()))
          return inserted.length > 0
        }),
      )

    const remove = (login: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const deleted = yield* sql`
            DELETE FROM beta_logins WHERE lower(login) = ${login.toLowerCase()} RETURNING login
          `
          yield* Ref.update(added, (logins) => {
            const kept = new Set(logins)
            kept.delete(login.toLowerCase())
            return kept
          })
          return deleted.length > 0
        }),
      )

    const addedRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Added,
      execute: () => sql`
        SELECT login, added_by::float8 AS "addedBy", added_at AS "addedAt" FROM beta_logins ORDER BY added_at, login
      `,
    })

    // The players of the admins who signed in: an admin is named by the login they last signed in with.
    const adminPlayers = SqlSchema.findAll({
      Request: Schema.Void,
      Result: AdminPlayer,
      execute: () => sql`
        SELECT github_user_id::float8 AS "githubUserId", github_login AS "githubLogin" FROM players
        WHERE github_user_id IN ${sql.in([...admins])}
      `,
    })
    const adminLogins = admins.size === 0 ? Effect.succeed([]) : adminPlayers(undefined)

    const entries = Effect.gen(function* () {
      const rows = yield* addedRows(undefined)
      const named = new Map((yield* adminLogins).map((player) => [player.githubUserId, player.githubLogin]))
      return [
        ...rows.map((row): BetaEntry => ({ source: "added", ...row })),
        ...[...listed].map((login): BetaEntry => ({ source: "env", login })),
        ...[...admins].map((id): BetaEntry => ({ source: "admin", githubUserId: id, login: named.get(id) ?? null })),
      ]
    })

    const standing = (login: string) =>
      Effect.map(adminLogins, (players): Standing => ({
        isListed: isAllowed(listed, login),
        isAdmin: players.some((player) => player.githubLogin?.toLowerCase() === login.toLowerCase()),
      }))

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(refreshEvery).pipe(
          Effect.andThen(refresh),
          Effect.catchCause((cause) => Effect.logWarning("Could not read the beta list again", cause)),
        ),
      ),
    )

    return Allowlist.of({ allows, isAdmin, entries, add, remove, standing, refresh })
  })
