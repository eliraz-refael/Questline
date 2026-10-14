import { ulids } from "@pathofdev/engine"
import { Context, Effect, Layer, Random } from "effect"
import { randomBytes } from "node:crypto"

// The server's own randomness: player ids, roll seeds and the ids of the inputs it logs itself. It comes from an
// ISAAC generator (Effect's seeded Random) seeded once from the OS when the server starts, so a test can seed it and
// see the same ids twice. It is a service of the server's own rather than Effect's `Random`, which falls back to
// Math.random wherever no layer seeds it: here a path that forgets the layer does not compile. The engine draws a
// player's rolls from their roll seed, never from this.

export class ServerRandom extends Context.Service<
  ServerRandom,
  {
    /** `bytes` random bytes, as lowercase hex. */
    readonly hex: (bytes: number) => Effect.Effect<string>
    /** A fresh ULID at `now`, as the server stamps an input it makes itself. */
    readonly id: (now: string, logSeq?: number) => Effect.Effect<string>
    /** A new player's roll seed: every roll they make is drawn from it. */
    readonly rollSeed: Effect.Effect<string>
  }
>()("pathofdev/ServerRandom") {
  /**
   * Seeded with `seed`, or from the OS when none is given, each time the layer is built: a layer built twice starts
   * two generators, never one shared between them.
   */
  static readonly layer = (seed?: string) =>
    Layer.effect(
      ServerRandom,
      Effect.suspend(() =>
        Effect.map(Random.Random.pipe(Random.withSeed(seed ?? randomBytes(32).toString("hex"))), randomOf),
      ),
    )
}

/** The server's randomness drawn from `random`. */
const randomOf = (random: Random.Random) => {
  const byte = () =>
    Math.floor(random.nextDoubleUnsafe() * 256)
      .toString(16)
      .padStart(2, "0")
  const hex = (bytes: number) => Effect.sync(() => Array.from({ length: bytes }, byte).join(""))
  return ServerRandom.of({
    hex,
    id: (now, logSeq = 0) => Effect.map(hex(16), (seed) => ulids(seed, logSeq, now)()),
    rollSeed: hex(32),
  })
}
