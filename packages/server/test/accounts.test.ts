import { it } from "@effect/vitest"
import { GitHubUnavailable, Name } from "@pathofdev/schema"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import type { GithubUser } from "../src/index.ts"
import {
  Allowlist,
  BearerAuth,
  bytesOf,
  GitHub,
  isAllowed,
  loginsOf,
  newPlayerOf,
  notInBeta,
  Players,
  tokenOf,
  tokenPrefix,
  Tokens,
} from "../src/index.ts"
import { hatch, onlineWebHandler, prompt, session, testOnlineServices } from "./fixtures.ts"

// Accounts on the public server, end to end through its routes. GitHub is a table the test fills, and the beta's
// allowlist a set it changes mid-test, so a test can take a player off the list after they signed in:
//
//   POST /v1/auth/github ─▶ FakeGitHub(token → user) ─▶ allowlist ─▶ findOrCreate ─▶ mint ─▶ { token, player }
//   any route + Bearer ──▶ BearerAuth ─▶ Tokens.playerOf(hash) ─▶ allowlist ─▶ handler

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

/** A token GitHub can't check: asking about it finds GitHub down. */
const githubDown = "down"

/** GitHub as the test fills it: the account each token signs in as; any other token GitHub turns down. */
const FakeGitHub = (accounts: ReadonlyMap<string, GithubUser>) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      user: (token) =>
        Redacted.value(token) === githubDown
          ? Effect.fail(new GitHubUnavailable({ message: "GitHub is down" }))
          : Effect.succeed(Option.fromNullishOr(accounts.get(Redacted.value(token)))),
    }),
  )

/** An allowlist the test changes as it runs. */
const LiveAllowlist = (allowed: Set<string>) =>
  Layer.succeed(Allowlist, Allowlist.of({ allows: (login) => isAllowed(allowed, login) }))

/** The public server's routes and accounts over a fresh database, with GitHub's `accounts` and the list `allowed`. */
const withAccounts = (accounts: ReadonlyMap<string, GithubUser>, allowed: Set<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        testOnlineServices(
          BearerAuth.pipe(
            Layer.provideMerge(Tokens.layer),
            Layer.provideMerge(LiveAllowlist(allowed)),
            Layer.provideMerge(FakeGitHub(accounts)),
          ),
        ),
      ),
    )

const ada: GithubUser = { id: 1, login: "Ada", name: "Ada Lovelace" }
const bob: GithubUser = { id: 2, login: "bob", name: null }

const request = (path: string, method: string, authorization: string | null, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const signInRequest = (githubToken: string, timezone = "Asia/Jerusalem") =>
  request("/v1/auth/github", "POST", null, { githubToken, timezone })

/** Signs in with `githubToken`, and answers the game token. */
const signIn = (handle: (request: Request) => Effect.Effect<Response>, githubToken: string) =>
  Effect.gen(function* () {
    const response = yield* handle(signInRequest(githubToken))
    expect(response.status).toBe(200)
    const body = (yield* Effect.promise(() => response.json())) as { token: string; player: { id: string } }
    return body
  })

/** Every table a sign-in or a player's play writes, as rows in a fixed order. */
const tables = [
  "players",
  "player_state",
  "event_log",
  "server_events",
  "rolls",
  "quarantine",
  "sessions",
  "api_tokens",
] as const
const dump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* Effect.forEach(tables, (table) => sql`SELECT * FROM ${sql(table)} ORDER BY 1, 2`)
})

// ── tokens ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const Bytes = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
  Schema.isMinLength(32),
  Schema.isMaxLength(32),
)

describe("a game token", () => {
  it.prop("reads back as the bytes it was minted from", [Bytes], ([bytes]) => {
    const token = tokenOf(Uint8Array.from(bytes))
    expect(token.startsWith(tokenPrefix)).toBe(true)
    expect(bytesOf(token)).toEqual(Uint8Array.from(bytes))
  })

  it.prop("is read only in the one spelling it is written in", [Schema.String], ([text]) => {
    const bytes = bytesOf(text)
    if (bytes !== null) expect(tokenOf(bytes)).toBe(text)
  })
})

