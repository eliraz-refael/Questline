import { NodeHttpServer } from "@effect/platform-node"
import { step } from "@questline/engine"
import { PgliteClient } from "@effect/sql-pglite"
import { Data, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { Buffer } from "node:buffer"
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { ApiRoutes } from "./http.ts"
import { StreamHub } from "./hub.ts"
import { migrate } from "./migrations.ts"
import type { LocalProfile } from "./players.ts"
import { CurrentPlayer, Players } from "./players.ts"
import type { Stepper } from "./writer.ts"
import { PlayerWriter } from "./writer.ts"

// The local server: one player, PGlite in ~/.questline/data, HTTP on a Unix socket in a 0700 directory, so only the
// player's own user can connect. Exactly one runs per user: two processes on one PGlite folder corrupt it.

export interface LocalPaths {
  readonly home: string
  readonly socket: string
  readonly lock: string
  readonly data: string
}

/** `~/.questline`, or `QUESTLINE_HOME` when set and not empty. */
export const localPaths = (home = process.env["QUESTLINE_HOME"] || join(homedir(), ".questline")): LocalPaths => ({
  home,
  socket: join(home, "server.sock"),
  lock: join(home, "server.lock"),
  data: join(home, "data"),
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

/** Everything behind the routes, over a PGlite database: migrated, with the local player in place. */
export const services = (pglite: PgliteClient.PgliteClientConfig, profile: LocalProfile, stepper: Stepper = step) => {
  const Database = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(PgliteClient.layer(pglite)))
  const Player = Layer.effect(
    CurrentPlayer,
    Effect.gen(function* () {
      const players = yield* Players
      return yield* players.local(profile)
    }),
  ).pipe(Layer.provideMerge(Players.layer))
  return Layer.mergeAll(Player, PlayerWriter.make(stepper)).pipe(Layer.provideMerge(StreamHub.layer), Layer.provideMerge(Database))
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
      // Only the lock holder may remove the socket, so a second server can't pull it from under the first.
      yield* Effect.sync(() => rmSync(paths.socket, { force: true }))
    }),
  )
  return HttpRouter.serve(ApiRoutes).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { path: paths.socket })),
    Layer.provide(services({ dataDir: paths.data }, profile)),
    Layer.provide(Prepare),
  )
}
