import { it } from "@effect/vitest"
import { engineVersion } from "@pathofdev/engine"
import { DevCommand } from "@pathofdev/schema"
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import type { GithubUser, PublicConfig, PublicVar } from "../src/index.ts"
import {
  BadConfig,
  defaultPort,
  defaultProfileOrigin,
  GitHub,
  publicClientId,
  publicConfigOf,
  publicEnvOf,
} from "../src/index.ts"
import { dump, hatch, prompt, publicWebHandler, session, testPublicServices } from "./fixtures.ts"

// The public server as its entry wires it: its settings from the environment, and its routes over the core, online,
// with the beta's accounts. GitHub is a table the test fills.
//
//   env ─▶ publicConfigOf ─▶ PublicConfig            (round trip; a missing or bad var named)
//   Request ─▶ PublicRoutes ─▶ publicServices(db, allowlist, FakeGitHub)
//     /healthz ─▶ 200 │ dev commands ─▶ refused │ a newer save ─▶ 503 + Retry-After, nothing written

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const Text = Schema.String.check(Schema.isPattern(/^[\x21-\x7e][\x20-\x7e]{0,40}$/))
const Config = Schema.Struct({
  databaseUrl: Text,
  allowedLogins: Text,
  adminGithubIds: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999 }))).check(
    Schema.isMaxLength(4),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  clientId: Text,
  clientSecret: Text,
  profileOrigin: Schema.String.check(Schema.isPattern(/^https?:\/\/[a-z][a-z0-9]{0,20}(\.[a-z]{2,6}){0,2}$/)),
})

const configOf = (drawn: typeof Config.Type): PublicConfig => ({
  databaseUrl: Redacted.make(drawn.databaseUrl),
  allowedLogins: drawn.allowedLogins,
  adminGithubIds: drawn.adminGithubIds,
  port: drawn.port,
  github: { clientId: drawn.clientId, clientSecret: Redacted.make(drawn.clientSecret) },
  profileOrigin: drawn.profileOrigin,
})

/** A config with its secrets read out, so two can be compared. */
const plain = (config: PublicConfig) => ({
  ...config,
  databaseUrl: Redacted.value(config.databaseUrl),
  github: { ...config.github, clientSecret: Redacted.value(config.github.clientSecret) },
})

const Required = Schema.Literals(["DATABASE_URL", "ALLOWED_LOGINS", "GITHUB_CLIENT_SECRET"])

describe("the public server's settings", () => {
  it.effect.prop("read back from the env they are written to", [Config], ([drawn]) =>
    Effect.gen(function* () {
      const config = configOf(drawn)
      expect(plain(yield* publicConfigOf(publicEnvOf(config)))).toEqual(plain(config))
    }))

  it.effect.prop(
    "stop the boot on a required var missing or empty, naming it and nothing it holds",
    [Config, Required, Schema.Boolean],
    ([drawn, name, isEmpty]) =>
      Effect.gen(function* () {
        const env: Record<string, string | undefined> = {
          ...publicEnvOf(configOf(drawn)),
          [name]: isEmpty ? "" : undefined,
        }
        const exit = yield* Effect.exit(publicConfigOf(env))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: name, isMissing: true })))
        const message = new BadConfig({ variable: name, isMissing: true }).message
        expect(message).toContain(name)
        for (const value of Object.values(env)) if (value !== undefined && value.length > 3) expect(message).not.toContain(value)
      }),
  )

  it.effect.prop(
    "stop the boot on a port that is not one, naming it",
    [Config, Schema.Literals(["http", "-1", "65536", "80.5", "0x"])],
    ([drawn, port]) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(publicConfigOf({ ...publicEnvOf(configOf(drawn)), PORT: port }))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "PORT", isMissing: false })))
      }),
  )

  it.effect.prop("take the port, the public client id and no admins by default", [Config], ([drawn]) =>
    Effect.gen(function* () {
      const env: Partial<Record<PublicVar, string>> = { ...publicEnvOf(configOf(drawn)) }
      delete env.PORT
      delete env.GITHUB_CLIENT_ID
      delete env.ADMIN_GITHUB_IDS
      delete env.PROFILE_ORIGIN
      const config = yield* publicConfigOf(env)
      expect(config.port).toBe(defaultPort)
      expect(config.github.clientId).toBe(publicClientId)
      expect(config.adminGithubIds).toEqual([])
      expect(config.profileOrigin).toBe(defaultProfileOrigin)
    }))

  it.effect.prop(
    "stop the boot on a profile origin that is not one: a path, a trailing slash, another scheme, not a URL",
    [Config, Schema.Literals(["/u", "/", "/u/"]), Schema.Literals(["ftp://pathof.dev", "pathof.dev", "https://", "u"])],
    ([drawn, path, junk]) =>
      Effect.gen(function* () {
        const env = publicEnvOf(configOf(drawn))
        for (const bad of [`${drawn.profileOrigin}${path}`, junk]) {
          const exit = yield* Effect.exit(publicConfigOf({ ...env, PROFILE_ORIGIN: bad }))
          expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "PROFILE_ORIGIN", isMissing: false })))
        }
      }),
  )

  it.effect.prop(
    "read admins separated by commas or spaces, and stop the boot on one that is no GitHub user id, naming it",
    [Config, Schema.Literals([",", " ", ", ", "\n"]), Schema.Literals(["ada", "-1", "0", "1.5", "0x10", "12a"])],
    ([drawn, separator, bad]) =>
      Effect.gen(function* () {
        const env = publicEnvOf(configOf(drawn))
        const spaced = { ...env, ADMIN_GITHUB_IDS: ` ${drawn.adminGithubIds.join(separator)} ` }
        expect((yield* publicConfigOf(spaced)).adminGithubIds).toEqual(drawn.adminGithubIds)
        const listed = [...drawn.adminGithubIds.map(String), bad].join(separator)
        const exit = yield* Effect.exit(publicConfigOf({ ...env, ADMIN_GITHUB_IDS: listed }))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "ADMIN_GITHUB_IDS", isMissing: false })))
      }),
  )
})

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────────