describe("Tokens", () => {
  it.effect.prop(
    "names the player each was minted for, keeps no token whole, and a revoked one never again",
    [Schema.Array(Schema.Literals([0, 1, 2])).check(Schema.isMinLength(1), Schema.isMaxLength(6))],
    ([owners]) =>
      withAccounts(new Map(), new Set())(
        Effect.gen(function* () {
          const players = yield* Players
          const tokens = yield* Tokens
          const made = yield* Effect.forEach([1, 2, 3], (userId) =>
            players.findOrCreate({
              displayName: `p${userId}`,
              characterName: `p${userId}`,
              timezone: "UTC",
              github: { userId, login: `p${userId}` },
            }))
          const minted = yield* Effect.forEach(owners, (owner) =>
            Effect.map(tokens.mint(made[owner]!.id), (token) => ({ owner, token })))

          for (const { owner, token } of minted) {
            expect(Option.map(yield* tokens.playerOf(token), (player) => player.id)).toEqual(Option.some(made[owner]!.id))
          }
          // Postgres reads a bigint column as a BigInt, which JSON has no form for.
          const stored = JSON.stringify(yield* dump, (_, value) => (typeof value === "bigint" ? String(value) : value))
          for (const { token } of minted) {
            expect(stored).not.toContain(token)
            expect(stored).not.toContain(token.slice(tokenPrefix.length))
          }

          const [revoked, ...kept] = minted
          expect(yield* tokens.revoke(revoked!.token)).toBe(true)
          expect(yield* tokens.playerOf(revoked!.token)).toEqual(Option.none())
          expect(yield* tokens.revoke(revoked!.token)).toBe(false)
          for (const { owner, token } of kept) {
            expect(Option.map(yield* tokens.playerOf(token), (player) => player.id)).toEqual(Option.some(made[owner]!.id))
          }
        }),
      ),
    serverRuns,
  )
})

// ── the allowlist ────────────────────────────────────────────────────────────────────────────────────────────────────

const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/))
const Separator = Schema.Literals([",", " ", ", ", "\n", " ,\t"])

/** `login` with the case of each letter flipped where `flips` says. */
const recase = (login: string, flips: ReadonlyArray<boolean>) =>
  [...login].map((char, i) => (flips[i % Math.max(1, flips.length)] === true ? (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()) : char)).join("")

describe("the allowlist", () => {
  it.prop(
    "lets in every login it lists, in any case, and no other",
    [Schema.Array(Login).check(Schema.isMaxLength(6)), Separator, Login, Schema.Array(Schema.Boolean)],
    ([listed, separator, someone, flips]) => {
      const logins = loginsOf(listed.join(separator))
      for (const login of listed) expect(isAllowed(logins, recase(login, flips))).toBe(true)
      const listedLower = new Set(listed.map((login) => login.toLowerCase()))
      expect(isAllowed(logins, someone)).toBe(listedLower.has(someone.toLowerCase()))
      expect(isAllowed(logins, null)).toBe(false)
    },
  )

  it.prop("reads the same list from what it read", [Schema.String], ([raw]) => {
    const logins = loginsOf(raw)
    expect(loginsOf([...logins].join(","))).toEqual(logins)
  })
})

describe("a first sign-in", () => {
  it.prop(
    "makes a player whose character name is a name, and who is called something",
    [Schema.Int, Login, Schema.NullOr(Schema.String)],
    ([id, login, name]) => {
      const player = newPlayerOf({ id, login, name }, "UTC")
      expect(Schema.is(Name)(player.characterName)).toBe(true)
      expect(player.displayName.length).toBeGreaterThan(0)
      expect(player.github).toEqual({ userId: id, login })
    },
  )
})

// ── through the routes ───────────────────────────────────────────────────────────────────────────────────────────────

