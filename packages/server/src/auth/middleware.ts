import { Authentication, CurrentPlayer, Unauthorized } from "@pathofdev/schema"
import { Effect, Layer, Option, Redacted } from "effect"
import type { BetaConfig } from "./allowlist.ts"
import { Allowlist } from "./allowlist.ts"
import { Tokens } from "./tokens.ts"

// The public server's `Authentication`: a request acts for the player its game token names, while that player is in
// the beta. The token is read from its Redacted only to hash it; neither it nor the Authorization header is logged.
//
//   Authorization: Bearer <token>   ("" when missing, or not Bearer)
//     └─▶ Tokens.playerOf ── not a pod_ token: answered without a read
//           ├─ none ───────────────────────────────▶ 401 "sign in again"      unknown, or revoked by a sign-out
//           └─ a player ─▶ Allowlist.allows(id, login)   from memory: no read
//                            ├─ no ────────────────▶ 401 "not in the beta"    off the list since they signed in
//                            └─ yes ───────────────▶ CurrentPlayer ─▶ handler

export const signInAgain = "This sign-in is no longer valid: sign in again"
export const notInBeta = "not in the beta"

export const BearerAuth = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const tokens = yield* Tokens
    const allowlist = yield* Allowlist
    return Authentication.of({
      bearer: Effect.fn(function* (handler, { credential }) {
        const player = yield* Effect.orDie(tokens.playerOf(Redacted.value(credential)))
        if (Option.isNone(player)) return yield* new Unauthorized({ message: signInAgain })
        if (!(yield* allowlist.allows(player.value))) return yield* new Unauthorized({ message: notInBeta })
        return yield* Effect.provideService(handler, CurrentPlayer, player.value)
      }),
    })
  }),
)

/** The public server's accounts behind its routes: game tokens, the beta of `beta`, and who each request is. */
export const accounts = (beta: BetaConfig) =>
  BearerAuth.pipe(Layer.provideMerge(Tokens.layer), Layer.provideMerge(Allowlist.layer(beta)))
