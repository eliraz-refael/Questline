import type {
  ChangeMerged,
  CommandUsed,
  CommitMade,
  ContextMeasured,
  PetHatch,
  PromptGraded,
  TurnCompleted,
} from "@pathofdev/schema"
import type { Player as PlayerType, ServerEvent } from "@pathofdev/schema"
import { PgClient } from "@effect/sql-pg"
import { PathOfDevApi } from "@pathofdev/schema"
import type { Scope } from "effect"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { TestClock } from "effect/testing"
import { randomUUID } from "node:crypto"
import { expect } from "vitest"
import type { BetaConfig, Database, GithubUser, LocalProfile, Stepper } from "../src/index.ts"
import {
  ApiRoutes,
  core,
  defaultProfileOrigin,
  GitHub,
  ModHandlers,
  OnlineRoutes,
  Players,
  PublicRoutes,
  publicServices,
  ServerRandom,
  services,
  sqlLayer,
} from "../src/index.ts"

// Test inputs and a server over a fresh database for every test: an in-memory PGlite, or a schema of its own in the
// Postgres that `PATHOFDEV_TEST_DATABASE_URL` names.

export const start = "2026-10-09T08:00:00.000Z"
export const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
export const profile: LocalProfile = { displayName: "Player", characterName: "Player", timezone: "UTC" }

/** Runs `body` with `vars` set in the environment (undefined unsets one), then puts back what was there. */
export const withEnv = <A>(vars: Record<string, string | undefined>, body: () => A): A => {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  set(vars)
  try {
    return body()
  } finally {
    set(saved)
  }
}

/** Every env var the local server reads its home and mode from, under its new name and its name from before. */
export const unnamed = {
  PATHOFDEV_HOME: undefined,
  QUESTLINE_HOME: undefined,
  PATHOFDEV_DEV: undefined,
  QUESTLINE_DEV: undefined,
}

const key = (char: string): string => char.repeat(64)

let ids = 0
/** ULIDs in order: the time part fixed, the counter in the random part. */
export const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

export const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

export const commit = (sha: string, occurredAt = start, id = nextId()): typeof CommitMade.Type => ({
  id,
  type: "commit.made",
  occurredAt,
  sessionId: session,
  data: { commit: { type: "github", repo: "acme/widgets", sha: sha.repeat(40), key: key("a") } },
})

export const merged = (number: number, id = nextId()): typeof ChangeMerged.Type => ({
  id,
  type: "change.merged",
  occurredAt: start,
  sessionId: session,
  data: { change: { type: "github", repo: "acme/widgets", number, key: key("b") } },
})

export const turn = (id = nextId()): typeof TurnCompleted.Type => ({
  id,
  type: "turn.completed",
  occurredAt: start,
  sessionId: session,
  data: { durationMs: 1000, toolCalls: 2 },
})

/** A prompt graded `score` on every dimension, regret included. */
export const prompt = (score: number, id = nextId()): typeof PromptGraded.Type => ({
  id,
  type: "prompt.graded",
  occurredAt: start,
  sessionId: session,
  data: {
    scores: {
      clarity: score,
      grammar: score,
      specificity: score,
      instructive: score,
      context: score,
      doneCriteria: score,
      focus: score,
      regret: score,
    },
    rubricVersion: 1,
    words: 12,
    grader: "haiku",
  },
})

export const commandUsed = (command: string, id = nextId()): typeof CommandUsed.Type => ({
  id,
  type: "command.used",
  occurredAt: start,
  sessionId: session,
  data: { command },
})

export const contextMeasured = (pct: number, id = nextId()): typeof ContextMeasured.Type => ({
  id,
  type: "context.measured",
  occurredAt: start,
  sessionId: session,
  data: { pct },
})

export const hatch = (id = nextId()): typeof PetHatch.Type => ({ id, type: "pet.hatch", data: { species: "fox", name: "Pixel" } })

/**
 * The events past the missions': which dailies a fresh player draws depends on its seed, so a test of something
 * else leaves the offers and their progress out.
 */
export const withoutQuests = (events: ReadonlyArray<ServerEvent>): Array<ServerEvent> =>
  events.filter((event) => !event.type.startsWith("quest."))

const testUrl = process.env["PATHOFDEV_TEST_DATABASE_URL"] || undefined

/** Runs `f` on a one-connection client to the test Postgres, outside any test's schema. */
const admin = <A>(url: string, f: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError>) =>
  Effect.scoped(Effect.flatMap(SqlClient.SqlClient, f)).pipe(
    Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
  )

/**
 * A fresh, empty database for one test: an in-memory PGlite or, when `PATHOFDEV_TEST_DATABASE_URL` names a Postgres,
 * a schema of its own there, dropped when the test ends. So test files run in parallel on one Postgres, and every test
 * starts as empty as it does on PGlite.
 */
export const freshDatabase: Effect.Effect<Database, SqlError, Scope.Scope> =
  testUrl === undefined ? Effect.succeed({ kind: "pglite" }) : Effect.gen(function* () {
    const schema = `test_${randomUUID().replaceAll("-", "")}`
    yield* Effect.acquireRelease(
      admin(testUrl, (sql) => sql`CREATE SCHEMA ${sql(schema)}`),
      () => Effect.orDie(admin(testUrl, (sql) => sql`DROP SCHEMA ${sql(schema)} CASCADE`)),
    )
    const database: Database = { kind: "postgres", url: Redacted.make(testUrl), schema, maxConnections: 4 }
    return database
  })

