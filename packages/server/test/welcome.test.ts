import { it } from "@effect/vitest"
import type { CharacterRename, CommandResponse, EggChoose, WelcomeDone } from "@pathofdev/schema"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { client, hatch, nextId, session, withoutQuests, withServer } from "./fixtures.ts"

// The first-run welcome over the routes: the snapshot says whether it is done and what the egg is, the rules list the
// species, and the commands that name the character, pick the egg and finish it are checked on the server.

const typesOf = (response: CommandResponse) =>
  response.status === "ok" ? withoutQuests(response.events).map((event) => event.type) : response.code

describe("the welcome, end to end", () => {
  it.effect("offers the welcome to a new player, takes their name and egg, and is done once", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.welcome).toEqual({ done: false })
        expect(opened.snapshot.egg).toEqual({ species: "fox", name: "Ember" })
        expect(opened.rules.pet.species.map((species) => species.id)).toEqual(["fox", "slime", "robot", "owl"])

        const named: typeof CharacterRename.Type = {
          id: nextId(),
          type: "character.rename",
          data: { name: " Ada  Lovelace " },
        }
        expect(typesOf(yield* api.runCommand({ payload: named }))).toEqual(["character.renamed"])
        const egg = { species: "owl", name: "Hoot" }
        const picked: typeof EggChoose.Type = { id: nextId(), type: "egg.choose", data: egg }
        expect(typesOf(yield* api.runCommand({ payload: picked }))).toEqual(["egg.chosen"])
        const done: typeof WelcomeDone.Type = { id: nextId(), type: "welcome.done", data: {} }
        expect(typesOf(yield* api.runCommand({ payload: done }))).toEqual(["welcome.done"])
        const again: typeof WelcomeDone.Type = { id: nextId(), type: "welcome.done", data: {} }
        expect(typesOf(yield* api.runCommand({ payload: again }))).toEqual([])

        const after = yield* api.openSession({ payload: { sessionId: session } })
        expect(after.snapshot.character.name).toBe("Ada Lovelace")
        expect(after.snapshot.egg).toEqual({ species: "owl", name: "Hoot" })
        expect(after.snapshot.welcome).toEqual({ done: true })
        // Every session hears of it on the stream.
        const streamed = yield* api.stream({ query: { after: 0 } })
        const types = streamed.events.map((event) => event.type)
        expect(types.filter((type) => !type.startsWith("quest."))).toEqual([
          "character.renamed",
          "egg.chosen",
          "welcome.done",
        ])
      }),
    ),
  )

  it.effect("refuses a name or a species it can't keep, in words, rather than failing the request", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const long = yield* api.runCommand({
          payload: { id: nextId(), type: "character.rename", data: { name: "x".repeat(40) } },
        })
        expect(long).toEqual({
          status: "refused",
          code: "invalid",
          message: "A name takes at most 20 characters, and that one has 40",
        })
        const odd = yield* api.runCommand({
          payload: { id: nextId(), type: "egg.choose", data: { species: "owl", name: "<b>" } },
        })
        expect(odd).toMatchObject({ status: "refused", code: "invalid" })
        const dragon = yield* api.runCommand({
          payload: { id: nextId(), type: "egg.choose", data: { species: "dragon", name: "Smaug" } },
        })
        expect(dragon).toMatchObject({ status: "refused", code: "invalid" })
        const after = yield* api.openSession({ payload: { sessionId: session } })
        expect(after.snapshot.character.name).toBe("Player")
        expect(after.snapshot.egg).toEqual({ species: "fox", name: "Ember" })
      }),
    ),
  )

  it.effect("hatches the egg as picked, then keeps its species and name, and the player's progress stays", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const egg = { species: "robot", name: "Bolt" }
        const picked: typeof EggChoose.Type = { id: nextId(), type: "egg.choose", data: egg }
        yield* api.runCommand({ payload: picked })
        yield* api.runCommand({ payload: { id: nextId(), type: "dev.grantXp", data: { amount: 150 } } })
        // The command names the fox Ember, as an older mod's does: the egg picked wins.
        expect(typesOf(yield* api.runCommand({ payload: hatch() }))).toEqual(["pet.hatched"])
        const before = (yield* api.openSession({ payload: { sessionId: session } })).snapshot
        expect(before.pet).toMatchObject({ species: "robot", name: "Bolt" })
        expect(before.egg).toBeNull()

        const late = yield* api.runCommand({
          payload: { id: nextId(), type: "egg.choose", data: { species: "owl", name: "Hoot" } },
        })
        expect(late).toEqual({
          status: "refused",
          code: "not_allowed",
          message: "Bolt has hatched, and keeps its species and name",
        })
        yield* api.runCommand({ payload: { id: nextId(), type: "character.rename", data: { name: "Ada" } } })
        yield* api.runCommand({ payload: { id: nextId(), type: "welcome.done", data: {} } })
        const after = (yield* api.openSession({ payload: { sessionId: session } })).snapshot
        expect(after.pet).toMatchObject({ species: "robot", name: "Bolt" })
        expect(after.character).toEqual({ ...before.character, name: "Ada" })
        expect(after.inventory).toEqual(before.inventory)
        expect(after.stats).toEqual(before.stats)
      }),
      undefined,
      true,
    ),
  )
})
