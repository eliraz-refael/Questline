import { it } from "@effect/vitest"
import { initialState } from "@questline/engine"
import { PlayerState } from "@questline/schema"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Schema } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import { migrate, migrations } from "../src/index.ts"
import { profile, start } from "./fixtures.ts"

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
  )
})
