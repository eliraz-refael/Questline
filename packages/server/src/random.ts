import { ulids } from "@pathofdev/engine"
import { Effect, Layer, Random } from "effect"
import { randomBytes } from "node:crypto"

// The server's own randomness: player ids, roll seeds and the ids of the inputs it logs itself. It comes from Effect's
// Random, an ISAAC generator seeded once from the OS when the server starts, so a test can seed it and see the same
// ids twice. The engine draws a player's rolls from their roll seed, never from this.

/** `bytes` random bytes, as lowercase hex. */
export const randomHex = (bytes: number): Effect.Effect<string> =>
  Effect.map(
    Effect.forEach(Array.from({ length: bytes }), () => Random.nextIntBetween(0, 256, { halfOpen: true })),
    (values) => values.map((value) => value.toString(16).padStart(2, "0")).join(""),
  )

/** A fresh ULID at `now`, as the server stamps an input it makes itself. */
export const newId = (now: string, logSeq = 0): Effect.Effect<string> =>
  Effect.map(randomHex(16), (seed) => ulids(seed, logSeq, now)())

/** A new player's roll seed: every roll they make is drawn from it. */
export const newRollSeed: Effect.Effect<string> = randomHex(32)

/** Effect's Random for the whole server, seeded with `seed`, or once from the OS when none is given. */
export const seededRandom = (seed?: string) =>
  Layer.effect(
    Random.Random,
    Effect.suspend(() => Random.Random.pipe(Random.withSeed(seed ?? randomBytes(32).toString("hex")))),
  )
