import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Logger } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it as test } from "vitest"
import type { LocalPaths } from "../src/index.ts"
import {
  clientOf,
  envOf,
  isDevMode,
  LegacyServerRunning,
  legacyVarNotes,
  localPaths,
  localServer,
  moveLegacyHome,
} from "../src/index.ts"
import { commit, profile, session } from "./fixtures.ts"

// The game was Questline before it was Path of Dev: its env vars, its header and its homes still work. Every home here
// is under a temporary HOME, never the real one.

const scratch = () => mkdtempSync(join(tmpdir(), "pod-rename-"))

const withEnv = <A>(vars: Record<string, string | undefined>, body: () => A): A => {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  set(vars)
  try {
    return body()
  } finally {
    set(saved)
  }
}

const unnamed = {
  PATHOFDEV_HOME: undefined,
  QUESTLINE_HOME: undefined,
  PATHOFDEV_DEV: undefined,
  QUESTLINE_DEV: undefined,
}

/** The paths a server would pick under the temporary `home`, checked to stay inside it. */
const pathsUnder = (home: string, dev = false): LocalPaths => {
  const paths = withEnv({ ...unnamed, HOME: home }, () => localPaths(undefined, dev))
  expect(paths.home.startsWith(home)).toBe(true)
  expect(paths.legacy?.startsWith(home)).toBe(true)
  return paths
}

/** Runs `effect`, keeping what it logs. */
const logged = <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<string> = []
  const keep = Logger.make((options) => {
    lines.push([options.message].flat().map(String).join(" "))
  })
  return Effect.exit(effect).pipe(
    Effect.provide(Logger.layer([keep])),
    Effect.map((exit) => ({ exit, lines })),
  )
}

/** A save with one file in it, as a home from before the rename holds. */
const saveIn = (home: string, text: string) => {
  mkdirSync(join(home, "data"), { recursive: true })
  writeFileSync(join(home, "data", "save"), text)
  writeFileSync(join(home, "profile"), "play")
}

const post = (socketPath: string, path: string, body: unknown) =>
  Effect.promise(
    () =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const headers = { "content-type": "application/json" }
        const req = request({ socketPath, path, method: "POST", headers }, (res) => {
          let data = ""
          res.on("data", (chunk) => (data += chunk))
          res.on("end", () => resolve({ status: res.statusCode, body: data }))
        })
        req.on("error", reject)
        req.end(JSON.stringify(body))
      }),
  )

describe("the env vars from before Path of Dev", () => {
  test("still work while the new names are unset or empty, and the new names win", () => {
    expect(envOf("PATHOFDEV_HOME", { QUESTLINE_HOME: "/old" })).toBe("/old")
    expect(envOf("PATHOFDEV_HOME", { QUESTLINE_HOME: "/old", PATHOFDEV_HOME: "" })).toBe("/old")
    expect(envOf("PATHOFDEV_HOME", { QUESTLINE_HOME: "/old", PATHOFDEV_HOME: "/new" })).toBe("/new")
    expect(envOf("PATHOFDEV_DEV", {})).toBeUndefined()
    withEnv({ ...unnamed, QUESTLINE_DEV: "1" }, () => expect(isDevMode()).toBe(true))
    withEnv({ ...unnamed, QUESTLINE_HOME: "/srv/old" }, () =>
      expect(localPaths()).toMatchObject({ home: "/srv/old", legacy: null }),
    )
  })

  test("each get a note while only the old name is set", () => {
    expect(legacyVarNotes({ QUESTLINE_DEV: "1", QUESTLINE_HOME: "/old" })).toEqual([
      "QUESTLINE_DEV is now PATHOFDEV_DEV: the old name still works for now, but goes away later",
      "QUESTLINE_HOME is now PATHOFDEV_HOME: the old name still works for now, but goes away later",
    ])
    expect(legacyVarNotes({ QUESTLINE_DEV: "1", PATHOFDEV_DEV: "1" })).toEqual([])
    expect(legacyVarNotes({})).toEqual([])
  })
})

describe("the client header", () => {
  test("is PathOfDev-Client, or Questline-Client from a mod from before Path of Dev", () => {
    expect(clientOf({ "pathofdev-client": "0.2.0" })).toBe("0.2.0")
    expect(clientOf({ "questline-client": "0.1.0" })).toBe("0.1.0")
    expect(clientOf({ "pathofdev-client": "0.2.0", "questline-client": "0.1.0" })).toBe("0.2.0")
    expect(clientOf({})).toBeNull()
  })
})