const ada: GithubUser = { id: 1, login: "Ada", name: "Ada Lovelace" }

/** GitHub as the test fills it: the account each token signs in as; any other token GitHub turns down. */
const FakeGitHub = (accounts: ReadonlyMap<string, GithubUser>) =>
  Layer.succeed(
    GitHub,
    GitHub.of({ user: (token) => Effect.succeed(Option.fromNullishOr(accounts.get(Redacted.value(token)))) }),
  )

/** The public build, as its entry wires it, over a fresh database: Ada, signed in with `ada-token`, is on the list. */
const withPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      testPublicServices({ allowedLogins: "ada", adminGithubIds: [] }, FakeGitHub(new Map([["ada-token", ada]]))),
    ),
  )

const request = (path: string, method: string, authorization: string | null, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** Ada signed in: her game token, as the Authorization header. */
const signedIn = (handle: (request: Request) => Effect.Effect<Response>) =>
  Effect.gen(function* () {
    const response = yield* handle(request("/v1/auth/github", "POST", null, { githubToken: "ada-token", timezone: "UTC" }))
    expect(response.status).toBe(200)
    const body = (yield* Effect.promise(() => response.json())) as { token: string; player: { id: string } }
    return { bearer: `Bearer ${body.token}`, playerId: body.player.id }
  })

const json = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>)

describe("the public build", () => {
  it.effect("answers the health check while the database does", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const response = yield* handle(request("/healthz", "GET", null))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.text())).toBe("ok")
      }),
    ))

  it.effect("acts for nobody without a token, though it holds a player", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        yield* signedIn(handle)
        const before = yield* dump
        expect((yield* handle(request("/v1/events", "POST", null, { events: [prompt(8)] }))).status).toBe(401)
        expect((yield* handle(request("/v1/sessions", "POST", null, { sessionId: session }))).status).toBe(401)
        expect(yield* dump).toEqual(before)
      }),
    ))

  it.effect.prop(
    "refuses every dev command, and the save stays as it was",
    [Schema.Array(DevCommand).check(Schema.isMinLength(1), Schema.isMaxLength(6))],
    ([commands]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer } = yield* signedIn(handle)
          const sql = yield* SqlClient.SqlClient
          const saved = sql`SELECT state, server_seq FROM player_state`
          const before = yield* saved
          const rolls = yield* sql`SELECT * FROM rolls`
          // Postgres's jsonb holds no NUL and no lone surrogate, so a string with one fails the write whatever the
          // command: the edge's to turn away (TODOS.md), not this property's.
          for (const command of commands.filter((one) => !/\\u(0000|d[89a-f])/i.test(JSON.stringify(one)))) {
            const response = yield* handle(request("/v1/commands", "POST", bearer, command))
            expect(response.status).toBe(200)
            expect(yield* json(response)).toMatchObject({ status: "refused", code: "not_allowed" })
          }
          expect(yield* saved).toEqual(before)
          expect(yield* sql`SELECT * FROM rolls`).toEqual(rolls)
          const opened = yield* handle(request("/v1/sessions", "POST", bearer, { sessionId: session }))
          expect(((yield* json(opened)) as { snapshot: { dev?: boolean } }).snapshot.dev).toBeUndefined()
        }),
      ),
    serverRuns,
  )
})

describe("the version guard", () => {
  const Write = Schema.Literals(["events", "command", "open", "close"])

  const requestOf = (write: typeof Write.Type, bearer: string): Request => {
    switch (write) {
      case "events":
        return request("/v1/events", "POST", bearer, { events: [prompt(8)] })
      case "command":
        return request("/v1/commands", "POST", bearer, hatch())
      case "open":
        return request("/v1/sessions", "POST", bearer, { sessionId: session, presence: true })
      case "close":
        return request(`/v1/sessions/${session}`, "DELETE", bearer)
    }
  }

  // The stream only reads: its heartbeat moves a session's last-heard time, outside the save, so it is left out here.
  it.effect.prop(
    "answers every write 503 with Retry-After, and writes nothing, while a newer build saved the player, and only then",
    [
      Schema.Int.check(Schema.isBetween({ minimum: -2, maximum: 3 })),
      Schema.Array(Write).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    ],
    ([ahead, writes]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer, playerId } = yield* signedIn(handle)
          // A session open, so closing it would write.
          expect((yield* handle(requestOf("open", bearer))).status).toBe(200)
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE player_state SET engine_version = ${engineVersion + ahead} WHERE player_id = ${playerId}`
          const before = yield* dump
          for (const write of writes) {
            const response = yield* handle(requestOf(write, bearer))
            if (ahead > 0) {
              expect({ write, status: response.status }).toEqual({ write, status: 503 })
              expect(response.headers.get("retry-after")).toBe("60")
              expect(yield* json(response)).toMatchObject({ _tag: "ServerBehind" })
            } else {
              expect({ write, status: response.status }).toEqual({ write, status: 200 })
            }
          }
          if (ahead > 0) expect(yield* dump).toEqual(before)
        }),
      ),
    { ...serverRuns, arbitrary: { runs: 12 } },
  )
})
