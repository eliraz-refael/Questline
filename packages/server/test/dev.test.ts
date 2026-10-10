import { it } from "@effect/vitest"
import type { DevGrantXp } from "@questline/schema"
import { Effect, Exit, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it as test } from "vitest"
import { claimHome, isDevMode, localPaths, localServer, WrongHome } from "../src/index.ts"
import { client, nextId, profile, session, withServer } from "./fixtures.ts"

// Dev mode: a sandbox save in a home of its own, the only place the dev commands run.

const scratch = () => mkdtempSync(join(tmpdir(), "ql-dev-"))

const withEnv = (vars: Record<string, string | undefined>, body: () => void) => {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  set(vars)
  try {
    body()
  } finally {
    set(saved)
  }
}

describe("the dev home", () => {
  test("is ~/.questline-dev under QUESTLINE_DEV=1, apart from the real save, unless QUESTLINE_HOME names one", () => {
    withEnv({ QUESTLINE_DEV: "1", QUESTLINE_HOME: undefined }, () => {
      expect(isDevMode()).toBe(true)
      const dev = localPaths()
      expect(dev).toMatchObject({ home: join(homedir(), ".questline-dev"), dev: true })
      expect(dev.socket).toBe(join(homedir(), ".questline-dev", "server.sock"))
    })
    withEnv({ QUESTLINE_DEV: undefined, QUESTLINE_HOME: undefined }, () => {
      expect(localPaths()).toMatchObject({ home: join(homedir(), ".questline"), dev: false })
    })
    withEnv({ QUESTLINE_DEV: "1", QUESTLINE_HOME: "/tmp/sandbox" }, () => {
      expect(localPaths()).toMatchObject({ home: "/tmp/sandbox", dev: true })
    })
    expect(isDevMode("true")).toBe(false)
  })

  it.effect("marks a fresh home with its kind, and neither server opens the other's", () =>
    Effect.gen(function* () {
      const home = scratch()
      yield* claimHome(localPaths(home, true))
      expect(readFileSync(join(home, "profile"), "utf8")).toBe("dev")
      expect(yield* Effect.exit(claimHome(localPaths(home, false)))).toEqual(Exit.fail(new WrongHome({ home, holds: "dev" })))
      yield* claimHome(localPaths(home, true))

      const real = scratch()
      yield* claimHome(localPaths(real, false))
      expect(yield* Effect.exit(claimHome(localPaths(real, true)))).toEqual(Exit.fail(new WrongHome({ home: real, holds: "play" })))
      expect(new WrongHome({ home, holds: "dev" }).message).toContain("only a server started with QUESTLINE_DEV=1")
      expect(new WrongHome({ home, holds: "play" }).message).toContain("only a server started without QUESTLINE_DEV=1")

      const cut = scratch()
      writeFileSync(join(cut, "profile"), "")
      yield* claimHome(localPaths(cut, true))
      expect(readFileSync(join(cut, "profile"), "utf8")).toBe("dev")
    }),
  )

  it.effect("never takes a save from before the mark, which is the player's real one", () =>
    Effect.gen(function* () {
      const home = scratch()
      mkdirSync(join(home, "data"))
      expect(yield* Effect.exit(claimHome(localPaths(home, true)))).toEqual(Exit.fail(new WrongHome({ home, holds: "play" })))
      expect(existsSync(join(home, "profile"))).toBe(false)
      yield* claimHome(localPaths(home, false))
      expect(readFileSync(join(home, "profile"), "utf8")).toBe("play")
    }),
  )

  it.live("a dev server refuses to start on the real save", () =>
    Effect.gen(function* () {
      const home = scratch()
      writeFileSync(join(home, "profile"), "play")
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(localServer(localPaths(home, true), profile))))
      expect(exit).toEqual(Exit.fail(new WrongHome({ home, holds: "play" })))
    }),
  )
})

const grantXp = (amount: number): typeof DevGrantXp.Type => ({ id: nextId(), type: "dev.grantXp", data: { amount } })

describe("dev commands over the command route", () => {
  it.effect("are refused off dev mode, and the snapshot says nothing of dev", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        expect(yield* api.runCommand({ payload: grantXp(500) })).toEqual({
          status: "refused",
          code: "not_allowed",
          message: "Dev commands run only on a local server in dev mode",
        })
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.dev).toBeUndefined()
        expect(opened.snapshot.character.xp.total).toBe(0)
      }),
    ),
  )

  it.effect("run in dev mode, marked dev, and the snapshot says dev", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const granted = yield* api.runCommand({ payload: grantXp(500) })
        if (granted.status !== "ok") throw new Error(granted.message)
        expect(granted.events[0]).toMatchObject({ type: "xp.granted", data: { reason: "dev", amount: 500 } })
        expect(granted.events.some((event) => event.type === "level.up")).toBe(true)
        const styles = yield* api.runCommand({ payload: { id: nextId(), type: "dev.grantStyles", data: {} } })
        expect(styles.status).toBe("ok")
        const gold = yield* api.runCommand({ payload: { id: nextId(), type: "dev.setGold", data: { gold: 4242 } } })
        expect(gold).toMatchObject({ status: "ok", events: [{ type: "gold.changed", data: { reason: "dev", totalAfter: 4242 } }] })
        const item = yield* api.runCommand({ payload: { id: nextId(), type: "dev.grantItem", data: { itemId: "wizard-hat" } } })
        expect(item).toMatchObject({ status: "ok", events: [{ type: "loot.dropped", data: { item: { id: "wizard-hat" } } }] })
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.dev).toBe(true)
        expect(opened.snapshot.character.gold).toBe(4242)
        expect(opened.snapshot.inventory.every((entry) => entry.source.kind === "dev")).toBe(true)
        expect(opened.snapshot.inventory.length).toBeGreaterThan(14)
      }),
      undefined,
      true,
    ),
  )
})
