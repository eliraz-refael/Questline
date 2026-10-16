import { it } from "@effect/vitest"
import { profileSections } from "@pathofdev/schema"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import type { GithubUser } from "../src/index.ts"
import { escapeHtml, notFoundPage, Players, unavailablePage } from "../src/index.ts"
import type { Handle } from "./fixtures.ts"
import {
  dump,
  fakeGitHub,
  publicWebHandler,
  request,
  signIn,
  testPublicServices,
  webHandler,
  withServer,
} from "./fixtures.ts"

// The public pages end to end, through the public build's routes over a fresh database. ALLOWED_LOGINS lists Ada and
// Bob; Carol has a player but is on no list; a second Ada (id 3) is who holds the login after the first renames.
//
//   GET /u/:login ─▶ not a login │ nobody │ private │ off the beta │ deleted ─▶ the one 404, byte for byte
//                 ─▶ public, on the list ─▶ 200, only the sections shown │ its save unreadable ─▶ 503

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

const ada: GithubUser = { id: 1, login: "Ada", name: "zqdisplaynamezq" }
const bob: GithubUser = { id: 2, login: "bob", name: null }
const nextAda: GithubUser = { id: 3, login: "ada", name: null }

const withPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(testPublicServices({ allowedLogins: "ada,bob", adminGithubIds: [] }, fakeGitHub([ada, bob, nextAda]))),
  )

const get = (handle: Handle, path: string, headers: Record<string, string> = {}) =>
  handle(new Request(`http://pathofdev.test${path}`, { headers }))

/** What a page answers, Date aside: the status, every other header, and the body. */
const read = (response: Response) =>
  Effect.promise(async () => ({
    status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([name]) => name !== "date")),
    body: await response.text(),
  }))

const makePublic = (handle: Handle, bearer: string) =>
  Effect.flatMap(handle(request("/v1/account/profile", "POST", bearer, { kind: "public" })), (response) =>
    Effect.sync(() => expect(response.status).toBe(200)))

/** Carol: a player of the public server whose profile is public, on no beta list. */
const carol = Effect.gen(function* () {
  const players = yield* Players
  const sql = yield* SqlClient.SqlClient
  const player = yield* players.create({
    displayName: "Carol",
    characterName: "carol",
    timezone: "UTC",
    github: { userId: 4, login: "carol" },
  })
  yield* sql`UPDATE players SET profile = '{"public": true}'::jsonb WHERE id = ${player.id}`
})