describe("the home from before Path of Dev", () => {
  test("is ~/.questline for ~/.pathofdev, ~/.questline-dev for ~/.pathofdev-dev, and none for a named home", () => {
    const home = scratch()
    expect(pathsUnder(home)).toMatchObject({ home: join(home, ".pathofdev"), legacy: join(home, ".questline") })
    expect(pathsUnder(home, true)).toMatchObject({
      home: join(home, ".pathofdev-dev"),
      legacy: join(home, ".questline-dev"),
    })
    expect(localPaths(join(home, "named")).legacy).toBeNull()
  })

  it.effect("moves to the new home when only it exists, with everything in it", () =>
    Effect.gen(function* () {
      for (const dev of [false, true]) {
        const paths = pathsUnder(scratch(), dev)
        const legacy = paths.legacy ?? ""
        saveIn(legacy, "level 9")
        const { exit, lines } = yield* logged(moveLegacyHome(paths))
        expect(exit).toEqual(Exit.void)
        expect(existsSync(legacy)).toBe(false)
        expect(readFileSync(join(paths.home, "data", "save"), "utf8")).toBe("level 9")
        expect(readFileSync(join(paths.home, "profile"), "utf8")).toBe("play")
        expect(lines).toEqual([`Questline is now Path of Dev: moved its save from ${legacy} to ${paths.home}`])
      }
    }),
  )

  it.effect("is left as it is when the new home exists too: the new one is played, and nothing is merged", () =>
    Effect.gen(function* () {
      const paths = pathsUnder(scratch())
      const legacy = paths.legacy ?? ""
      saveIn(legacy, "old")
      saveIn(paths.home, "new")
      const { exit, lines } = yield* logged(moveLegacyHome(paths))
      expect(exit).toEqual(Exit.void)
      expect(readFileSync(join(legacy, "data", "save"), "utf8")).toBe("old")
      expect(readFileSync(join(paths.home, "data", "save"), "utf8")).toBe("new")
      expect(lines).toEqual([
        `Both ${paths.home} and ${legacy} exist: ` +
          `playing on ${paths.home}, and leaving ${legacy} as it is (nothing merged)`,
      ])
    }),
  )

  it.effect("stays where a server from before the rename still runs in it, and this one does not start", () =>
    Effect.gen(function* () {
      const paths = pathsUnder(scratch())
      const legacy = paths.legacy ?? ""
      saveIn(legacy, "old")
      // The test runner's parent: a live process that is not this one.
      writeFileSync(join(legacy, "server.lock"), String(process.ppid))
      const { exit } = yield* logged(moveLegacyHome(paths))
      expect(exit).toEqual(Exit.fail(new LegacyServerRunning({ legacy, pid: process.ppid })))
      expect(existsSync(paths.home)).toBe(false)
      expect(readFileSync(join(legacy, "data", "save"), "utf8")).toBe("old")
    }),
  )

  it.effect("does nothing when there is none, or the home was named", () =>
    Effect.gen(function* () {
      const fresh = pathsUnder(scratch())
      expect((yield* logged(moveLegacyHome(fresh))).lines).toEqual([])
      expect(existsSync(fresh.home)).toBe(false)
    }),
  )

  it.live("moves on the server's start, and the player's save plays on in the new home", () =>
    Effect.gen(function* () {
      const home = scratch()
      const paths = pathsUnder(home)
      const legacy = localPaths(paths.legacy ?? "", false)
      const run = <A, E>(at: LocalPaths, effect: Effect.Effect<A, E>) =>
        Effect.scoped(Effect.andThen(Layer.build(localServer(at, profile)), effect))

      // A server from before the rename made the save in ~/.questline.
      const events = [commit("a", new Date().toISOString())]
      const first = yield* run(legacy, post(legacy.socket, "/v1/events", { events }))
      expect(first.status).toBe(200)

      const reopened = yield* run(paths, post(paths.socket, "/v1/sessions", { sessionId: session }))
      expect(JSON.parse(reopened.body)).toMatchObject({ snapshot: { character: { xp: { reported: 13 } } } })
      expect(existsSync(legacy.home)).toBe(false)
      expect(existsSync(paths.data)).toBe(true)
    }),
    // Two cold starts of an on-disk PGlite, each running every migration: seconds apiece on a CI runner.
    30_000,
  )
})
