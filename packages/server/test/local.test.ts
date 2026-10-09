import { it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it as test } from "vitest"
import { holdLock, localPaths, localServer, ServerRunning } from "../src/index.ts"
import { commit, profile, session } from "./fixtures.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "ql-"))

/** A pid no process has: above the usual pid_max on Linux and macOS. */
const deadPid = 4_194_400

const post = (socketPath: string, path: string, body: unknown) =>
  Effect.promise(
    () =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          let data = ""
          res.on("data", (chunk) => (data += chunk))
          res.on("end", () => resolve({ status: res.statusCode, body: data }))
        })
        req.on("error", reject)
        req.end(JSON.stringify(body))
      }),
  )

describe("localPaths", () => {
  test("falls back to ~/.questline when QUESTLINE_HOME is set but empty", () => {
    const saved = process.env["QUESTLINE_HOME"]
    process.env["QUESTLINE_HOME"] = ""
    try {
      expect(localPaths().home).toBe(join(homedir(), ".questline"))
    } finally {
      if (saved === undefined) delete process.env["QUESTLINE_HOME"]
      else process.env["QUESTLINE_HOME"] = saved
    }
  })
})

describe("holdLock", () => {
  it.effect("writes this process's pid and removes the lock on release", () =>
    Effect.gen(function* () {
      const path = join(scratch(), "server.lock")
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holdLock(path)
          expect(readFileSync(path, "utf8")).toBe(String(process.pid))
        }),
      )
      expect(existsSync(path)).toBe(false)
    }),
  )

  it.effect("refuses while a live process holds the lock", () =>
    Effect.gen(function* () {
      const path = join(scratch(), "server.lock")
      writeFileSync(path, String(process.ppid))
      const exit = yield* Effect.exit(Effect.scoped(holdLock(path)))
      expect(exit).toEqual(Exit.fail(new ServerRunning({ pid: process.ppid })))
      expect(readFileSync(path, "utf8")).toBe(String(process.ppid))
    }),
  )

  it.effect("takes over a lock whose process is gone", () =>
    Effect.gen(function* () {
      const path = join(scratch(), "server.lock")
      writeFileSync(path, String(deadPid))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holdLock(path)
          expect(readFileSync(path, "utf8")).toBe(String(process.pid))
        }),
      )
    }),
  )
})

describe("localServer", () => {
  it.live("serves the API on a socket in a 0700 directory, keeping the player across restarts", () =>
    Effect.gen(function* () {
      const paths = localPaths(join(scratch(), "home"))
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.scoped(Effect.andThen(Layer.build(localServer(paths, profile)), effect))

      const first = yield* run(post(paths.socket, "/v1/events", { events: [commit("a", new Date().toISOString())] }))
      expect(first.status).toBe(200)
      expect(statSync(paths.home).mode & 0o777).toBe(0o700)

      const reopened = yield* run(post(paths.socket, "/v1/sessions", { sessionId: session }))
      expect(JSON.parse(reopened.body)).toMatchObject({ snapshot: { cursor: 3, character: { xp: { reported: 13 } } } })
      expect(existsSync(paths.lock)).toBe(false)
    }),
  )
})
