import { CurrentPlayer, Forbidden, InvalidLogin, isGithubLogin, OnlineApi } from "@pathofdev/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import type { Standing } from "./allowlist.ts"
import { Allowlist } from "./allowlist.ts"

// The beta list from the mod: `/pathofdev beta list|add|remove` for the public server's admins, so letting a player in
// takes no redeploy. Each request is a signed-in player's (BearerAuth), and only an admin's goes further:
//
//   GET    /v1/beta          ─┐
//   POST   /v1/beta {login}  ─┼─▶ BearerAuth ─▶ admin? (CurrentPlayer's GitHub user id ∈ ADMIN_GITHUB_IDS)
//   DELETE /v1/beta/{login}  ─┘                  ├─ no ─▶ 403, nothing read, nothing written
//                                                └─ yes ─▶ a GitHub login? ── no ─▶ 400, nothing written
//                                                            └─ yes ─▶ Allowlist: the table, then the Ref at once
//
// Adding a login on the list, or removing one off it, is no error: the answer says nothing changed. A login that
// `ALLOWED_LOGINS` lists, or an admin's, stays in whatever the table says, and the answer says so.

export const onlyAdmins = "Only the server's admins can see or change the beta list"
export const notALogin =
  "That is not a GitHub login: 1 to 39 letters, digits and hyphens, not starting with a hyphen"

/** What still lets a login in that the API can't take off, or null when nothing does. */
const stillIn = (standing: Standing): string | null =>
  standing.isAdmin
    ? "they are one of the server's admins (ADMIN_GITHUB_IDS), whom it always lets in"
    : standing.isListed
      ? "ALLOWED_LOGINS lists them"
      : null

/** What adding `login` did. */
export const addedText = (login: string, isAdded: boolean): string =>
  isAdded
    ? `${login} is on the beta list now: they can sign in.`
    : `${login} was on the beta list already: nothing changed.`

/** What removing `login` did, and what still lets them in. */
export const removedText = (login: string, isRemoved: boolean, standing: Standing): string => {
  const still = stillIn(standing)
  const done = isRemoved ? `${login} is off the beta list` : `${login} was not on the beta list, so nothing changed`
  if (still !== null) return `${done}, but ${still}: the API can't take them off, only a redeploy can.`
  return isRemoved ? `${done}: their next request is turned away.` : `${done}.`
}

export const BetaHandlers = HttpApiBuilder.group(
  OnlineApi,
  "beta",
  Effect.fn(function* (handlers) {
    const allowlist = yield* Allowlist

    /** The admin the request acts for, by GitHub user id: never by login, which a rename can hand to someone else. */
    const admin = Effect.gen(function* () {
      const { githubUserId } = yield* CurrentPlayer
      if (githubUserId === null || !allowlist.isAdmin(githubUserId)) {
        return yield* new Forbidden({ message: onlyAdmins })
      }
      return githubUserId
    })

    const checked = (login: string) =>
      isGithubLogin(login) ? Effect.succeed(login) : Effect.fail(new InvalidLogin({ message: notALogin }))

    return handlers.handleAll({
      listBeta: () => Effect.andThen(admin, Effect.map(Effect.orDie(allowlist.entries), (entries) => ({ entries }))),

      addToBeta: ({ payload }) =>
        Effect.gen(function* () {
          const by = yield* admin
          const login = yield* checked(payload.login)
          const isAdded = yield* Effect.orDie(allowlist.add(login, by))
          return { login, changed: isAdded, message: addedText(login, isAdded) }
        }),

      removeFromBeta: ({ params }) =>
        Effect.gen(function* () {
          yield* admin
          const login = yield* checked(params.login)
          const isRemoved = yield* Effect.orDie(allowlist.remove(login))
          const standing = yield* Effect.orDie(allowlist.standing(login))
          return { login, changed: isRemoved, message: removedText(login, isRemoved, standing) }
        }),
    })
  }),
)
