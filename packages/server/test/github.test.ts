import { it } from "@effect/vitest"
import { GitHubUnavailable } from "@pathofdev/schema"
import { Duration, Effect, Exit, Fiber, Logger, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Buffer } from "node:buffer"
import { describe, expect } from "vitest"
import type { Fetch, GitHubApp, GithubUser } from "../src/index.ts"
import { checkUrlOf, GitHub } from "../src/index.ts"
import { dump, publicWebHandler, testPublicServices } from "./fixtures.ts"

// The server's one question to GitHub, over a fake GitHub that answers its token check as the real one does: 200 with
// the token's account for a token issued to the app that asks, 404 for one it didn't issue to that app, 422 for no
// token, 401 when the app's own credentials are wrong. So a test can sign in with another app's token for the same
// account, and see it turned away.
//
//   GitHub.layer(app, fakeFetch) ─▶ POST /applications/{client_id}/token, Basic client_id:secret, { access_token }
//     ours ─▶ the account │ another app's, or none ─▶ none │ outages, a bad secret, a hang ─▶ GitHubUnavailable

const ours: GitHubApp = { clientId: "Ov23-ours", clientSecret: Redacted.make("our-secret-0123456789") }
const theirs: GitHubApp = { clientId: "Ov23-theirs", clientSecret: Redacted.make("their-secret-0123456789") }

/** A token GitHub issued, to the app with `clientId`, for `user`. */
interface Issued {
  readonly clientId: string
  readonly user: GithubUser
}

const ada: GithubUser = { id: 1, login: "Ada", name: null }

/** The tokens the fake GitHub has issued: one for Ada to our app, and one for Ada to another app. */
const issued = new Map<string, Issued>([
  ["gho_ours_ada", { clientId: ours.clientId, user: ada }],
  ["gho_theirs_ada", { clientId: theirs.clientId, user: ada }],
])

const secrets = new Map([ours, theirs].map((app) => [app.clientId, Redacted.value(app.clientSecret)]))

/** How the fake GitHub misbehaves, if at all. */
type Trouble = { readonly kind: "status"; readonly status: number } | { readonly kind: "throw" } | { readonly kind: "hang" }

/**
 * GitHub's token check, as a Fetch: the answers GitHub gives, and every request it was sent. A 200 answer repeats the
 * token, as GitHub's does, and leaves the account's name out, as GitHub's does.
 */
const fakeGitHub = (trouble: Trouble | null = null) => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const fetch: Fetch = (url, init) => {
    seen.push({ url, init })
    if (trouble?.kind === "throw") return Promise.reject(new TypeError("fetch failed"))
    if (trouble?.kind === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
    }
    if (trouble?.kind === "status") return Promise.resolve(new Response("{}", { status: trouble.status }))
    const clientId = /^https:\/\/api\.github\.com\/applications\/([^/]+)\/token$/.exec(url)?.[1]
    const headers = new Headers(init.headers)
    const [user, secret] = Buffer.from((headers.get("authorization") ?? "").replace(/^Basic /, ""), "base64")
      .toString()
      .split(":")
    if (clientId === undefined || user !== clientId || secrets.get(clientId) !== secret) {
      return Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }))
    }
    const token = (JSON.parse(String(init.body)) as { access_token?: unknown }).access_token
    if (typeof token !== "string" || token === "") {
      return Promise.resolve(Response.json({ message: "Validation Failed" }, { status: 422 }))
    }
    const found = issued.get(token)
    if (found === undefined || found.clientId !== clientId) {
      return Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }))
    }
    return Promise.resolve(
      Response.json({
        id: 1,
        token,
        token_last_eight: token.slice(-8),
        app: { client_id: clientId, name: "Path of Dev", url: "https://pathof.dev" },
        user: { login: found.user.login, id: found.user.id, type: "User", site_admin: false },
      }),
    )
  }
  return { fetch, seen }
}

/** Runs `effect`, and answers its exit and every line it logged, causes and all. */
const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const lines: Array<string> = []
  const keep = Logger.map(Logger.formatLogFmt, (line) => {
    lines.push(line)
  })
  return Effect.exit(effect).pipe(
    Effect.provide(Logger.layer([keep])),
    Effect.map((exit) => ({ exit, lines })),
  )
}

/** Asks the GitHub of `app` about `token`, letting the clock run past the timeout, so a hang ends. */
const ask = (app: GitHubApp, fetch: Fetch, token: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub
    const fiber = yield* Effect.forkChild(github.user(Redacted.make(token)))
    yield* TestClock.adjust(Duration.seconds(11))
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(GitHub.layer(app, fetch)))

