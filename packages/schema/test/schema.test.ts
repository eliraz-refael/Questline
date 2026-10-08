import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ClientEvent, clientEventTypes, CommandResponse, GitHubRepo, LevelCurve, ServerEvent, Snapshot } from "../src/index.ts"

const ulid = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const key = "ab".repeat(32)
const repoKey = "cd".repeat(32)
const at = "2026-10-08T12:00:00Z"
const decodeEvent = Schema.decodeUnknownExit(ClientEvent)

describe("ClientEvent", () => {
  const merged = {
    id: ulid,
    type: "change.merged",
    occurredAt: at,
    sessionId: ulid,
    data: { change: { type: "github", repo: "acme/widgets", number: 212, key } },
  }

  it("decodes each event type by its `type`", () => {
    expect(Schema.decodeUnknownSync(ClientEvent)(merged)).toEqual(merged)
  })

  it("lists every accepted type for the session response", () => {
    expect(clientEventTypes).toContain("turn.completed")
    expect(clientEventTypes).toHaveLength(9)
  })

  it("refuses an unknown type, a bad id and a local path in place of a repo", () => {
    expect(decodeEvent({ ...merged, type: "file.read" })._tag).toBe("Failure")
    expect(decodeEvent({ ...merged, id: "not-a-ulid" })._tag).toBe("Failure")
    const local = { type: "github", repo: "/Users/someone/code", number: 1, key }
    expect(decodeEvent({ ...merged, data: { change: local } })._tag).toBe("Failure")
  })

  it("accepts a test run outside git, and one on a detached HEAD before any branch or commit", () => {
    const outside = { ...merged, type: "tests.failed", data: { checkout: null, runner: "vitest" } }
    expect(decodeEvent(outside)._tag).toBe("Success")
    const detached = { type: "github", repo: "acme/widgets", branch: null, headSha: null, key }
    expect(decodeEvent({ ...outside, data: { checkout: detached, runner: "vitest" } })._tag).toBe("Success")
  })

  it("accepts SHA-256 commits as well as SHA-1", () => {
    const commit = { type: "github", repo: "acme/widgets", sha: "a".repeat(64), key }
    expect(decodeEvent({ ...merged, type: "commit.made", data: { commit } })._tag).toBe("Success")
  })

  it("allows a null repo only where the event can happen outside a repo", () => {
    const explored = { ...merged, type: "repo.explored", data: { repo: null } }
    expect(decodeEvent(explored)._tag).toBe("Success")
    expect(decodeEvent({ ...merged, data: { change: null } })._tag).toBe("Failure")
  })

  it("carries private work as opaque keys, with no room for a name, number or branch", () => {
    const hidden = { type: "private", repo: repoKey, key }
    expect(Schema.decodeUnknownSync(ClientEvent)({ ...merged, data: { change: hidden } })).toEqual({
      ...merged,
      data: { change: hidden },
    })
    const leaky = Schema.decodeUnknownSync(ClientEvent)({ ...merged, data: { change: { ...hidden, number: 4 } } })
    expect(leaky.data).toEqual({ change: hidden })
    expect(decodeEvent({ ...merged, data: { change: { ...hidden, repo: "acme/secret" } } })._tag).toBe("Failure")
  })

  it("puts the private key on public work too, so work sent in both forms can be matched", () => {
    const { key: _key, ...unkeyed } = merged.data.change
    expect(decodeEvent({ ...merged, data: { change: unkeyed } })._tag).toBe("Failure")
  })

  it("groups private test runs by repo even when branch and head differ", () => {
    const checkout = { type: "private", repo: repoKey, key }
    const failed = { ...merged, type: "tests.failed", data: { checkout, runner: "vitest" } }
    expect(decodeEvent(failed)._tag).toBe("Success")
    const unkeyedRepo = { ...failed, data: { checkout: { type: "private", key }, runner: "vitest" } }
    expect(decodeEvent(unkeyedRepo)._tag).toBe("Failure")
  })
})

describe("GitHubRepo", () => {
  it("accepts GitHub slugs and refuses path-like strings", () => {
    const valid = Schema.is(GitHubRepo)
    expect(["acme/widgets", "a-b/c.d_e", "x/.github"].map(valid)).toEqual([true, true, true])
    expect(["~/code", "../secret", "acme/..", "C:\\Users\\bob/proj", "a/b/c", "acme/"].map(valid)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe("LevelCurve", () => {
  it("refuses a flat or falling curve, which no level could climb", () => {
    const valid = Schema.is(LevelCurve)
    expect(valid({ base: 100, exponent: 1.6 })).toBe(true)
    expect([{ base: 0, exponent: 1.6 }, { base: 100, exponent: 0 }, { base: -100, exponent: 1.6 }].map(valid)).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe("ServerEvent", () => {
  it("keeps the pet's bounds on pet.changed", () => {
    const changed = (data: object) => ({ seq: 8, at, type: "pet.changed", cause: null, data })
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ mood: 60, form: 2 }))._tag).toBe("Success")
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ mood: 140 }))._tag).toBe("Failure")
    expect(Schema.decodeUnknownExit(ServerEvent)(changed({ form: 9 }))._tag).toBe("Failure")
  })

  it("decodes a level-up with its optional fields left out", () => {
    const event = { seq: 7, at, type: "level.up", cause: ulid, data: { from: 4, to: 5 } }
    expect(Schema.decodeUnknownSync(ServerEvent)(event)).toEqual(event)
  })
})

describe("CommandResponse", () => {
  it("carries a refusal code", () => {
    const refused = { status: "refused", code: "insufficient_gold", message: "Needs 40 more gold" }
    expect(Schema.decodeUnknownSync(CommandResponse)(refused)).toEqual(refused)
  })
})

describe("Snapshot", () => {
  const snapshot = {
    serverId: "local",
    streamEpoch: 1,
    player: { id: ulid, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: at },
    character: {
      playerId: ulid,
      name: "Player",
      level: 0,
      xp: { total: 0, verified: 0, reported: 0, intoLevel: 0, forNextLevel: 100 },
      title: "Apprentice",
      prestige: 0,
      gold: 0,
      shards: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
      streak: { days: 0, restDaysLeftThisWeek: 1, lastDay: "2026-10-08" },
      equipped: {},
    },
    pet: null,
    inventory: [],
    quests: [],
    claims: [],
    shop: [],
    boosts: [],
    pity: { sinceRare: 0, sinceEpic: 0 },
    achievements: [],
    cursor: 0,
  }

  it("decodes a fresh level-0 player with no pet", () => {
    expect(Schema.decodeUnknownSync(Snapshot)(snapshot)).toEqual(snapshot)
  })

  it("holds names to the same 1-32 characters the commands and state allow", () => {
    expect(Schema.decodeUnknownExit(Snapshot)({ ...snapshot, character: { ...snapshot.character, name: "" } })._tag).toBe(
      "Failure",
    )
  })
})
