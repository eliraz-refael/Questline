import type { Context, Input } from "@questline/schema"
import { Snapshot } from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { initialState, project, starterCatalog, starterRules, step, streakAsOf } from "../src/index.ts"

// 2026-10-05 is a Monday.
describe("streakAsOf", () => {
  it("counts consecutive active days, and today isn't missed before it ends", () => {
    expect(streakAsOf(["2026-10-05", "2026-10-06", "2026-10-07"], "2026-10-08", 1)).toEqual({
      days: 3,
      restDaysLeftThisWeek: 1,
      start: "2026-10-05",
    })
  })

  it("forgives one missed day a week, and says the rest day is spent", () => {
    expect(streakAsOf(["2026-10-05", "2026-10-07"], "2026-10-07", 1)).toEqual({
      days: 2,
      restDaysLeftThisWeek: 0,
      start: "2026-10-05",
    })
  })

  it("breaks on a second missed day in the same week", () => {
    expect(streakAsOf(["2026-10-05", "2026-10-08"], "2026-10-08", 1)).toEqual({
      days: 1,
      restDaysLeftThisWeek: 1,
      start: "2026-10-08",
    })
  })

  it("is empty with no active days", () => {
    expect(streakAsOf([], "2026-10-08", 1)).toEqual({ days: 0, restDaysLeftThisWeek: 1, start: null })
  })
})

describe("project", () => {
  const now = "2026-10-09T08:00:00Z"
  const player = { id: "01K6ZQ8W3J5V7XKQ2M4N6P8R9T", githubUserId: null, githubLogin: null, displayName: "Player", createdAt: now }
  const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
  const context = { rules: starterRules, catalog: starterCatalog, questPacks: [], now }

  it("draws a fresh player the Snapshot schema accepts", () => {
    const snapshot = project(initialState({ characterName: "Player", timezone: "UTC", now }), context, meta)
    expect(Schema.decodeUnknownExit(Snapshot)(snapshot)._tag).toBe("Success")
    expect(snapshot.character).toMatchObject({ level: 0, xp: { total: 0, forNextLevel: 100 }, gold: 0 })
  })

  it("shows level, title, gold and the pet after some play", () => {
    const merged: Input = {
      kind: "client",
      event: {
        id: "01K6ZQ8W3J0000000000000001",
        type: "change.merged",
        occurredAt: now,
        sessionId: player.id,
        data: { change: { type: "github", repo: "acme/widgets", number: 7, key: "ab".repeat(32) } },
      },
    }
    const hatch: Input = {
      kind: "command",
      command: { id: "01K6ZQ8W3J0000000000000002", type: "pet.hatch", data: { species: "fox", name: "Ember" } },
    }
    const live: Context["mode"] = { kind: "live" }
    const ctx = { ...context, rollSeed: "seed", mode: live }
    let state = initialState({ characterName: "Player", timezone: "UTC", now })
    state = step(state, merged, { ...ctx, logSeq: 1 }).state
    state = step(state, hatch, { ...ctx, logSeq: 2 }).state
    const snapshot = project(state, context, meta)
    expect(Schema.decodeUnknownExit(Snapshot)(snapshot)._tag).toBe("Success")
    expect(snapshot.character).toMatchObject({ level: 1, title: "Apprentice", xp: { total: 260 } })
    expect(snapshot.character.streak.days).toBe(1)
    expect(snapshot.pet).toEqual({ species: "fox", name: "Ember", form: 0, mood: 100, equipped: {} })
  })
})
