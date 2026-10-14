import { NodeHttpServer } from "@effect/platform-node"
import { Authentication, CurrentPlayer } from "@pathofdev/schema"
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
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createServer } from "node:http"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import type { Database } from "./db.ts"
import { ApiRoutes } from "./http.ts"
import type { LocalProfile } from "./players.ts"
import { Players } from "./players.ts"
import type { CoreOptions } from "./services.ts"
import { core } from "./services.ts"

// The local server: one player, PGlite in ~/.pathofdev/data, HTTP on a Unix socket in a 0700 directory, so only the
// player's own user can connect. Exactly one runs per user: two processes on one PGlite folder corrupt it. Dev mode
// runs a second one, a sandbox in ~/.pathofdev-dev that takes the dev commands. The game was Questline before it was
// Path of Dev: a save still in ~/.questline (or ~/.questline-dev) moves to its new home on the first start.

export interface LocalPaths {
  readonly home: string
  readonly socket: string
  readonly lock: string
  readonly data: string
  /** Which save the home holds, written in it on the first start, so neither server opens the other's. */
  readonly profile: string
  /** Dev mode: a sandbox save that takes the dev commands. */
  readonly dev: boolean
  /**
   * The home from before Path of Dev, `~/.questline` or `~/.questline-dev`, whose save moves to `home` on start; null
   * when a home was named.
   */
  readonly legacy: string | null
}

/** The env vars the game reads, each under its name from before Path of Dev too. */
export type RenamedVar = "PATHOFDEV_DEV" | "PATHOFDEV_HOME"

const legacyNames: Readonly<Record<RenamedVar, string>> = {
  PATHOFDEV_DEV: "QUESTLINE_DEV",
  PATHOFDEV_HOME: "QUESTLINE_HOME",
}

/** An env var, or its name from before Path of Dev while the new name is unset or empty. */
export const envOf = (name: RenamedVar, env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env[name] || env[legacyNames[name]]

/** A note for each env var set only under its name from before Path of Dev, which still works for now. */
export const legacyVarNotes = (env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> =>
  Object.entries(legacyNames)
    .filter(([name, old]) => !env[name] && env[old])
    .map(([name, old]) => `${old} is now ${name}: the old name still works for now, but goes away later`)

/** `PATHOFDEV_DEV=1` starts the dev sandbox; so does `QUESTLINE_DEV=1`, its name from before Path of Dev. */
export const isDevMode = (value = envOf("PATHOFDEV_DEV")): boolean => value === "1"

/**
 * `~/.pathofdev`, or `~/.pathofdev-dev` in dev mode, or `PATHOFDEV_HOME` (or `QUESTLINE_HOME`), when set and not
 * empty, in place of either. A home holds one kind of save, which `claimHome` checks, so even a shared
 * `PATHOFDEV_HOME` never turns the player's real save into a dev one.
 */
export const localPaths = (home?: string, dev = isDevMode()): LocalPaths => {
  const named = home || envOf("PATHOFDEV_HOME")
  const root = named || join(homedir(), dev ? ".pathofdev-dev" : ".pathofdev")
  return {
    home: root,
    socket: join(root, "server.sock"),
    lock: join(root, "server.lock"),
    data: join(root, "data"),
    profile: join(root, "profile"),
    dev,
    legacy: named ? null : join(homedir(), dev ? ".questline-dev" : ".questline"),
  }
}

export class WrongHome extends Data.TaggedError("WrongHome")<{ readonly home: string; readonly holds: string }> {
  override get message() {
    const other = this.holds === "dev" ? "with PATHOFDEV_DEV=1" : "without PATHOFDEV_DEV=1"
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
    return `A Path of Dev server is already running (pid ${this.pid})`
  }
}

export class LegacyServerRunning extends Data.TaggedError("LegacyServerRunning")<{
  readonly legacy: string
  readonly pid: number
}> {
  override get message() {
    return (
      `A server from before Path of Dev is still running in ${this.legacy} (pid ${this.pid}): ` +
      "stop it, then start this one, which moves its save to the new home"
    )
  }
}

export class HomeNotMoved extends Data.TaggedError("HomeNotMoved")<{
  readonly legacy: string
  readonly home: string
  readonly cause: unknown
}> {
  override get message() {
    const reason = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Could not move ${this.legacy} to ${this.home} (${reason}); nothing was deleted, so it can be moved by hand`
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

/** The pid of the live process that holds the lock at `path`, or null when none does. */
const liveHolder = (path: string): number | null => {
  const holder = Number.parseInt(readIfExists(path) ?? "", 10)
  return Number.isInteger(holder) && isAlive(holder) ? holder : null
}

/**
 * Moves the save from before Path of Dev (`paths.legacy`) to `paths.home`, when only the old home exists: one rename
 * on the same filesystem, so nothing is copied or deleted. Two homes are never merged: when both exist, the new one is
 * played and the old one is left as it is. A server still running in the old home keeps it, and this one does not
 * start.
 */
export const moveLegacyHome = (paths: LocalPaths) =>
  Effect.gen(function* () {
    const legacy = paths.legacy
    if (legacy === null || !existsSync(legacy)) return
    if (existsSync(paths.home)) {
      return yield* Effect.logWarning(
        `Both ${paths.home} and ${legacy} exist: ` +
          `playing on ${paths.home}, and leaving ${legacy} as it is (nothing merged)`,
      )
    }
    const holder = liveHolder(join(legacy, "server.lock"))
    if (holder !== null) return yield* new LegacyServerRunning({ legacy, pid: holder })
    const isMoved = yield* Effect.try({
      try: () => {
        try {
          renameSync(legacy, paths.home)
          return true
        } catch (error) {
          // Another server starting at the same moment moved it first.
          if (hasCode(error, "ENOENT") && existsSync(paths.home)) return false
          throw error
        }
      },
      catch: (cause) => new HomeNotMoved({ legacy, home: paths.home, cause }),
    })
    if (isMoved) yield* Effect.logInfo(`Questline is now Path of Dev: moved its save from ${legacy} to ${paths.home}`)
  })

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

/**
 * The local server's `Authentication`: every request acts for its one player, made on the first start. Only the
 * player's own user can reach the socket, so a request needs no token, and one that carries a token is not read.
 */
export const LocalAuth = (profile: LocalProfile) =>
  Layer.effect(
    Authentication,
    Effect.gen(function* () {
      const players = yield* Players
      const player = yield* players.local(profile)
      return Authentication.of({ bearer: (handler) => Effect.provideService(handler, CurrentPlayer, player) })
    }),
  )

/** Everything behind the local server's routes, over `database`: the core, and its one player's `Authentication`. */
export const services = (database: Database, profile: LocalProfile, options?: CoreOptions) =>
  LocalAuth(profile).pipe(Layer.provideMerge(core("local", database, options)))

/** The local server, listening on the socket until the scope closes. */
export const localServer = (paths: LocalPaths = localPaths(), profile: LocalProfile = defaultProfile()) => {
  const Prepare = Layer.effectDiscard(
    Effect.gen(function* () {
      if (Buffer.byteLength(paths.socket) > maxSocketPath) return yield* new SocketPathTooLong({ path: paths.socket })
      for (const note of legacyVarNotes()) yield* Effect.logWarning(note)
      yield* moveLegacyHome(paths)
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
    Layer.provide(services({ kind: "pglite", dataDir: paths.data }, profile, { dev: paths.dev })),
    Layer.provide(Prepare),
  )
}