describe("signing in", () => {
  it.effect.prop(
    "with a token GitHub turns down is answered 401, and writes nothing",
    [Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(5))],
    ([githubTokens]) =>
      withAccounts(new Map([["ada-token", ada]]), new Set(["ada"]))(
        Effect.gen(function* () {
          const handle = yield* onlineWebHandler
          const before = yield* dump
          for (const githubToken of githubTokens.filter((token) => token !== "ada-token" && token !== githubDown)) {
            expect((yield* handle(signInRequest(githubToken))).status).toBe(401)
          }
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )

  it.effect(
    "while GitHub is down is answered 503, and writes nothing",
    () =>
      withAccounts(new Map([["ada-token", ada]]), new Set(["ada"]))(
        Effect.gen(function* () {
          const handle = yield* onlineWebHandler
          const before = yield* dump
          expect((yield* handle(signInRequest(githubDown))).status).toBe(503)
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns.timeout,
  )

  it.effect.prop(
    "lets in a login on the list in any case, and nobody off it, whose sign-in writes nothing",
    [Schema.Array(Schema.Boolean)],
    ([flips]) => {
      const allowed = new Set([recase("ada", flips).toLowerCase()])
      return withAccounts(new Map([["ada-token", { ...ada, login: recase("Ada", flips) }], ["bob-token", bob]]), allowed)(
        Effect.gen(function* () {
          const handle = yield* onlineWebHandler
          const before = yield* dump
          const refused = yield* handle(signInRequest("bob-token"))
          expect(refused.status).toBe(401)
          expect(yield* Effect.promise(() => refused.json())).toMatchObject({ message: notInBeta })
          expect(yield* dump).toEqual(before)
          const { player } = yield* signIn(handle, "ada-token")
          expect(player).toMatchObject({ githubUserId: ada.id, githubLogin: recase("Ada", flips) })
        }),
      )
    },
    serverRuns,
  )

  it.effect("signs a player in again as the same player, under a new token each time", () =>
    withAccounts(new Map([["ada-token", ada]]), new Set(["ada"]))(
      Effect.gen(function* () {
        const handle = yield* onlineWebHandler
        const first = yield* signIn(handle, "ada-token")
        const second = yield* signIn(handle, "ada-token")
        expect(second.player).toEqual(first.player)
        expect(second.token).not.toBe(first.token)
        for (const { token } of [first, second]) {
          expect((yield* handle(request("/v1/sessions", "POST", `Bearer ${token}`, { sessionId: session }))).status).toBe(200)
        }
      }),
    ))

  // The race this guards is Postgres's: PGlite runs one transaction at a time, so there it passes trivially.
  it.effect("by the same account several times at once makes one player", () =>
    withAccounts(new Map([["ada-token", ada]]), new Set(["ada"]))(
      Effect.gen(function* () {
        const handle = yield* onlineWebHandler
        const answers = yield* Effect.all(Array.from({ length: 6 }, () => signIn(handle, "ada-token")), {
          concurrency: "unbounded",
        })
        expect(new Set(answers.map((answer) => answer.player.id)).size).toBe(1)
        expect(new Set(answers.map((answer) => answer.token)).size).toBe(6)
        const sql = yield* SqlClient.SqlClient
        const [counts] = yield* sql<{ players: number; states: number }>`
          SELECT (SELECT count(*)::int FROM players) AS players, (SELECT count(*)::int FROM player_state) AS states
        `
        expect(counts).toEqual({ players: 1, states: 1 })
      }),
    ), 120_000)
})

describe("a request on the public server", () => {
  const Endpoint = Schema.Literals(["openSession", "closeSession", "sendEvents", "runCommand", "stream", "signOut"])
  /** What a request may carry that names no player: no header, another scheme, a stranger, a token of nobody's. */
  const BadIdentity = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("raw"), header: Schema.String.check(Schema.isPattern(/^[\x21-\x7e ]{0,60}$/)) }),
    Schema.Struct({ kind: Schema.Literal("unknown"), bytes: Bytes }),
    Schema.Struct({ kind: Schema.Literal("revoked") }),
    Schema.Struct({ kind: Schema.Literal("mangled"), at: Schema.Int }),
  ])

  const requestTo = (endpoint: typeof Endpoint.Type, authorization: string | null): Request => {
    switch (endpoint) {
      case "openSession":
        return request("/v1/sessions", "POST", authorization, { sessionId: session })
      case "closeSession":
        return request(`/v1/sessions/${session}`, "DELETE", authorization)
      case "sendEvents":
        return request("/v1/events", "POST", authorization, { events: [prompt(8)] })
      case "runCommand":
        return request("/v1/commands", "POST", authorization, hatch())
      case "stream":
        return request("/v1/stream?after=0", "GET", authorization)
      case "signOut":
        return request("/v1/auth/logout", "POST", authorization)
    }
  }

  it.effect.prop(
    "that names no signed-in player is answered 401 on every route, and writes nothing",
    [Schema.Array(Schema.Tuple([Endpoint, BadIdentity])).check(Schema.isMaxLength(10))],
    ([tries]) =>
      withAccounts(new Map([["ada-token", ada]]), new Set(["ada"]))(
        Effect.gen(function* () {
          const handle = yield* onlineWebHandler
          // A signed-in player, so a write would have someone to land on, and a token they gave up.
          const { token } = yield* signIn(handle, "ada-token")
          const { token: given } = yield* signIn(handle, "ada-token")
          expect((yield* handle(request("/v1/auth/logout", "POST", `Bearer ${given}`))).status).toBe(200)
          const authorizationOf = (identity: typeof BadIdentity.Type): string | null => {
            switch (identity.kind) {
              case "none":
                return null
              case "raw":
                return identity.header
              case "unknown":
                return `Bearer ${tokenOf(Uint8Array.from(identity.bytes))}`
              case "revoked":
                return `Bearer ${given}`
              case "mangled": {
                const i = tokenPrefix.length + (Math.abs(identity.at) % (token.length - tokenPrefix.length))
                return `Bearer ${token.slice(0, i)}${token[i] === "A" ? "B" : "A"}${token.slice(i + 1)}`
              }
            }
          }
          const before = yield* dump
          for (const [endpoint, identity] of tries) {
            const authorization = authorizationOf(identity)
            // A raw header that happens to carry the live token is not a bad identity.
            if (authorization?.includes(token) === true) continue
            const response = yield* handle(requestTo(endpoint, authorization))
            expect({ endpoint, identity, status: response.status }).toEqual({ endpoint, identity, status: 401 })
          }
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )

  it.effect("from a player taken off the list is answered 401, until they are on it again", () => {
    const allowed = new Set(["ada"])
    return withAccounts(new Map([["ada-token", ada]]), allowed)(
      Effect.gen(function* () {
        const handle = yield* onlineWebHandler
        const { token } = yield* signIn(handle, "ada-token")
        const open = () => handle(request("/v1/sessions", "POST", `Bearer ${token}`, { sessionId: session }))
        expect((yield* open()).status).toBe(200)
        allowed.delete("ada")
        const refused = yield* open()
        expect(refused.status).toBe(401)
        expect(yield* Effect.promise(() => refused.json())).toMatchObject({ message: notInBeta })
        allowed.add("ada")
        expect((yield* open()).status).toBe(200)
      }),
    )
  })

  it.effect("after signing out is answered 401 for good, and signing out again too", () =>
    withAccounts(new Map([["ada-token", ada]]), new Set(["ada"]))(
      Effect.gen(function* () {
        const handle = yield* onlineWebHandler
        const { token } = yield* signIn(handle, "ada-token")
        const bearer = `Bearer ${token}`
        expect((yield* handle(request("/v1/sessions", "POST", bearer, { sessionId: session }))).status).toBe(200)
        expect((yield* handle(request("/v1/auth/logout", "POST", bearer))).status).toBe(200)
        expect((yield* handle(request("/v1/sessions", "POST", bearer, { sessionId: session }))).status).toBe(401)
        expect((yield* handle(request("/v1/auth/logout", "POST", bearer))).status).toBe(401)
      }),
    ))
})
