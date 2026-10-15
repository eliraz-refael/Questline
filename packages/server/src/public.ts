import { NodeHttpServer } from "@effect/platform-node"
import { Config, ConfigProvider, Data, Duration, Effect, Layer, Redacted } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import type { GitHubApp } from "./auth/github.ts"
import { GitHub, publicClientId } from "./auth/github.ts"
import { accounts } from "./auth/middleware.ts"
import { OnlineRoutes } from "./auth/routes.ts"
import type { Database } from "./db.ts"
import { core } from "./services.ts"

// The public server, api.pathof.dev: the same server build as the local one, wired for players who sign in. Postgres
// in place of PGlite, a game token in place of the local player, and the beta's allowlist; never dev mode, and never
// the local server's one player. Its settings come from the environment, read once at boot: a missing or bad one stops
// it, named.
//
//   env ─▶ publicConfigOf ─▶ PublicConfig (a var missing or bad stops the boot, named)
//     DATABASE_URL ──────────────▶ core("online"), dev mode off: Postgres, migrated; Players, PlayerWriter, Presence
//     ALLOWED_LOGINS ────────────▶ accounts: Tokens, Allowlist, BearerAuth
//     GITHUB_CLIENT_ID, _SECRET ─▶ GitHub: the token check, asked as the app
//       └─▶ publicServices ─▶ PublicRoutes (OnlineRoutes, Healthz, RetryAfter) ─▶ node http on PORT
//
// A request, from the mod over HTTPS:
//
//   Cloudflare (TLS; rate rule on /v1/auth/*) ─▶ Traefik (Coolify) ─▶ :PORT ─▶ HttpRouter
//     ├─ GET  /healthz ─────────────▶ SELECT 1 ─▶ 200, or 503 while the database doesn't answer
//     ├─ POST /v1/auth/github ──────▶ GitHub.user ─▶ Allowlist ─▶ Players.findOrCreate ─▶ Tokens.mint
//     ├─ POST /v1/auth/logout ──────▶ Tokens.revoke
//     └─ /v1/sessions, /v1/events, /v1/commands, /v1/stream
//          └─▶ BearerAuth (token ─▶ player ─▶ allowlist) ─▶ ModHandlers ─▶ PlayerWriter (version guard) ─▶ Postgres
//   every 503 leaves with Retry-After
//
// The log has each response's method, path (no query) and status, never a header, a body or a client address: the
// Authorization header, game tokens, GitHub tokens and the client secret stay out of it. Nothing here reads the
// client's address; when something does (a rate limiter), it takes CF-Connecting-IP, since Cloudflare proxies
// api.pathof.dev, and only from Cloudflare's own ranges.

/** The public server's settings. */
export interface PublicConfig {
  /** The Postgres the game lives in. */
  readonly databaseUrl: Redacted.Redacted<string>
  /** The beta's GitHub logins, as `ALLOWED_LOGINS` writes them. */
  readonly allowedLogins: string
  readonly port: number
  /** Path of Dev's OAuth app, which the server checks every GitHub token was issued to. */
  readonly github: GitHubApp
}

/** The env vars the public server reads, by name. */
export type PublicVar = "DATABASE_URL" | "ALLOWED_LOGINS" | "PORT" | "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET"

export const defaultPort = 3000

/** Each env var as the public server reads it: those with a default may be left unset. */
const vars = {
  DATABASE_URL: Config.Redacted("DATABASE_URL"),
  ALLOWED_LOGINS: Config.NonEmptyString("ALLOWED_LOGINS"),
  PORT: Config.Port("PORT").pipe(Config.withDefault(defaultPort)),
  GITHUB_CLIENT_ID: Config.NonEmptyString("GITHUB_CLIENT_ID").pipe(Config.withDefault(publicClientId)),
  GITHUB_CLIENT_SECRET: Config.Redacted("GITHUB_CLIENT_SECRET"),
} satisfies Record<PublicVar, Config.Config<unknown>>

export class BadConfig extends Data.TaggedError("BadConfig")<{
  readonly variable: PublicVar
  readonly isMissing: boolean
}> {
  override get message() {
    return this.isMissing
      ? `${this.variable} is not set: the public server needs it to start`
      : `${this.variable} is set, but not to something the public server can read`
  }
}

