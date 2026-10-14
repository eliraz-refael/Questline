import type {
  ChangeMerged,
  CommandUsed,
  CommitMade,
  ContextMeasured,
  PetHatch,
  PromptGraded,
  TurnCompleted,
} from "@pathofdev/schema"
import type { ServerEvent } from "@pathofdev/schema"
import { PgClient } from "@effect/sql-pg"
import { PathOfDevApi } from "@pathofdev/schema"
import type { Scope } from "effect"
import { Effect, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { TestClock } from "effect/testing"
import { randomUUID } from "node:crypto"
import type { Database, LocalProfile, Stepper } from "../src/index.ts"
import { ApiRoutes, core, ModHandlers, OnlineRoutes, Players, ServerRandom, services, sqlLayer } from "../src/index.ts"

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

/** A Fetch handler for the public server's routes: the mod's, and signing in and out. */
export const onlineWebHandler = Effect.flatMap(HttpRouter.toHttpEffect(OnlineRoutes), fetchOf)

/** The local server's one player, whom its `Authentication` names for every request. */
export const localPlayer = Effect.gen(function* () {
  const players = yield* Players
  return yield* players.local(profile)
})

/** A typed client wired straight to the handlers, with no socket in between. */
export const client = HttpApiTest.groups(PathOfDevApi, ["mod"])

/**
 * Runs a test against a fresh server: the handlers and the services behind them, over one database. `seed` seeds the
 * server's Random; from the OS when unset.
 */
export const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>, stepper?: Stepper, dev = false, seed?: string) =>
  effect.pipe(Effect.provide(ModHandlers.pipe(Layer.provideMerge(testServices(stepper, dev, seed)))))
