import type { Command, Context, Input, PlayerState, Recorded, Step } from "@pathofdev/schema"
import { PlayerState as PlayerStateSchema, Snapshot as SnapshotSchema } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  initialState,
  maxNameLength,
  nameIssue,
  project,
  starterCatalog,
  starterRules,
  step,
  tidyName,
} from "../src/index.ts"

// The first-run welcome's choices: the character's name, the egg's species and name before it hatches, and the welcome
// done. Each is a command the engine checks and logs, so a replay ends where the live run did, and none of them
// touches the player's progress or what they own.

const start = "2026-10-09T08:00:00.000Z"
const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"

const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

const command = (cmd: Command): Input => ({ kind: "command", command: cmd })
const rename = (name: string): Input => command({ id: nextId(), type: "character.rename", data: { name } })
const chooseEgg = (species: string, name: string): Input =>
  command({ id: nextId(), type: "egg.choose", data: { species, name } })
const hatch = (species = "fox", name = "Ember"): Input =>
  command({ id: nextId(), type: "pet.hatch", data: { species, name } })
const welcomeDone = (): Input => command({ id: nextId(), type: "welcome.done", data: {} })

const contextAt = (logSeq: number, now: string, mode: Context["mode"] = { kind: "live" }): Context => ({
  now,
  logSeq,
  rollSeed: "secret-seed",
  rules: starterRules,
  catalog: starterCatalog,
  questPacks: [],
  mode,
})

/** Inputs a minute apart from `start`. */
const play = (inputs: ReadonlyArray<Input>, state: PlayerState) => {
  const steps: Array<Step> = []
  for (const [i, input] of inputs.entries()) {
    const result = step(state, input, contextAt(i + 1, minutesLater(i)))
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((one) => one.events) }
}

/** The same inputs again in a replay, each taking what its live step recorded. */
const replay = (inputs: ReadonlyArray<Input>, recorded: ReadonlyArray<Recorded>, state: PlayerState) => {
  for (const [i, input] of inputs.entries()) {
    const mode: Context["mode"] = { kind: "replay", recorded: recorded[i] ?? { rolls: [], refusal: null } }
    state = step(state, input, contextAt(i + 1, minutesLater(i), mode)).state
  }
  return state
}

const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

/** A player well into the game: past level 1, with gold, an item, and the pet given or none. */
const playing = (pet: PlayerState["holdings"]["pet"] = null): PlayerState => {
  const state = fresh()
  return {
    ...state,
    // This window's missions already rolled, so a step rolls none and changes only what its input does.
    progress: {
      ...state.progress,
      xp: { verified: 0, reported: 640 },
      questWindows: { daily: "2026-10-09", weekly: "2026-10-05" },
    },
    holdings: {
      ...state.holdings,
      gold: 310,
      peakLevel: 3,
      pet,
      inventory: [
        {
          id: "01K6ZQ8W3J0000000000009001",
          itemId: "plain-cap",
          acquiredAt: start,
          source: { kind: "drop", ref: "0" },
          dye: null,
        },
      ],
    },
  }
}

const hatched: NonNullable<PlayerState["holdings"]["pet"]> = {
  species: "slime",
  name: "Goo",
  hatchedAt: start,
  forms: [0],
  form: 0,
  mood: { value: 90, at: start },
  petted: [],
}

const snapshotOf = (state: PlayerState) =>
  project(
    state,
    { rules: starterRules, catalog: starterCatalog, questPacks: [], now: start },
    {
      player: { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start },
      serverId: "local-test",
      streamEpoch: 1,
      cursor: 0,
    },
  )

/** What a step changed besides the name, the egg and the welcome: nothing, for the welcome's commands. */
const rest = (state: PlayerState) => {
  const { characterName: _name, welcomedAt: _welcomedAt, holdings, ...others } = state
  const { egg: _egg, ...kept } = holdings
  return { ...others, holdings: kept }
}

describe("names the player picks", () => {
  it("are tidied: trimmed, and each run of spaces inside one space", () => {
    expect(tidyName("  Ada   Lovelace \t")).toBe("Ada Lovelace")
    expect(tidyName("Zoë")).toBe("Zoë")
  })

  it("take letters and digits in any script, with spaces and . - _ ' after the first, up to the most", () => {
    for (const name of ["Ada", "Zoë", "李雷", "O'Brien", "R2-D2", "dev_42", "J. Doe", "x".repeat(maxNameLength)]) {
      expect(nameIssue(name, "your character")).toBeNull()
    }
    expect(nameIssue("", "your character")).toBe("Give your character a name")
    expect(nameIssue("x".repeat(maxNameLength + 1), "your egg")).toBe(
      `A name takes at most ${maxNameLength} characters, and that one has ${maxNameLength + 1}`,
    )
    for (const name of ["🦊 Fox", "-Ada", "Ada<script>", "a\u0000b", "'quoted'"]) {
      expect(nameIssue(name, "your egg")).toMatch(/^A name takes letters, digits/)
    }
  })
})

describe("character.rename", () => {
  it("names the character, tidied, says so, and changes nothing else", () => {
    const before = playing()
    const { state, steps } = play([rename("  Ada   Lovelace ")], before)
    expect(state.characterName).toBe("Ada Lovelace")
    expect(steps[0]?.refusal).toBeNull()
    expect(steps[0]?.events).toEqual([{ type: "character.renamed", data: { name: "Ada Lovelace" } }])
    expect(rest(state)).toEqual(rest(before))
    expect(snapshotOf(state).character.name).toBe("Ada Lovelace")
  })

  it("refuses a name it can't keep, saying why, and leaves the state as it was", () => {
    const before = playing()
    for (const name of ["   ", "x".repeat(maxNameLength + 1), "🦊"]) {
      const { state, steps } = play([rename(name)], before)
      expect(steps[0]?.refusal?.code).toBe("invalid")
      expect(state).toEqual(before)
    }
    expect(play([rename("")], before).steps[0]?.refusal?.message).toBe("Give your character a name")
  })
})

