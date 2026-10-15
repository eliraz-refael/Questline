import { it } from "@effect/vitest"
import { isGithubLogin } from "@pathofdev/schema"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import type { BetaConfig, GithubUser } from "../src/index.ts"
import { adminIdsOf, GitHub, notALogin, notInBeta, onlyAdmins, refreshEvery } from "../src/index.ts"
import { dump, publicWebHandler, session, start, testPublicServices, testServices, webHandler } from "./fixtures.ts"

// The beta list, kept from the mod by the public server's admins, end to end through the public build's routes over a
// fresh database. GitHub is a table the test fills; the admin is Root, by GitHub user id 7, and ALLOWED_LOGINS lists
// Bob:
//
//   GET|POST /v1/beta, DELETE /v1/beta/{login} ─▶ BearerAuth ─▶ admin by id? ─▶ a login? ─▶ beta_logins + its Ref
//   sign-in, any route ─▶ allowlist: Root's id ∨ ALLOWED_LOGINS ∨ the Ref (the table, read again every 30 s)

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

const root: GithubUser = { id: 7, login: "root", name: "Root" }
const bob: GithubUser = { id: 2, login: "bob", name: null }
/** Root's login in another case, on another account: someone who took it after a rename, say. Never an admin. */
const mallory: GithubUser = { id: 8, login: "Root", name: null }

const beta: BetaConfig = { allowedLogins: "bob", adminGithubIds: [root.id] }

/** GitHub as the test fills it: each account signs in with the token `<login>@<id>`. */
const FakeGitHub = (accounts: ReadonlyArray<GithubUser>) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      user: (token) =>
        Effect.succeed(
          Option.fromNullishOr(accounts.find((account) => `${account.login}@${account.id}` === Redacted.value(token))),
        ),
    }),
  )

/** The public build over a fresh database, with the beta of `beta` and GitHub's `accounts` (and Root, Bob, Mallory). */
const withBeta = (accounts: ReadonlyArray<GithubUser> = []) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(testPublicServices(beta, FakeGitHub([root, bob, mallory, ...accounts]))))

const request = (path: string, method: string, authorization: string | null, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

type Handle = (request: Request) => Effect.Effect<Response>

const json = (response: Response) => Effect.promise(() => response.json() as Promise<Record<string, unknown>>)

/** The answer to `account`'s sign-in. */
const signInOf = (handle: Handle, account: GithubUser) =>
  handle(request("/v1/auth/github", "POST", null, { githubToken: `${account.login}@${account.id}`, timezone: "UTC" }))

/** `account` signed in: their game token, as the Authorization header. */
const signedIn = (handle: Handle, account: GithubUser) =>
  Effect.gen(function* () {
    const response = yield* signInOf(handle, account)
    expect({ login: account.login, status: response.status }).toEqual({ login: account.login, status: 200 })
    return `Bearer ${((yield* json(response)) as { token: string }).token}`
  })

const list = (handle: Handle, bearer: string) => handle(request("/v1/beta", "GET", bearer))
const add = (handle: Handle, bearer: string, login: string) => handle(request("/v1/beta", "POST", bearer, { login }))
const remove = (handle: Handle, bearer: string, login: string) =>
  handle(request(`/v1/beta/${encodeURIComponent(login)}`, "DELETE", bearer))

/** A session opened for the player `bearer` names: what every request of theirs passes first. */
const open = (handle: Handle, bearer: string) => handle(request("/v1/sessions", "POST", bearer, { sessionId: session }))

/** The status and body of an answer. */
const answer = (response: Response) =>
  Effect.map(json(response), (body) => ({ status: response.status, body }))

/** A GitHub login: runs of letters and digits, joined by single hyphens, 35 characters at most. */
const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8}){0,3}$/))

/** `login` with the case of each letter flipped where `flips` says. */
const recase = (login: string, flips: ReadonlyArray<boolean>) =>
  [...login]
    .map((char, i) =>
      flips[i % Math.max(1, flips.length)] === true
        ? char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
        : char
    )
    .join("")

/** Someone new, whom only the table can let in: not Root, Bob or Mallory, in any case. */
const isNewcomer = (login: string) => !["root", "bob"].includes(login.toLowerCase())

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{ login: string }>`SELECT login FROM beta_logins ORDER BY login`
})