/** Everything that must never reach the log: the tokens, the secrets, and the Basic credentials made of them. */
const secretsOf = (token: string) => [
  token,
  ...[ours, theirs].flatMap((app) => [
    Redacted.value(app.clientSecret),
    Buffer.from(`${app.clientId}:${Redacted.value(app.clientSecret)}`).toString("base64"),
  ]),
]

const unavailable = Exit.fail(
  new GitHubUnavailable({ message: "GitHub can't check this sign-in right now: try again in a minute" }),
)

describe("asking GitHub who signed in", () => {
  it.effect("names the account of a token issued to Path of Dev's app, asked as the app", () =>
    Effect.gen(function* () {
      const github = fakeGitHub()
      expect(yield* ask(ours, github.fetch, "gho_ours_ada")).toEqual(Option.some(ada))
      const [sent] = github.seen
      expect(sent?.url).toBe(checkUrlOf(ours))
      expect(sent?.init.method).toBe("POST")
      expect(JSON.parse(String(sent?.init.body))).toEqual({ access_token: "gho_ours_ada" })
    }))

  it.effect("turns down a token another app got for the same account, and a token GitHub never issued", () =>
    Effect.gen(function* () {
      for (const token of ["gho_theirs_ada", "gho_nobody", ""]) {
        expect(yield* ask(ours, fakeGitHub().fetch, token)).toEqual(Option.none())
      }
      // The other app, asking with its own credentials, is told its token is good: the check is per app.
      expect(yield* ask(theirs, fakeGitHub().fetch, "gho_theirs_ada")).toEqual(Option.some(ada))
    }))

  it.effect.prop(
    "can't say while GitHub is down, slow, limiting the server or turning down its secret, and logs no secret",
    [
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("status"), status: Schema.Literals([401, 403, 429, 500, 502, 503]) }),
        Schema.Struct({ kind: Schema.Literal("throw") }),
        Schema.Struct({ kind: Schema.Literal("hang") }),
        Schema.Struct({ kind: Schema.Literal("bad-secret") }),
      ]),
      Schema.Literals(["gho_ours_ada", "gho_theirs_ada", "gho_nobody"]),
    ],
    ([trouble, token]) =>
      Effect.gen(function* () {
        const app = trouble.kind === "bad-secret" ? { ...ours, clientSecret: Redacted.make("wrong-secret-98765") } : ours
        const github = fakeGitHub(trouble.kind === "bad-secret" ? null : trouble)
        const { exit, lines } = yield* logged(ask(app, github.fetch, token))
        expect(exit).toEqual(unavailable)
        expect(lines.length).toBeGreaterThan(0)
        const log = lines.join("\n")
        for (const secret of [...secretsOf(token), "wrong-secret-98765"]) expect(log).not.toContain(secret)
      }),
  )

  it.effect("keeps the token and the secret out of the log on a good answer too", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* logged(ask(ours, fakeGitHub().fetch, "gho_ours_ada"))
      expect(exit).toEqual(Exit.succeed(Option.some(ada)))
      for (const secret of secretsOf("gho_ours_ada")) expect(lines.join("\n")).not.toContain(secret)
    }))
})

describe("signing in to the public build", () => {
  const signIn = (githubToken: string) =>
    new Request("http://pathofdev.test/v1/auth/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken, timezone: "UTC" }),
    })

  const withGitHub = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(testPublicServices("ada", GitHub.layer(ours, fakeGitHub().fetch))))

  it.effect("with a token another app got for a player on the list is answered 401, and writes nothing", () =>
    withGitHub(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const before = yield* dump
        expect((yield* handle(signIn("gho_theirs_ada"))).status).toBe(401)
        expect(yield* dump).toEqual(before)
        const signedIn = yield* handle(signIn("gho_ours_ada"))
        expect(signedIn.status).toBe(200)
        expect(yield* Effect.promise(() => signedIn.json())).toMatchObject({
          player: { githubUserId: ada.id, githubLogin: ada.login, displayName: ada.login },
        })
      }),
    ))

  it.effect("while GitHub turns down the server's own secret is answered 503 with Retry-After, and writes nothing", () =>
    Effect.gen(function* () {
      const wrong = { ...ours, clientSecret: Redacted.make("wrong-secret-98765") }
      yield* Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const before = yield* dump
        const response = yield* handle(signIn("gho_ours_ada"))
        expect(response.status).toBe(503)
        expect(response.headers.get("retry-after")).toBe("60")
        expect(yield* dump).toEqual(before)
      }).pipe(Effect.provide(testPublicServices("ada", GitHub.layer(wrong, fakeGitHub().fetch))))
    }))
})

