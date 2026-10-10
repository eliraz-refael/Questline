import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/sql"

// The proof of concept's tables (see the design doc's Data model). The event log is the truth; player_state is the
// engine state at its head. Times the engine reads are kept as the ISO strings it was given, so a replay sees the
// exact same text.

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE players (
      id text PRIMARY KEY,
      github_user_id bigint UNIQUE,
      github_login text,
      display_name text NOT NULL,
      roll_seed text NOT NULL,
      created_at text NOT NULL
    )
  `
  // Created with the player, so the write path's lock always has a row to hold.
  yield* sql`
    CREATE TABLE player_state (
      player_id text PRIMARY KEY REFERENCES players (id),
      state jsonb NOT NULL,
      log_seq integer NOT NULL,
      server_seq integer NOT NULL,
      stream_epoch integer NOT NULL,
      engine_version integer NOT NULL,
      rules_version integer NOT NULL
    )
  `
  // Every input the write path took, under its id and, for work, its natural key, so a repeat counts once.
  yield* sql`
    CREATE TABLE event_log (
      player_id text NOT NULL REFERENCES players (id),
      log_seq integer NOT NULL,
      input_id text NOT NULL,
      natural_key text,
      schema_version integer NOT NULL,
      input jsonb NOT NULL,
      received_at text NOT NULL,
      engine_version integer NOT NULL,
      rules_version integer NOT NULL,
      catalog_version integer NOT NULL,
      status text NOT NULL,
      reason text,
      refusal jsonb,
      PRIMARY KEY (player_id, log_seq),
      UNIQUE (player_id, input_id),
      UNIQUE (player_id, natural_key)
    )
  `
  yield* sql`
    CREATE TABLE server_events (
      player_id text NOT NULL REFERENCES players (id),
      seq integer NOT NULL,
      at text NOT NULL,
      cause text,
      type text NOT NULL,
      data jsonb NOT NULL,
      PRIMARY KEY (player_id, seq)
    )
  `
  yield* sql`CREATE INDEX server_events_cause ON server_events (player_id, cause)`
  yield* sql`
    CREATE TABLE rolls (
      player_id text NOT NULL REFERENCES players (id),
      number integer NOT NULL,
      log_seq integer NOT NULL,
      record jsonb NOT NULL,
      PRIMARY KEY (player_id, number)
    )
  `
  yield* sql`
    CREATE TABLE quarantine (
      player_id text NOT NULL REFERENCES players (id),
      input_id text NOT NULL,
      input jsonb NOT NULL,
      error text NOT NULL,
      received_at text NOT NULL,
      PRIMARY KEY (player_id, input_id)
    )
  `
})

// The player stats joined the engine state: a player made before them starts counting from zero. The counters are
// written out here rather than taken from the engine, so this migration means the same thing whatever the engine
// later becomes.
const playerStats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const stats = {
    clears: 0,
    compactions: { manual: 0, auto: 0 },
    commands: {},
    context: { crossed: { pct50: 0, pct75: 0, pct100: 0 }, sessions: 0, peakSum: 0, recent: [] },
    prompts: { graded: 0, scoreSum: 0, regretted: 0 },
  }
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{progress,stats}', ${JSON.stringify(stats)}::jsonb)
    WHERE state -> 'progress' -> 'stats' IS NULL
  `
})

// Celebrations gained a `tier`: the stream and repeats decode stored events, so the ones written before it get the
// tier the engine now gives them (a drop its rarity; a level up epic with a new title or evolution, else rare).
const celebrationTiers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE server_events
    SET data = data || jsonb_build_object('tier', data -> 'item' -> 'rarity')
    WHERE type = 'loot.dropped' AND data -> 'tier' IS NULL
  `
  yield* sql`
    UPDATE server_events
    SET data = data || jsonb_build_object(
      'tier',
      CASE WHEN data -> 'title' IS NOT NULL OR data -> 'evolution' IS NOT NULL THEN 'epic' ELSE 'rare' END
    )
    WHERE type = 'level.up' AND data -> 'tier' IS NULL
  `
})

// Level-ups gained the level's glyph: the ones written before it get the starter's glyph for their level, written out
// here so this migration means the same thing whatever the rules later become.
const levelGlyphs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE server_events
    SET data = data || jsonb_build_object(
      'glyph',
      CASE
        WHEN (data ->> 'to')::integer >= 20 THEN '🐉'
        WHEN (data ->> 'to')::integer >= 15 THEN '👑'
        WHEN (data ->> 'to')::integer >= 10 THEN '🛡️'
        WHEN (data ->> 'to')::integer >= 5 THEN '🗡️'
        ELSE '⚔'
      END
    )
    WHERE type = 'level.up' AND data -> 'glyph' IS NULL
  `
})

/** Every migration, by the name the migrator records it under. */
export const migrations = {
  "0001_initial": initial,
  "0002_player_stats": playerStats,
  "0003_celebration_tiers": celebrationTiers,
  "0004_level_glyphs": levelGlyphs,
}

/** Runs the migrations not applied yet, in order. */
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord(migrations) })
