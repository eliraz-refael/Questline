import { NodeHttpServer } from "@effect/platform-node"
import { step } from "@questline/engine"
import { PgliteClient } from "@effect/sql-pglite"
import { Data, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { Buffer } from "node:buffer"
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createServer } from "node:http"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { DevMode } from "./game.ts"
import { ApiRoutes } from "./http.ts"
import { StreamHub } from "./hub.ts"
import { migrate } from "./migrations.ts"
import type { LocalProfile } from "./players.ts"
import { CurrentPlayer, Players } from "./players.ts"
import type { Stepper } from "./writer.ts"
import { PlayerWriter } from "./writer.ts"

// The local server: one player, PGlite in ~/.questline/data, HTTP on a Unix socket in a 0700 directory, so only the
// player's own user can connect. Exactly one runs per user: two processes on one PGlite folder corrupt it. Dev mode
// runs a second one, a sandbox in ~/.questline-dev that takes the dev commands.

export interface LocalPaths {
  readonly home: string
  readonly socket: string
  readonly lock: string
  readonly data: string
  /** Which save the home holds, written in it on the first start, so neither server opens the other's. */
  readonly profile: string
  /** Dev mode: a sandbox save that takes the dev commands. */
  readonly dev: boolean
}

/** `QUESTLINE_DEV=1` starts the dev sandbox. */
export const isDevMode = (value = process.env["QUESTLINE_DEV"]): boolean => value === "1"

/**
 * `~/.questline`, or `~/.questline-dev` in dev mode, or `QUESTLINE_HOME` (when set and not empty) in place of
 * either. A home holds one kind of save, which `claimHome` checks, so even a shared `QUESTLINE_HOME` never turns the
 * player's real save into a dev one.
 */
export const localPaths = (home?: string, dev = isDevMode()): LocalPaths => {
  const root = home || process.env["QUESTLINE_HOME"] || join(homedir(), dev ? ".questline-dev" : ".questline")
  return {
    home: root,
    socket: join(root, "server.sock"),
    lock: join(root, "server.lock"),
    data: join(root, "data"),
    profile: join(root, "profile"),
    dev,
  }
}

export class WrongHome extends Data.TaggedError("WrongHome")<{ readonly home: string; readonly holds: string }> {
  override get message() {
    const other = this.holds === "dev" ? "with QUESTLINE_DEV=1" : "without QUESTLINE_DEV=1"
    return `${this.home} holds a ${this.holds} save, which only a server started ${other} opens`
  }
}

/**
 * Marks the home with the save it holds, or fails when it holds the other kind. A save from before the mark is the
 * player's real one: dev mode never takes it.
 */
export const claimHome = (paths: LocalPaths) =>
  Effect.gen(function* () {
    const wanted = paths.dev ? "dev" : "play"
    // A mark that reads as neither kind (an empty file from a start cut short) counts as none.
    const read = yield* Effect.sync(() => readIfExists(paths.profile)?.trim())
    const marked = read === "dev" || read === "play" ? read : null
    const holds = marked ?? (existsSync(paths.data) ? "play" : null)
    if (holds !== null && holds !== wanted) return yield* new WrongHome({ home: paths.home, holds })
    if (marked === null) yield* Effect.sync(() => writeFileSync(paths.profile, wanted, { mode: 0o600 }))
  })

export class ServerRunning extends Data.TaggedError("ServerRunning")<{ readonly pid: number }> {
  override get message() {
    return `A Questline server is already running (pid ${this.pid})`
  }
}

export class SocketPathTooLong extends Data.TaggedError("SocketPathTooLong")<{ readonly path: string }> {
  override get message() {
    return `The socket path is longer than Unix sockets allow (${maxSocketPath} bytes): ${this.path}`
  }
}

/** sun_path holds 104 bytes on macOS (108 on Linux), with the terminating zero. Node reports a longer one as EADDRINUSE. */
const maxSocketPath = 103

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code
const isFileExists = (error: unknown): boolean => hasCode(error, "EEXIST")

