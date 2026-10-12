import { it } from "@effect/vitest"
import { initialState, levelForXp, levelOf, starterRules, step } from "@pathofdev/engine"
import type { CommandRefusal, Context, Recorded } from "@pathofdev/schema"
import { Input, PlayerState } from "@pathofdev/schema"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Schema } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import { carriedXp, catalog, migrate, migrations } from "../src/index.ts"
import { commit, hatch, minutesLater, nextId, profile, prompt, start } from "./fixtures.ts"

// Each test starts a fresh PGlite and runs every migration: the first cold start can take seconds on a CI runner.
const coldStart = 30_000

describe("migrations", () => {
  it.effect("start a player saved before the player stats from zero, and leave a newer one's alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Migrator.make({})({ loader: Migrator.fromRecord({ "0001_initial": migrations["0001_initial"] }) })
      const fresh = initialState({ ...profile, now: start })
      const { stats: _stats, ...before } = fresh.progress
      const saved = { ...fresh, progress: before }
      const counted = { ...fresh, progress: { ...fresh.progress, stats: { ...fresh.progress.stats, clears: 3 } } }
      for (const [id, state] of [["old", saved], ["new", counted]] satisfies Array<[string, unknown]>) {
        yield* sql`
          INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
          VALUES (${id}, NULL, NULL, 'Player', 'seed', ${start})
        `
        yield* sql`
          INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
          VALUES (${id}, ${JSON.stringify(state)}::jsonb, 0, 0, 1, 1, 1)
        `
      }
      yield* migrate
      const rows = yield* sql`SELECT state FROM player_state ORDER BY player_id DESC`
      const states = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: PlayerState })))(rows)
      expect(states.map((row) => row.state.progress.stats)).toEqual([fresh.progress.stats, counted.progress.stats])
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )

  it.effect("give celebrations stored before tiers the tier the engine now stages them at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Migrator.make({})({ loader: Migrator.fromRecord({ "0001_initial": migrations["0001_initial"] }) })
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
        VALUES ('p', NULL, NULL, 'Player', 'seed', ${start})
      `
      const rows: Array<[number, string, unknown]> = [
        [1, "level.up", { from: 0, to: 1 }],
        [2, "level.up", { from: 9, to: 10, title: "Adept" }],
        [3, "loot.dropped", { item: { rarity: "uncommon" }, gold: 0 }],
        [4, "level.up", { from: 1, to: 2, tier: "legendary" }],
      ]
      for (const [seq, type, data] of rows) {
        yield* sql`
          INSERT INTO server_events (player_id, seq, at, cause, type, data)
          VALUES ('p', ${seq}, ${start}, NULL, ${type}, ${JSON.stringify(data)}::jsonb)
        `
      }
      yield* migrate
      const tiers = yield* sql<{ tier: string }>`
        SELECT data ->> 'tier' AS tier FROM server_events WHERE player_id = 'p' ORDER BY seq
      `
      expect(tiers.map((row) => row.tier)).toEqual(["rare", "epic", "uncommon", "legendary"])
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )

  it.effect("give level-ups stored before glyphs the starter's glyph for their level", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          "0001_initial": migrations["0001_initial"],
          "0002_player_stats": migrations["0002_player_stats"],
          "0003_celebration_tiers": migrations["0003_celebration_tiers"],
        }),
      })
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
        VALUES ('p', NULL, NULL, 'Player', 'seed', ${start})
      `
      const rows: Array<[number, unknown]> = [
        [1, { from: 3, to: 4, tier: "rare" }],
        [2, { from: 4, to: 5, tier: "rare" }],
        [3, { from: 9, to: 10, tier: "epic", title: "Adept" }],
        [4, { from: 14, to: 15, tier: "rare" }],
        [5, { from: 19, to: 22, tier: "rare" }],
        [6, { from: 22, to: 23, tier: "rare", glyph: "✦" }],
      ]
      for (const [seq, data] of rows) {
        yield* sql`
          INSERT INTO server_events (player_id, seq, at, cause, type, data)
          VALUES ('p', ${seq}, ${start}, NULL, 'level.up', ${JSON.stringify(data)}::jsonb)
        `
      }
      yield* migrate
      const glyphs = yield* sql<{ glyph: string }>`
        SELECT data ->> 'glyph' AS glyph FROM server_events WHERE player_id = 'p' ORDER BY seq
      `
      expect(glyphs.map((row) => row.glyph)).toEqual(["⚔", "🗡️", "🛡️", "👑", "🐉", "✦"])
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )

  it("give drops stored before band looks an item with no look, and leave a look already there", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { "0005_band_looks": _looks, ...before } = migrations
      yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
        VALUES ('p', NULL, NULL, 'Player', 'seed', ${start})
      `
      const look = { glyphs: {}, colors: {}, frames: null, fps: null }
      const rows: Array<[number, string, unknown]> = [
        [1, "loot.dropped", { item: { id: "plain-cap", rarity: "common" }, tier: "common" }],
        [2, "loot.dropped", { item: { id: "solid-bar", rarity: "common", look }, tier: "common" }],
        [3, "gold.changed", { delta: 10, totalAfter: 10, reason: "drop" }],
      ]
      for (const [seq, type, data] of rows) {
        yield* sql`
          INSERT INTO server_events (player_id, seq, at, cause, type, data)
          VALUES ('p', ${seq}, ${start}, NULL, ${type}, ${JSON.stringify(data)}::jsonb)
        `
      }
      yield* migrate
      const stored = yield* sql<{ data: unknown }>`SELECT data FROM server_events WHERE player_id = 'p' ORDER BY seq`
      expect(stored.map((row) => row.data)).toEqual([
        { item: { id: "plain-cap", rarity: "common", look: null }, tier: "common" },
        { item: { id: "solid-bar", rarity: "common", look }, tier: "common" },
        { delta: 10, totalAfter: 10, reason: "drop" },
      ])
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )
  it.effect("work out the best grade and the profile from the graded prompts the log accepted, the best streak at 0", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0006"))
      yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
      const fresh = initialState({ ...profile, now: start })
      const { bestStreak: _best, ...progress } = fresh.progress
      const { best: _grade, dimensions: _dimensions, ...prompts } = fresh.progress.stats.prompts
      const saved = { ...fresh, progress: { ...progress, stats: { ...fresh.progress.stats, prompts: { ...prompts, graded: 2 } } } }
      const newer = { ...fresh, progress: { ...fresh.progress, bestStreak: 5 } }
      for (const [id, state] of [["old", saved], ["quiet", saved], ["new", newer]] satisfies Array<[string, unknown]>) {
        yield* sql`
          INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
          VALUES (${id}, NULL, NULL, 'Player', 'seed', ${start})
        `
        yield* sql`
          INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
          VALUES (${id}, ${JSON.stringify(state)}::jsonb, 0, 0, 1, 6, 5)
        `
      }
      const sharp = prompt(9)
      const loose = prompt(2)
      const graded = (one: typeof sharp, scores: Partial<typeof sharp.data.scores>) => ({
        kind: "client",
        event: { ...one, data: { ...one.data, scores: { ...one.data.scores, ...scores } } },
      })
      const rows: Array<[string, number, unknown, string]> = [
        ["old", 1, graded(sharp, { focus: 10, doneCriteria: 4 }), "accepted"],
        ["old", 2, graded(loose, {}), "accepted"],
        // Neither a rejected prompt nor other work counts.
        ["old", 3, graded(prompt(10), {}), "rejected"],
        ["old", 4, { kind: "client", event: commit("c") }, "accepted"],
        ["new", 1, graded(prompt(3), {}), "accepted"],
      ]
      for (const [player, logSeq, input, status] of rows) {
        yield* sql`
          INSERT INTO event_log (
            player_id, log_seq, input_id, natural_key, schema_version, input, received_at,
            engine_version, rules_version, catalog_version, status, reason, refusal
          ) VALUES (
            ${player}, ${logSeq}, ${`id-${logSeq}`}, NULL, 1, ${JSON.stringify(input)}::jsonb, ${start},
            6, 5, 3, ${status}, NULL, NULL
          )
        `
      }
      yield* migrate
      const stored = yield* sql`SELECT state FROM player_state ORDER BY player_id DESC`
      const states = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: PlayerState })))(stored)
      const [quiet, old, kept] = states.map((row) => row.state.progress)
      expect(old?.stats.prompts).toEqual({
        graded: 2,
        scoreSum: 0,
        regretted: 0,
        // (9 * 5 + 10 + 4) / 7, the starter's weights.
        best: 8.429,
        dimensions: { clarity: 11, grammar: 11, specificity: 11, instructive: 11, context: 11, doneCriteria: 6, focus: 12 },
      })
      expect(old?.bestStreak).toBe(0)
      expect(quiet?.stats.prompts).toEqual({ ...fresh.progress.stats.prompts, graded: 2 })
      expect(kept).toEqual(newer.progress)
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )

  it.effect("give a player saved before missions no rolled windows, so the next step rolls today's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0007"))
      yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
      const fresh = initialState({ ...profile, now: start })
      const { questWindows: _windows, ...progress } = fresh.progress
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
        VALUES ('p', NULL, NULL, 'Player', 'seed', ${start})
      `
      yield* sql`
        INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
        VALUES ('p', ${JSON.stringify({ ...fresh, progress })}::jsonb, 0, 0, 1, 7, 5)
      `
      yield* migrate
      const stored = yield* sql`SELECT state FROM player_state`
      const states = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: PlayerState })))(stored)
      expect(states.map((row) => row.state)).toEqual([fresh])
      expect(yield* sql`SELECT * FROM quest_packs`).toEqual([])
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )

  it.effect("give a pet saved before care no pats counted, ending where a replay of its log does", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0010"))
      yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
      // The log: the egg hatched, then a pat, which the server before care refused.
      const hatched: Input = { kind: "command", command: hatch() }
      const patted: Input = { kind: "command", command: { id: nextId(), type: "pet.pet", data: {} } }
      const refusal = { code: "not_allowed", message: "Not available in this version yet" } satisfies CommandRefusal
      const context = { rollSeed: "seed", rules: starterRules, catalog, questPacks: [] }
      const replaying = (recorded: Recorded): Context["mode"] => ({ kind: "replay", recorded })
      const first = step(initialState({ ...profile, now: start }), hatched, {
        ...context,
        now: start,
        logSeq: 1,
        mode: replaying({ rolls: [], refusal: null }),
      })
      const replayed = step(first.state, patted, {
        ...context,
        now: minutesLater(1),
        logSeq: 2,
        mode: replaying({ rolls: [], refusal }),
      }).state
      const pet = replayed.holdings.pet
      if (pet === null) throw new Error("the egg never hatched")
      // What the server before care saved: the same pet, with no pats kept.
      const { petted: _petted, ...older } = pet
      const saved = { ...replayed, holdings: { ...replayed.holdings, pet: older } }
      const players: Array<[string, unknown]> = [["pet", saved], ["egg", initialState({ ...profile, now: start })]]
      for (const [id, state] of players) {
        yield* sql`
          INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
          VALUES (${id}, NULL, NULL, 'Player', 'seed', ${start})
        `
        yield* sql`
          INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
          VALUES (${id}, ${JSON.stringify(state)}::jsonb, 2, 0, 1, 10, 7)
        `
      }
      yield* migrate
      const stored = yield* sql`
        SELECT player_id, state, engine_version, rules_version FROM player_state ORDER BY player_id
      `
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            player_id: Schema.String,
            state: PlayerState,
            engine_version: Schema.Number,
            rules_version: Schema.Number,
          }),
        ),
      )(stored)
      expect(rows.map((row) => [row.player_id, row.engine_version, row.rules_version])).toEqual([
        ["egg", 11, 8],
        ["pet", 11, 8],
      ])
      expect(rows[1]?.state).toEqual(replayed)
      expect(rows[1]?.state.holdings.pet?.petted).toEqual([])
      expect(rows[0]?.state).toEqual(initialState({ ...profile, now: start }))
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )

  it("keep every level on the steeper curve, and the share of the way to the next, by adding XP only", () => {
    const before = { base: 100, exponent: 1.6 }
    for (let total = 0; total <= 250_000; total += 37) {
      const was = levelForXp(before, total)
      const carried = total + carriedXp(total)
      const now = levelForXp(starterRules.levelCurve, carried)
      expect(carriedXp(total)).toBeGreaterThanOrEqual(0)
      expect(now.level).toBe(was.level)
      expect(Math.abs(now.intoLevel / now.forNextLevel - was.intoLevel / was.forNextLevel)).toBeLessThan(0.01)
    }
  })

  it.effect("carry a saved player's XP to the steeper curve, logged so a replay keeps it, and give old boosts a kind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0009"))
      yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
      const fresh = initialState({ ...profile, now: start })
      // 5,000 XP was level 11 and about half way to 12 under 100 * L^1.6.
      const boost = { source: "trail-mix", xpBoostPct: 10, endsAt: "2026-10-09T09:00:00.000Z" }
      const mid = {
        ...fresh,
        progress: { ...fresh.progress, xp: { verified: 0, reported: 5000 }, boosts: [boost] },
        holdings: { ...fresh.holdings, peakLevel: 11 },
      }
      for (const [id, state, logSeq] of [["mid", mid, 4], ["new", fresh, 0]] satisfies Array<[string, unknown, number]>) {
        yield* sql`
          INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at)
          VALUES (${id}, NULL, NULL, 'Player', 'seed', ${start})
        `
        yield* sql`
          INSERT INTO player_state (player_id, state, log_seq, server_seq, stream_epoch, engine_version, rules_version)
          VALUES (${id}, ${JSON.stringify(state)}::jsonb, ${logSeq}, 0, 1, 9, 6)
        `
      }
      yield* migrate
      const stored = yield* sql`
        SELECT player_id, state, log_seq, engine_version, rules_version FROM player_state ORDER BY player_id
      `
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            player_id: Schema.String,
            state: PlayerState,
            log_seq: Schema.Number,
            engine_version: Schema.Number,
            rules_version: Schema.Number,
          }),
        ),
      )(stored)
      // Every row reads as what its state now is, carried or not, so nothing keyed on the versions carries it again;
      // the shop's migration after it marks them engine 11, rules 8.
      expect(rows.map((row) => [row.player_id, row.engine_version, row.rules_version])).toEqual([
        ["mid", 11, 8],
        ["new", 11, 8],
      ])
      const [carried, untouched] = rows
      expect(carried?.state.progress.xp.reported).toBe(5000 + carriedXp(5000))
      expect(carriedXp(5000)).toBeGreaterThan(0)
      expect(carried === undefined ? null : levelOf(carried.state, starterRules).level).toBe(11)
      expect(carried?.state.progress.boosts).toEqual([{ ...boost, kind: "food" }])
      expect(carried?.log_seq).toBe(5)
      expect(untouched?.state).toEqual(fresh)
      expect(untouched?.log_seq).toBe(0)
      const logged = yield* sql<{ player_id: string; log_seq: number; natural_key: string; input: unknown }>`
        SELECT player_id, log_seq, natural_key, input FROM event_log ORDER BY player_id
      `
      expect(logged.map((row) => [row.player_id, row.log_seq, row.natural_key])).toEqual([["mid", 5, "xp.carried:7"]])
      const input = Schema.decodeUnknownSync(Input)(logged[0]?.input)
      expect(input).toEqual({ kind: "system", event: { type: "xp.carried", amount: carriedXp(5000), rulesVersion: 7 } })
      // The engine's step on the logged carry ends where the migration left the player, so a replay agrees with it.
      const saved: PlayerState = { ...mid, progress: { ...mid.progress, boosts: [{ ...boost, kind: "food" }] } }
      const context = { now: start, logSeq: 5, rollSeed: "seed", rules: starterRules, catalog, questPacks: [] }
      const replaying = { kind: "replay", recorded: { rolls: [], refusal: null } } satisfies Context["mode"]
      const stepped = step(saved, input, { ...context, mode: replaying })
      expect(stepped.state).toEqual(carried?.state)
      expect(stepped.events).toEqual([])
    }).pipe(Effect.provide(PgliteClient.layer({}))),
    coldStart,
  )
})