/** A SQL client over a fresh database, and the server's randomness, for a test of the tables alone. */
export const testSql = Layer.merge(Layer.unwrap(Effect.map(freshDatabase, sqlLayer)), ServerRandom.layer())

/** The services behind the routes, over a fresh database, with the clock at `start`; `dev`: dev mode. */
export const testServices = (stepper?: Stepper, dev = false, seed?: string) =>
  Layer.unwrap(
    Effect.map(freshDatabase, (database) =>
      Layer.mergeAll(services(database, profile, { stepper, dev, seed }), HttpServer.layerServices),
    ),
  ).pipe(Layer.provideMerge(Layer.effectDiscard(TestClock.setTime(Date.parse(start)))))

/**
 * The services behind an online server's routes, over a fresh database, with the clock at `start`; `auth` decides who
 * each request acts for, from what the core holds.
 */
export const testOnlineServices = <A, E>(auth: Layer.Layer<A, E, SqlClient.SqlClient | Players>) =>
  Layer.unwrap(
    Effect.map(freshDatabase, (database) =>
      Layer.mergeAll(auth.pipe(Layer.provideMerge(core("online", database))), HttpServer.layerServices),
    ),
  ).pipe(Layer.provideMerge(Layer.effectDiscard(TestClock.setTime(Date.parse(start)))))

/**
 * The public server's services over a fresh database, as its entry wires them, with the clock at `start`: the beta's
 * logins and admins of `beta`, and `github` answering for GitHub.
 */
export const testPublicServices = <E>(
  beta: BetaConfig & { readonly profileOrigin?: string },
  github: Layer.Layer<GitHub, E>,
) =>
  Layer.unwrap(
    Effect.map(freshDatabase, (database) =>
      Layer.mergeAll(
        publicServices(database, { profileOrigin: defaultProfileOrigin, ...beta }, github),
        HttpServer.layerServices,
      ),
    ),
  ).pipe(Layer.provideMerge(Layer.effectDiscard(TestClock.setTime(Date.parse(start)))))

/** Serves `app` as a Fetch handler in the calling test's context: its clock, its database, its `Authentication`. */
const fetchOf = <E>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest | Scope.Scope>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(context)(app)
    return (request: Request) => Effect.promise(() => handler(request))
  })

/**
 * A Fetch handler for the local server's routes, the mod's. Requests go in as Web requests, headers and all, and come
 * out as Web responses.
 */
export const webHandler = Effect.flatMap(HttpRouter.toHttpEffect(ApiRoutes), fetchOf)

/** A Fetch handler for the public server's routes: the mod's, signing in and out, and the beta list. */
export const onlineWebHandler = Effect.flatMap(HttpRouter.toHttpEffect(OnlineRoutes), fetchOf)

/**
 * A Fetch handler for the public server's routes as its entry serves them: the online ones, the profile pages and the
 * health check.
 */
export const publicWebHandler = Effect.flatMap(HttpRouter.toHttpEffect(PublicRoutes), fetchOf)

/** The local server's one player, whom its `Authentication` names for every request. */
export const localPlayer = Effect.gen(function* () {
  const players = yield* Players
  return yield* players.local(profile)
})

/** Every table a sign-in, a player's play or the beta list writes, as rows in a fixed order. */
const tables = [
  "players",
  "player_state",
  "event_log",
  "server_events",
  "rolls",
  "quarantine",
  "sessions",
  "api_tokens",
  "beta_logins",
] as const

/** Every row of every table a sign-in, a player's play or the beta list writes, to see that a request wrote nothing. */
export const dump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* Effect.forEach(tables, (table) => sql`SELECT * FROM ${sql(table)} ORDER BY 1, 2`)
})

/** A typed client wired straight to the handlers, with no socket in between. */
export const client = HttpApiTest.groups(PathOfDevApi, ["mod"])

/**
 * Runs a test against a fresh server: the handlers and the services behind them, over one database. `seed` seeds the
 * server's Random; from the OS when unset.
 */
export const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>, stepper?: Stepper, dev = false, seed?: string) =>
  effect.pipe(Effect.provide(ModHandlers.pipe(Layer.provideMerge(testServices(stepper, dev, seed)))))

// ── the public server, signed in ───────────────────────────────────────────────────────────────────────────────────────

/** GitHub as the test fills it: each account signs in with the token `<login>@<id>`. */
export const fakeGitHub = (users: ReadonlyArray<GithubUser>) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      user: (token) =>
        Effect.succeed(Option.fromNullishOr(users.find((user) => `${user.login}@${user.id}` === Redacted.value(token)))),
    }),
  )

export type Handle = (request: Request) => Effect.Effect<Response>

export const request = (path: string, method: string, authorization: string | null, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

export const json = (response: Response) => Effect.promise(() => response.json() as Promise<any>)

/** `account` signed in on the public server, as the mod does it: their game token, as the Authorization header, and their player. */
export const signIn = (handle: Handle, account: GithubUser) =>
  Effect.gen(function* () {
    const response = yield* handle(
      request("/v1/auth/github", "POST", null, { githubToken: `${account.login}@${account.id}`, timezone: "UTC" }),
    )
    expect({ login: account.login, status: response.status }).toEqual({ login: account.login, status: 200 })
    const body = (yield* json(response)) as { token: string; player: PlayerType }
    return { bearer: `Bearer ${body.token}`, player: body.player }
  })
