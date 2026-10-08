import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ClientEvent, clientEventTypes, CommandResponse, LevelCurve, RepoSlug, ServerEvent, Snapshot } from "../src/index.ts"

const ulid = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const at = "2026-10-08T12:00:00Z"
const decodeEvent = Schema.decodeUnknownExit(ClientEvent)

describe("ClientEvent", () => {
  const merged = {
    id: ulid,
    type: "pr.merged",
    occurredAt: at,
    sessionId: ulid,
    data: { repo: "acme/widgets", number: 212 },
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
    expect(decodeEvent({ ...merged, data: { repo: "/Users/someone/code", number: 1 } })._tag).toBe("Failure")
  })

  it("accepts a test run outside git, where repo, branch and sha don't exist", () => {
    const failed = { ...merged, type: "tests.failed", data: { repo: null, branch: null, headSha: null, runner: "vitest" } }
    expect(decodeEvent(failed)._tag).toBe("Success")
  })

  it("accepts SHA-256 commits as well as SHA-1", () => {
    const sha256 = "a".repeat(64)
    expect(decodeEvent({ ...merged, type: "commit.made", data: { repo: "acme/widgets", sha: sha256 } })._tag).toBe("Success")
  })

  it("allows a null repo only where the event can happen outside a repo", () => {
    const explored = { ...merged, type: "repo.explored", data: { repo: null } }
    expect(decodeEvent(explored)._tag).toBe("Success")
    expect(decodeEvent({ ...merged, data: { repo: null, number: 1 } })._tag).toBe("Failure")
  })
})

describe("RepoSlug", () => {
  it("accepts GitHub slugs and refuses path-like strings", () => {
    const valid = Schema.is(RepoSlug)
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
  it("decodes a fresh level-0 player with no pet", () => {
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
    expect(Schema.decodeUnknownSync(Snapshot)(snapshot)).toEqual(snapshot)
  })
})
