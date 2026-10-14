import { OnlineApi, Unauthorized } from "@pathofdev/schema"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { ModHandlers } from "../http.ts"
import type { GithubIdentity, NewPlayer } from "../players.ts"
import { Players } from "../players.ts"
import { Allowlist } from "./allowlist.ts"
import type { GithubUser } from "./github.ts"
import { GitHub } from "./github.ts"
import { notInBeta, signInAgain } from "./middleware.ts"
import { Tokens } from "./tokens.ts"

// Signing in to the public server. The mod runs GitHub's device flow itself and sends the GitHub token it got; the
// server asks GitHub whose it is, once, and keeps nothing of it.
//
//   POST /v1/auth/github { githubToken, timezone }
//     └─▶ GitHub.user(githubToken) ─── 401 ─────────────────────────────────▶ 401, nothing written
//           │                       └─ down, slow, limited ────────────────────▶ 503, nothing written
//           └─▶ Allowlist.allows(login) ─── no ──────────────────────────────▶ 401 "not in the beta", nothing written
//                 └─▶ Players.findOrCreate(id, login, timezone) ─▶ Tokens.mint ─▶ 200 { token, player }
//
//   POST /v1/auth/logout   Authorization: Bearer <token>
//     └─▶ Tokens.revoke ─── names nothing ───▶ 401
//                       └── revoked ─────────▶ 200 { signedOut: true }: the token never works again

const gitHubSaidNo = "GitHub did not accept this sign-in: sign in again"

/**
 * The player a first sign-in makes for a GitHub account: called by their name on GitHub, or their login without one,
 * and their character by the login, cut to a name's 32 characters. Their days are local to `timezone`.
 */
export const newPlayerOf = (user: GithubUser, timezone: string): NewPlayer & { readonly github: GithubIdentity } => ({
  displayName: user.name?.trim() || user.login,
  characterName: user.login.slice(0, 32),
  timezone,
  github: { userId: user.id, login: user.login },
})

export const AuthHandlers = HttpApiBuilder.group(
  OnlineApi,
  "auth",
  Effect.fn(function* (handlers) {
    const github = yield* GitHub
    const allowlist = yield* Allowlist
    const players = yield* Players
    const tokens = yield* Tokens

    return handlers.handleAll({
      signIn: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* github.user(payload.githubToken)
          if (Option.isNone(user)) return yield* new Unauthorized({ message: gitHubSaidNo })
          if (!allowlist.allows(user.value.login)) return yield* new Unauthorized({ message: notInBeta })
          // The time zone names a new player's local days; a returning player keeps theirs.
          const player = yield* Effect.orDie(players.findOrCreate(newPlayerOf(user.value, payload.timezone)))
          return { token: yield* Effect.orDie(tokens.mint(player.id)), player }
        }),

      signOut: () =>
        Effect.gen(function* () {
          const credential = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)
          const revoked = yield* Effect.orDie(tokens.revoke(Redacted.value(credential)))
          if (!revoked) return yield* new Unauthorized({ message: signInAgain })
          return { signedOut: true } as const
        }),
    })
  }),
)

/** The public server's routes with their handlers: the mod's, and signing in and out. */
export const OnlineRoutes = HttpApiBuilder.layer(OnlineApi).pipe(Layer.provide([ModHandlers, AuthHandlers]))