/** Lets work the test clock woke finish: it runs its queries on the real clock. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))

/** The status `ask` answers once the read the test clock woke has had its time: up to 2 seconds of the real clock. */
const settledStatus = (ask: Effect.Effect<Response>, expected: number) =>
  Effect.gen(function* () {
    let status = 0
    for (let tries = 0; tries < 40 && status !== expected; tries++) {
      yield* settle
      status = (yield* ask).status
    }
    return status
  })

// ── logins ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a GitHub login", () => {
  /** The rule, said the long way. */
  const isLoginSpelled = (text: string) =>
    text.length >= 1 &&
    text.length <= 39 &&
    [...text].every((char) => /[A-Za-z0-9-]/.test(char)) &&
    !text.startsWith("-")

  it.prop("is 1 to 39 letters, digits and hyphens, with none first", [Schema.String], ([text]) => {
    expect(isGithubLogin(text)).toBe(isLoginSpelled(text))
  })

  it.prop("is every login the tests draw", [Login], ([login]) => {
    expect(isGithubLogin(login)).toBe(true)
    expect(isLoginSpelled(login)).toBe(true)
  })
})

describe("ADMIN_GITHUB_IDS", () => {
  it.prop(
    "reads back the ids it lists, separated by commas or white space",
    [Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999 }))), Schema.Literals([",", " ", ", ", "\n"])],
    ([ids, separator]) => {
      expect(adminIdsOf(` ${ids.join(separator)} `)).toEqual(ids)
    },
  )

  it.prop("reads nothing that is not a GitHub user id", [Schema.Literals(["0", "-3", "1.5", "1e3", "abc", "0x1f", "07"])], ([bad]) => {
    expect(adminIdsOf(`12, ${bad}`)).toBeNull()
  })
})

// ── through the routes ───────────────────────────────────────────────────────────────────────────────────────────────

