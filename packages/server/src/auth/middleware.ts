import { AccountAuthentication, Authentication, CurrentPlayer, Unauthorized } from "@pathofdev/schema"
import { Effect, Layer, Option, Redacted } from "effect"
import type { BetaConfig } from "./allowlist.ts"
import { Allowlist } from "./allowlist.ts"
import { Tokens } from "./tokens.ts"

// Who a request to the public server acts for: the player its game token names. The game's own routes want that
// player in the beta too; the account's routes (privacy, export, delete) only the token, so a player the admins took
// off the beta still gets their data out, or deletes it, while their mod is signed in. The token is read from its
// Redacted only to hash it; neither it nor the Authorization header is logged.
//
//   Authorization: Bearer <token>   ("" when missing, or not Bearer)
//     └─▶ Tokens.playerOf ── not a pod_ token: answered without a read
//           ├─ none ───────────────────────────────▶ 401 "sign in again"      unknown, revoked by a sign-out, or deleted
//           └─ a player
//                ├─ BearerAuth (the game's routes, the beta list)
//                │    └─▶ Allowlist.allows(id, login)   from memory: no read
//                │          ├─ no ─────────────────▶ 401 "not in the beta"    off the list since they signed in
//                │          └─ yes ────────────────▶ CurrentPlayer ─▶ handler
//                └─ AccountAuth (/v1/account/*) ───▶ CurrentPlayer ─▶ handler

export const signInAgain = "This sign-in is no longer valid: sign in again"
export const notInBeta = "not in the beta"

/** The player a bearer credential names, or the 401 that tells the mod to sign in again. */
const playerOf = (tokens: Tokens["Service"], credential: Redacted.Redacted<string>) =>
  Effect.flatMap(
    Effect.orDie(tokens.playerOf(Redacted.value(credential))),
    Option.match({ onNone: () => Effect.fail(new Unauthorized({ message: signInAgain })), onSome: Effect.succeed }),
  )

export const BearerAuth = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const tokens = yield* Tokens
    const allowlist = yield* Allowlist
    return Authentication.of({
      bearer: Effect.fn(function* (handler, { credential }) {
        const player = yield* playerOf(tokens, credential)
        if (!(yield* allowlist.allows(player))) return yield* new Unauthorized({ message: notInBeta })
        return yield* Effect.provideService(handler, CurrentPlayer, player)
      }),
    })
  }),
)

/** The account's routes: the token's player, whatever the beta says. */
export const AccountAuth = Layer.effect(
  AccountAuthentication,
  Effect.gen(function* () {
    const tokens = yield* Tokens
    return AccountAuthentication.of({
      bearer: Effect.fn(function* (handler, { credential }) {
        return yield* Effect.provideService(handler, CurrentPlayer, yield* playerOf(tokens, credential))
      }),
    })
  }),
)

/** The public server's accounts behind its routes: game tokens, the beta of `beta`, and who each request is. */
export const accounts = (beta: BetaConfig) =>
  Layer.mergeAll(BearerAuth, AccountAuth).pipe(
    Layer.provideMerge(Tokens.layer),
    Layer.provideMerge(Allowlist.layer(beta)),
  )
