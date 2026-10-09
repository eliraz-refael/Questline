import { Context, Deferred, Effect, Layer, Scope } from "effect"

// Held long-polls wait here, in memory, for the write path to say a player's stream moved. `server_events` stays
// the truth: a wakeup only says when to look again, so a lost one delays an event until the timeout, never loses it.
// This is the in-process hub of the local server; the public server adds LISTEN/NOTIFY between instances.

export class StreamHub extends Context.Service<
  StreamHub,
  {
    /**
     * Registers a waiter for the player and returns the wait. Register before reading the stream, so a commit that
     * lands between the read and the wait still wakes it. The waiter leaves with the scope.
     */
    readonly listen: (playerId: string) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>
    /** Wakes every waiter for the player. Called after a commit, never inside a transaction. */
    readonly notify: (playerId: string) => Effect.Effect<void>
  }
>()("questline/StreamHub") {
  static readonly layer = Layer.sync(StreamHub, () => {
    const waiters = new Map<string, Set<Deferred.Deferred<void>>>()
    const leave = (playerId: string, waiter: Deferred.Deferred<void>) =>
      Effect.sync(() => {
        const set = waiters.get(playerId)
        set?.delete(waiter)
        if (set?.size === 0) waiters.delete(playerId)
      })
    return StreamHub.of({
      listen: (playerId) =>
        Effect.gen(function* () {
          const waiter = yield* Deferred.make<void>()
          yield* Effect.sync(() => {
            const set = waiters.get(playerId) ?? new Set()
            set.add(waiter)
            waiters.set(playerId, set)
          })
          yield* Effect.addFinalizer(() => leave(playerId, waiter))
          return Deferred.await(waiter)
        }),
      notify: (playerId) =>
        Effect.sync(() => {
          const set = waiters.get(playerId)
          waiters.delete(playerId)
          for (const waiter of set ?? []) Deferred.doneUnsafe(waiter, Effect.void)
        }),
    })
  })
}