/** The file's text, or null when it is gone. */
const readIfExists = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null
    throw error
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return hasCode(error, "EPERM")
  }
}

/**
 * Takes `server.lock` for this process, writing its pid, or fails with the pid of the server that holds it. A lock
 * whose process is gone is taken over. Released with the scope, only if this process still holds it.
 */
export const holdLock = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): number | null => {
        // The pid is written to a private file first and linked into place, so another process never reads a lock
        // that exists but is still empty and mistakes it for a stale one.
        const temp = `${path}.${process.pid}`
        const fd = openSync(temp, "w", 0o600)
        writeSync(fd, String(process.pid))
        closeSync(fd)
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              linkSync(temp, path)
              return null
            } catch (error) {
              if (!isFileExists(error)) throw error
              const seen = readIfExists(path)
              if (seen === null) continue
              const holder = Number.parseInt(seen, 10)
              if (Number.isInteger(holder) && holder !== process.pid && isAlive(holder)) return holder
              // Only remove the stale lock if it is still the one just read, not one another process just took.
              if (readIfExists(path) === seen) rmSync(path, { force: true })
            }
          }
          throw new Error(`Could not take ${path}`)
        } finally {
          rmSync(temp, { force: true })
        }
      },
      catch: (cause) => cause,
    }).pipe(Effect.flatMap((holder) => (holder === null ? Effect.void : Effect.fail(new ServerRunning({ pid: holder }))))),
    () =>
      Effect.sync(() => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) rmSync(path, { force: true })
        } catch {
          // Already gone.
        }
      }),
  )

/** The local player's defaults, from the OS account. */
export const defaultProfile = (): LocalProfile => {
  const name = userInfo().username.slice(0, 32) || "Player"
  return { displayName: name, characterName: name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
}

/** Everything behind the routes, over a PGlite database: migrated, with the local player in place; dev mode off. */
export const services = (
  pglite: PgliteClient.PgliteClientConfig,
  profile: LocalProfile,
  stepper: Stepper = step,
  dev = false,
) => {
  const Database = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(PgliteClient.layer(pglite)))
  const Player = Layer.effect(
    CurrentPlayer,
    Effect.gen(function* () {
      const players = yield* Players
      return yield* players.local(profile)
    }),
  ).pipe(Layer.provideMerge(Players.layer))
  return Layer.mergeAll(Player, PlayerWriter.make(stepper)).pipe(
    Layer.provideMerge(StreamHub.layer),
    Layer.provideMerge(Database),
    Layer.provideMerge(DevMode.layer(dev)),
  )
}

/** The local server, listening on the socket until the scope closes. */
export const localServer = (paths: LocalPaths = localPaths(), profile: LocalProfile = defaultProfile()) => {
  const Prepare = Layer.effectDiscard(
    Effect.gen(function* () {
      if (Buffer.byteLength(paths.socket) > maxSocketPath) return yield* new SocketPathTooLong({ path: paths.socket })
      yield* Effect.sync(() => {
        mkdirSync(paths.home, { recursive: true, mode: 0o700 })
        // mkdir leaves an existing directory's mode alone.
        chmodSync(paths.home, 0o700)
      })
      yield* holdLock(paths.lock)
      yield* claimHome(paths)
      if (paths.dev) yield* Effect.logInfo(`Dev mode: a sandbox save in ${paths.home}, which takes the dev commands`)
      // Only the lock holder may remove the socket, so a second server can't pull it from under the first.
      yield* Effect.sync(() => rmSync(paths.socket, { force: true }))
    }),
  )
  return HttpRouter.serve(ApiRoutes).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { path: paths.socket })),
    Layer.provide(services({ dataDir: paths.data }, profile, step, paths.dev)),
    Layer.provide(Prepare),
  )
}
