import { step } from "@pathofdev/engine"
import { Layer } from "effect"
import type { Database } from "./db.ts"
import { sqlLayer } from "./db.ts"
import { DevMode } from "./game.ts"
import { StreamHub } from "./hub.ts"
import { migrate } from "./migrations.ts"
import { Players } from "./players.ts"
import { Presence } from "./presence.ts"
import { QuestPacks } from "./quest-packs.ts"
import { seededRandom } from "./random.ts"
import type { Stepper } from "./writer.ts"
import { PlayerWriter } from "./writer.ts"

// What every server runs behind its routes, whatever it serves and whoever it plays for. Each server adds who a
// request acts for on top: the local server its one player.
//
//   Random (seeded once) ─┐
//   DevMode ──────────────┤
//   Database ─▶ migrate ──┼─▶ QuestPacks ─▶ StreamHub ─▶ PlayerWriter ─▶ Players, Presence (+ sweep)
//                         ┘

export interface CoreOptions {
  /** The engine's step, swappable so tests can make it fail. */
  readonly stepper?: Stepper | undefined
  /** Dev mode: the dev commands are taken. Only the local dev sandbox turns it on. */
  readonly dev?: boolean | undefined
  /** Seeds the server's Random, so a test sees the same ids twice; from the OS when unset. */
  readonly seed?: string | undefined
}

/** Effect's Random, seeded once, then the database, migrated. */
const Base = (database: Database, seed: string | undefined) =>
  Layer.effectDiscard(migrate).pipe(Layer.provideMerge(sqlLayer(database)), Layer.provideMerge(seededRandom(seed)))

/** The services behind the routes, over `database`: migrated, with the presence sweep running; dev mode off. */
export const core = (database: Database, options: CoreOptions = {}) => {
  const Live = Presence.sweeper.pipe(Layer.provideMerge(Presence.layer))
  return Layer.mergeAll(Players.layer, Live).pipe(
    Layer.provideMerge(PlayerWriter.make(options.stepper ?? step)),
    Layer.provideMerge(StreamHub.layer),
    Layer.provideMerge(QuestPacks.layer),
    Layer.provideMerge(Base(database, options.seed)),
    Layer.provideMerge(DevMode.layer(options.dev ?? false)),
  )
}