describe("the beta list", () => {
  const Ask = Schema.Literals(["list", "add", "remove"])
  /** Anything a player might name in a request, safe in a URL path: logins, and what is not one. */
  const Named = Schema.Union([Login, Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.~ !@$-]{0,45}$/))])

  it.effect.prop(
    "answers a player who is no admin 403 on every call, and changes no row",
    [Schema.Array(Schema.Tuple([Ask, Named, Schema.Boolean])).check(Schema.isMinLength(1), Schema.isMaxLength(8))],
    ([tries]) =>
      withBeta()(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const admin = yield* signedIn(handle, root)
          // A row to remove, and Mallory let in by it: Root's login, on another account.
          expect((yield* add(handle, admin, "root")).status).toBe(200)
          const players = { bob: yield* signedIn(handle, bob), mallory: yield* signedIn(handle, mallory) }
          const before = yield* dump
          for (const [ask, login, isBob] of tries) {
            const bearer = isBob ? players.bob : players.mallory
            const response = ask === "list"
              ? yield* list(handle, bearer)
              : ask === "add"
              ? yield* add(handle, bearer, login)
              : yield* remove(handle, bearer, login)
            expect({ ask, login, ...(yield* answer(response)) }).toEqual({
              ask,
              login,
              status: 403,
              body: { _tag: "Forbidden", message: onlyAdmins },
            })
          }
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )

  it.effect.prop(
    "lets a login an admin adds sign in, in any case, and adding it again changes nothing",
    [Login.check(Schema.makeFilter(isNewcomer)), Schema.Array(Schema.Boolean), Schema.Array(Schema.Boolean)],
    ([login, added, signing]) => {
      const newcomer: GithubUser = { id: 3, login: recase(login, signing), name: null }
      return withBeta([newcomer])(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const refused = yield* signInOf(handle, newcomer)
          expect(yield* answer(refused)).toMatchObject({ status: 401, body: { message: notInBeta } })
          const admin = yield* signedIn(handle, root)
          expect(yield* answer(yield* add(handle, admin, recase(login, added)))).toEqual({
            status: 200,
            body: {
              login: recase(login, added),
              changed: true,
              message: `${recase(login, added)} is on the beta list now: they can sign in.`,
            },
          })
          const again = yield* answer(yield* add(handle, admin, login.toUpperCase()))
          expect(again).toMatchObject({ status: 200, body: { changed: false } })
          expect(again.body["message"]).toContain("already")
          expect((yield* rows).map((row) => row.login)).toEqual([recase(login, added)])
          const bearer = yield* signedIn(handle, newcomer)
          expect((yield* open(handle, bearer)).status).toBe(200)
        }),
      )
    },
    serverRuns,
  )

  it.effect.prop(
    "turns a login an admin removes away on its very next request, and removing it again changes nothing",
    [Login.check(Schema.makeFilter(isNewcomer)), Schema.Array(Schema.Boolean)],
    ([login, flips]) => {
      const newcomer: GithubUser = { id: 3, login, name: null }
      return withBeta([newcomer])(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const admin = yield* signedIn(handle, root)
          expect((yield* add(handle, admin, login)).status).toBe(200)
          const bearer = yield* signedIn(handle, newcomer)
          expect((yield* open(handle, bearer)).status).toBe(200)
          expect(yield* answer(yield* remove(handle, admin, recase(login, flips)))).toEqual({
            status: 200,
            body: {
              login: recase(login, flips),
              changed: true,
              message: `${recase(login, flips)} is off the beta list: their next request is turned away.`,
            },
          })
          expect(yield* answer(yield* open(handle, bearer))).toMatchObject({ status: 401, body: { message: notInBeta } })
          expect(yield* answer(yield* signInOf(handle, newcomer))).toMatchObject({ status: 401 })
          expect(yield* answer(yield* remove(handle, admin, login))).toEqual({
            status: 200,
            body: { login, changed: false, message: `${login} was not on the beta list, so nothing changed.` },
          })
          expect(yield* rows).toEqual([])
        }),
      )
    },
    serverRuns,
  )

  it.effect.prop(
    "holds exactly the logins added and not removed since, in any case, each with when and by whom",
    [
      Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["add", "remove"]),
          which: Schema.Literals([0, 1, 2]),
          flips: Schema.Array(Schema.Boolean),
        }),
      ).check(Schema.isMaxLength(12)),
    ],
    ([changes]) =>
      withBeta()(
        Effect.gen(function* () {
          const pool = ["carol", "dave-x", "Eve9"]
          const handle = yield* publicWebHandler
          const admin = yield* signedIn(handle, root)
          const model = new Set<string>()
          for (const { kind, which, flips } of changes) {
            const login = recase(pool[which]!, flips)
            const key = login.toLowerCase()
            const response = kind === "add" ? yield* add(handle, admin, login) : yield* remove(handle, admin, login)
            const changed = kind === "add" ? !model.has(key) : model.has(key)
            if (kind === "add") model.add(key)
            else model.delete(key)
            expect(yield* answer(response)).toMatchObject({ status: 200, body: { login, changed } })
          }
          const { entries } = (yield* json(yield* list(handle, admin))) as { entries: Array<Record<string, unknown>> }
          const added = entries.filter((entry) => entry["source"] === "added")
          expect(added.map((entry) => String(entry["login"]).toLowerCase()).sort()).toEqual([...model].sort())
          for (const entry of added) expect(entry).toMatchObject({ addedAt: start, addedBy: root.id })
          expect(entries.filter((entry) => entry["source"] !== "added")).toEqual([
            { source: "env", login: "bob" },
            { source: "admin", githubUserId: root.id, login: "root" },
          ])
        }),
      ),
    serverRuns,
  )

  it.effect.prop(
    "answers an admin who names no GitHub login 400, and changes no row",
    [
      Schema.Array(Schema.Tuple([Schema.Boolean, Schema.Union([Schema.String, Named])])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(8),
      ),
    ],
    ([tries]) =>
      withBeta()(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const admin = yield* signedIn(handle, root)
          expect((yield* add(handle, admin, "carol")).status).toBe(200)
          const before = yield* dump
          for (const [isAdd, login] of tries.filter(([, login]) => !isGithubLogin(login))) {
            // A path names a login only in what a URL can carry: a name the removal can't spell is the adding's.
            const isPathSafe = /^[A-Za-z][A-Za-z0-9_.~ !@$-]{0,45}$/.test(login)
            const response = isAdd || !isPathSafe ? yield* add(handle, admin, login) : yield* remove(handle, admin, login)
            expect({ login, ...(yield* answer(response)) }).toEqual({
              login,
              status: 400,
              body: { _tag: "InvalidLogin", message: notALogin },
            })
          }
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )

  it.effect("keeps letting in a login ALLOWED_LOGINS lists, and says the API can't take it off", () =>
    withBeta()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const admin = yield* signedIn(handle, root)
        const player = yield* signedIn(handle, bob)
        const kept = yield* answer(yield* remove(handle, admin, "BOB"))
        expect(kept).toEqual({
          status: 200,
          body: {
            login: "BOB",
            changed: false,
            message:
              "BOB was not on the beta list, so nothing changed, but ALLOWED_LOGINS lists them: the API can't take " +
              "them off, only a redeploy can.",
          },
        })
        expect((yield* open(handle, player)).status).toBe(200)
        // On both lists, the table's row goes, and ALLOWED_LOGINS still lets them in.
        expect(yield* answer(yield* add(handle, admin, "bob"))).toMatchObject({ body: { changed: true } })
        const removed = yield* answer(yield* remove(handle, admin, "bob"))
        expect(removed).toMatchObject({ status: 200, body: { changed: true } })
        expect(removed.body["message"]).toContain("ALLOWED_LOGINS lists them")
        expect((yield* open(handle, player)).status).toBe(200)
      }),
    ))

  it.effect("knows an admin by GitHub user id: always in, and never someone who took their login", () =>
    withBeta()(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        // On no list, Root signs in as an admin.
        const admin = yield* signedIn(handle, root)
        expect(yield* answer(yield* signInOf(handle, mallory))).toMatchObject({ status: 401, body: { message: notInBeta } })
        // Root's login on the list lets Mallory in, who takes it from Root's player, but not as an admin.
        expect((yield* add(handle, admin, "root")).status).toBe(200)
        const taker = yield* signedIn(handle, mallory)
        for (const response of [yield* list(handle, taker), yield* add(handle, taker, "eve"), yield* remove(handle, taker, "root")]) {
          expect(response.status).toBe(403)
        }
        // Root, whose player has no login now, is the admin still.
        const listed = (yield* json(yield* list(handle, admin))) as { entries: Array<Record<string, unknown>> }
        expect(listed.entries).toContainEqual({ source: "admin", githubUserId: root.id, login: null })
        expect((yield* open(handle, admin)).status).toBe(200)
        // Root's login taken off, Mallory is out, and Root, in by id, is not; the answer says why.
        const removed = yield* answer(yield* remove(handle, admin, "root"))
        expect(removed).toMatchObject({ status: 200, body: { changed: true } })
        expect((yield* open(handle, taker)).status).toBe(401)
        expect((yield* open(handle, admin)).status).toBe(200)
      }),
    ))

  it.effect("reads rows written straight to the table within 30 seconds, without a restart", () =>
    withBeta([{ id: 3, login: "carol", name: null }])(
      Effect.gen(function* () {
        const carol: GithubUser = { id: 3, login: "carol", name: null }
        const handle = yield* publicWebHandler
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO beta_logins (login, added_by, added_at) VALUES ('Carol', 7, ${start})`
        // Until the next read, the server goes by what it read.
        expect((yield* signInOf(handle, carol)).status).toBe(401)
        yield* TestClock.adjust(refreshEvery)
        expect(yield* settledStatus(signInOf(handle, carol), 200)).toBe(200)
        const bearer = yield* signedIn(handle, carol)
        expect((yield* open(handle, bearer)).status).toBe(200)
        yield* sql`DELETE FROM beta_logins`
        expect((yield* open(handle, bearer)).status).toBe(200)
        yield* TestClock.adjust(refreshEvery)
        expect(yield* settledStatus(open(handle, bearer), 401)).toBe(401)
      }),
    ))

  it.effect("is no route of the local server", () =>
    Effect.gen(function* () {
      const handle = yield* webHandler
      expect((yield* handle(request("/v1/beta", "GET", null))).status).toBe(404)
      expect((yield* handle(request("/v1/beta", "POST", null, { login: "ada" }))).status).toBe(404)
      expect((yield* handle(request("/v1/beta/ada", "DELETE", null))).status).toBe(404)
    }).pipe(Effect.provide(testServices())))
})