/** The settings `env` holds, or the first var missing or unreadable, by name; never what it holds. */
export const publicConfigOf = (env: Readonly<Record<string, string | undefined>>) => {
  // An empty var counts as unset, as `isMissing` says: one with a default takes it, a required one stops the boot.
  const set: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (value !== undefined && value !== "") set[name] = value
  const provider = ConfigProvider.fromEnv({ env: set })
  const read = <A>(variable: PublicVar, config: Config.Config<A>) =>
    config.parse(provider).pipe(
      Effect.mapError(() => new BadConfig({ variable, isMissing: (env[variable] ?? "") === "" })),
    )
  return Effect.gen(function* () {
    const config: PublicConfig = {
      databaseUrl: yield* read("DATABASE_URL", vars.DATABASE_URL),
      allowedLogins: yield* read("ALLOWED_LOGINS", vars.ALLOWED_LOGINS),
      port: yield* read("PORT", vars.PORT),
      github: {
        clientId: yield* read("GITHUB_CLIENT_ID", vars.GITHUB_CLIENT_ID),
        clientSecret: yield* read("GITHUB_CLIENT_SECRET", vars.GITHUB_CLIENT_SECRET),
      },
    }
    return config
  })
}

/** The env that `publicConfigOf` reads `config` from. */
export const publicEnvOf = (config: PublicConfig): Record<PublicVar, string> => ({
  DATABASE_URL: Redacted.value(config.databaseUrl),
  ALLOWED_LOGINS: config.allowedLogins,
  PORT: String(config.port),
  GITHUB_CLIENT_ID: config.github.clientId,
  GITHUB_CLIENT_SECRET: Redacted.value(config.github.clientSecret),
})

/** How long the database has to answer a health check. */
const healthTimeout = Duration.seconds(5)

/** How long a 503 asks the mod to wait: about a deploy's length, and what GitHub's hiccups usually last. */
export const retryAfter = Duration.seconds(60)

/**
 * `GET /healthz`: 200 while the database answers, 503 while it doesn't. Docker and Coolify ask it every few seconds,
 * so a healthy answer is left out of the log.
 */
export const Healthz = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const answers = sql`SELECT 1`.pipe(
      Effect.timeout(healthTimeout),
      Effect.as(true),
      Effect.catchCause((cause) => Effect.as(Effect.logWarning("The database did not answer a health check", cause), false)),
    )
    yield* router.add(
      "GET",
      "/healthz",
      Effect.gen(function* () {
        if (!(yield* answers)) return HttpServerResponse.text("The database is not answering", { status: 503 })
        return yield* HttpMiddleware.withLoggerDisabled(Effect.succeed(HttpServerResponse.text("ok")))
      }),
    )
  })
)

/**
 * Every 503 says when to try again: a save a newer build wrote (a deploy rolling out), GitHub unable to check a
 * sign-in, the database down. The mod keeps its queue on any 5xx and tries again later either way.
 */
export const RetryAfter = HttpRouter.middleware(
  (app) =>
    Effect.map(app, (response) =>
      response.status === 503 && response.headers["retry-after"] === undefined
        ? HttpServerResponse.setHeader(response, "retry-after", String(Duration.toSeconds(retryAfter)))
        : response
    ),
  { global: true },
)

/** The public server's routes: the mod's, signing in and out, and the health check. */
export const PublicRoutes = Layer.mergeAll(OnlineRoutes, Healthz, RetryAfter)

/**
 * Everything behind the public server's routes, over `database`: the core, online and never in dev mode; the beta's
 * accounts on the logins `allowlist` names; and `github`, which checks a sign-in.
 */
export const publicServices = <E>(database: Database, allowlist: string, github: Layer.Layer<GitHub, E>) =>
  Layer.mergeAll(accounts(allowlist), github).pipe(Layer.provideMerge(core("online", database)))

/** The public server, listening on `config.port` until the scope closes. */
export const publicServer = (config: PublicConfig) =>
  HttpRouter.serve(PublicRoutes).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: config.port })),
    Layer.provide(
      publicServices({ kind: "postgres", url: config.databaseUrl }, config.allowedLogins, GitHub.layer(config.github)),
    ),
  )