describe("egg.choose", () => {
  it("picks the egg's species and name before it hatches, which the snapshot shows in place of the default", () => {
    expect(snapshotOf(fresh()).egg).toEqual(starterRules.pet.egg)
    const { state, steps } = play([chooseEgg("owl", " Hoot ")], fresh())
    expect(state.holdings.egg).toEqual({ species: "owl", name: "Hoot" })
    expect(steps[0]?.events).toEqual([{ type: "egg.chosen", data: { species: "owl", name: "Hoot" } }])
    expect(snapshotOf(state).egg).toEqual({ species: "owl", name: "Hoot" })
    expect(snapshotOf(state).pet).toBeNull()
  })

  it("takes only a species of the rules', and a name the engine keeps", () => {
    const species = play([chooseEgg("dragon", "Smaug")], fresh()).steps[0]?.refusal
    const named = play([chooseEgg("owl", "")], fresh()).steps[0]?.refusal
    const message = "No egg hatches as a dragon: pick one of Fox, Slime, Robot, Owl"
    expect(species).toEqual({ code: "invalid", message })
    expect(named).toEqual({ code: "invalid", message: "Give your egg a name" })
    expect(play([chooseEgg("owl", "Hoot")], fresh()).steps[0]?.refusal).toBeNull()
  })

  it("is refused once the pet has hatched, which keeps its species and name", () => {
    const before = playing(hatched)
    const { state, steps } = play([chooseEgg("owl", "Hoot")], before)
    const message = "Goo has hatched, and keeps its species and name"
    expect(steps[0]?.refusal).toEqual({ code: "not_allowed", message })
    expect(state).toEqual(before)
    expect(snapshotOf(state).egg).toBeNull()
    expect(snapshotOf(state).pet).toMatchObject({ species: "slime", name: "Goo" })
  })

  it("can change its mind any number of times before the hatch, and the pet never renames after it", () => {
    const petRename: Input = command({ id: nextId(), type: "pet.rename", data: { name: "Hoot" } })
    const { state, steps } = play([chooseEgg("owl", "Hoot"), chooseEgg("robot", "Bolt"), hatch(), petRename], playing())
    expect(state.holdings.pet).toMatchObject({ species: "robot", name: "Bolt" })
    expect(steps[3]?.refusal?.code).toBe("not_allowed")
  })
})

describe("pet.hatch", () => {
  it("hatches the egg as picked, whatever the command names, and the egg is gone", () => {
    const { state, steps } = play([chooseEgg("owl", "Hoot"), hatch("fox", "Ember")], playing())
    expect(state.holdings.pet).toMatchObject({ species: "owl", name: "Hoot", mood: { value: 100 } })
    expect(state.holdings.egg).toBeNull()
    expect(steps[1]?.events).toEqual([
      { type: "pet.hatched", data: { species: "owl", name: "Hoot", form: 0, mood: 100, equipped: {} } },
    ])
  })

  it("with no egg picked hatches as the command names it, as an older mod's fox Ember, still only from level 1", () => {
    expect(play([hatch()], playing()).state.holdings.pet).toMatchObject({ species: "fox", name: "Ember" })
    expect(play([hatch()], fresh()).steps[0]?.refusal).toEqual({
      code: "not_allowed",
      message: "The egg hatches at level 1",
    })
    expect(play([hatch("dragon", "Smaug")], playing()).steps[0]?.refusal?.code).toBe("invalid")
    expect(play([hatch("fox", "")], playing()).steps[0]?.refusal?.code).toBe("invalid")
  })
})

describe("welcome.done", () => {
  it("marks the welcome done once, which the snapshot says; again changes nothing and says nothing", () => {
    expect(snapshotOf(fresh()).welcome).toEqual({ done: false })
    const { state, steps } = play([welcomeDone(), welcomeDone()], fresh())
    expect(state.welcomedAt).toBe(start)
    expect(steps.map((one) => one.refusal)).toEqual([null, null])
    expect(steps.map((one) => one.events)).toEqual([[{ type: "welcome.done", data: {} }], []])
    expect(snapshotOf(state).welcome).toEqual({ done: true })
  })
})

describe("the welcome, played through and replayed", () => {
  it("loses a saved player nothing, and a replay of its log ends where the live run did", () => {
    const before = playing()
    const inputs = [rename("Ada"), rename(""), chooseEgg("robot", "Bolt"), chooseEgg("dragon", "Smaug"), welcomeDone()]
    const { state, steps } = play(inputs, before)
    expect(rest(state)).toEqual(rest(before))
    expect(state.characterName).toBe("Ada")
    expect(state.holdings.egg).toEqual({ species: "robot", name: "Bolt" })
    expect(state.welcomedAt).toBe(minutesLater(4))
    expect(replay(inputs, steps, before)).toEqual(state)
    // The state stays one the schema reads, and the snapshot one the mod reads.
    expect(Schema.decodeUnknownSync(PlayerStateSchema)(state)).toEqual(state)
    expect(Schema.decodeUnknownExit(SnapshotSchema)(snapshotOf(state))._tag).toBe("Success")
  })
})