const setState = (playerId: string, path: string, value: unknown) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      UPDATE player_state SET state = jsonb_set(state, ${`{${path}}`}::text[], ${JSON.stringify(value)}::jsonb)
      WHERE player_id = ${playerId}
    `)

/** `text` with each letter's case flipped where `flips` says. */
const recased = (text: string, flips: ReadonlyArray<boolean>) =>
  [...text].map((ch, i) => (flips[i] === true ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join("")

const Flips = Schema.Array(Schema.Boolean).check(Schema.isMaxLength(6))

/**
 * Paths that name no page shown: a private player, one off the beta, nobody, things that are no login at all, and
 * deeper paths under /u. A bare `..` never gets here: the URL resolves it before the request leaves.
 */
const Hidden = Schema.Literals([
  "bob",
  "carol",
  "nobody-here",
  "ada-",
  "ada..",
  "ad%2ea",
  "-ada",
  "a".repeat(40),
  "ad%C3%A9",
  "ada%20",
  "ada%2Fx",
  "ada/extra",
  "x/ada/",
])

const Hostile = Schema.Array(Schema.Literals(["<", ">", "&", '"', "'", "a", "</style>", "<script>", " onload=", "🐉"])).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
)

const Section = Schema.Literals(profileSections)

describe("a profile page", () => {
  it.effect.prop(
    "is the one 404, byte for byte, for every login it doesn't show, in any case",
    [Schema.Array(Schema.Struct({ path: Hidden, flips: Flips })).check(Schema.isMinLength(1), Schema.isMaxLength(6))],
    ([paths]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const first = yield* signIn(handle, ada)
          yield* makePublic(handle, first.bearer)
          yield* signIn(handle, bob)
          yield* carol
          const reference = yield* read(yield* get(handle, "/u/nobody"))
          expect(reference.status).toBe(404)
          expect(reference.body).toBe(notFoundPage)
          expect(reference.headers).toMatchObject({ "cache-control": "no-store", "content-type": "text/html; charset=utf-8" })
          for (const { path, flips } of paths) {
            const answer = yield* read(yield* get(handle, `/u/${recased(path, flips)}`))
            expect({ path, answer }).toEqual({ path, answer: reference })
          }
        }),
      ),
    serverRuns,
  )

  it.effect.prop(
    "shows a public player on the list at any case of their login: their name as text, only the sections they show",
    [Flips, Hostile, Schema.Array(Section).check(Schema.isMaxLength(4))],
    ([flips, name, hidden]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer, player } = yield* signIn(handle, ada)
          yield* makePublic(handle, bearer)
          for (const section of hidden) {
            const response = yield* handle(request("/v1/account/profile", "POST", bearer, { kind: "hide", section }))
            expect(response.status).toBe(200)
          }
          const characterName = name.join("")
          yield* setState(player.id, "characterName", characterName)
          const before = yield* dump
          const page = yield* read(yield* get(handle, `/u/${recased("ada", flips)}`))
          expect(page.status).toBe(200)
          expect(page.headers).toMatchObject({
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          })
          expect(page.headers["content-security-policy"]).toMatch(/^default-src 'none'; style-src 'sha256-/)
          expect(page.headers["set-cookie"]).toBeUndefined()
          expect(page.body).toContain(`<h1 class="name">${escapeHtml(characterName)}</h1>`)
          expect(page.body).toContain(`<link rel="canonical" href="https://pathof.dev/u/ada">`)
          expect(page.body).not.toContain(ada.name!)
          for (const section of profileSections) {
            expect({ section, drawn: page.body.includes(`aria-labelledby="${section}"`) }).toEqual({
              section,
              drawn: !hidden.includes(section),
            })
          }
          // The same bytes for any viewer, signed in or not, and nothing written.
          const viewer = yield* read(
            yield* get(handle, `/u/${recased("ada", flips)}`, { authorization: bearer, cookie: "a=b", "accept-language": "he" }),
          )
          expect(viewer).toEqual(page)
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )

  it.effect("keeps a private player's 404 when their save can't be read, and answers a public one's with a 503", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const first = yield* signIn(handle, ada)
        yield* makePublic(handle, first.bearer)
        const second = yield* signIn(handle, bob)
        const reference = yield* read(yield* get(handle, "/u/nobody"))
        for (const { player } of [first, second]) yield* setState(player.id, "progress", "broken")
        expect(yield* read(yield* get(handle, "/u/bob"))).toEqual(reference)
        const down = yield* read(yield* get(handle, "/u/ada"))
        expect(down).toMatchObject({ status: 503, body: unavailablePage })
        expect(down.headers).toMatchObject({ "cache-control": "no-store", "retry-after": "60" })
      }),
    ), serverRuns.timeout)

  it.effect("is the 404 once the account is deleted, and shows only the account that holds the login now", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const reference = yield* read(yield* get(handle, "/u/nobody"))
        const first = yield* signIn(handle, ada)
        yield* makePublic(handle, first.bearer)
        expect((yield* read(yield* get(handle, "/u/ada"))).status).toBe(200)

        // The first Ada renamed; the account that signs in as "ada" now is another, and private.
        const next = yield* signIn(handle, nextAda)
        yield* setState(next.player.id, "characterName", "zqnextadazq")
        expect(yield* read(yield* get(handle, "/u/ada"))).toEqual(reference)
        yield* makePublic(handle, next.bearer)
        expect((yield* read(yield* get(handle, "/u/ada"))).body).toContain("zqnextadazq")

        const deleted = yield* handle(request("/v1/account/delete", "POST", next.bearer, { login: "ada" }))
        expect(deleted.status).toBe(200)
        expect(yield* read(yield* get(handle, "/u/ada"))).toEqual(reference)
      }),
    ), serverRuns.timeout)

  it.effect("answers no other method, and writes nothing for one", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer } = yield* signIn(handle, ada)
        yield* makePublic(handle, bearer)
        const before = yield* dump
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
          const response = yield* handle(new Request("http://pathofdev.test/u/ada", { method, body: "{}" }))
          expect({ method, status: response.status }).toEqual({ method, status: 404 })
          expect(yield* Effect.promise(() => response.text())).not.toContain("<html")
        }
        expect(yield* dump).toEqual(before)
      }),
    ), serverRuns.timeout)
})

describe("the local server", () => {
  it.effect("has no profile pages: the save is the player's own", () =>
    withServer(
      Effect.gen(function* () {
        const handle = yield* webHandler
        const response = yield* get(handle, "/u/player")
        expect(response.status).toBe(404)
        expect(yield* Effect.promise(() => response.text())).not.toBe(notFoundPage)
      }),
    ), serverRuns.timeout)
})
