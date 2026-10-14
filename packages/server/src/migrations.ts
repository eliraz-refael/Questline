import { levelForXp, xpForLevel } from "@pathofdev/engine"
import { Clock, Effect, Schema } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { ServerRandom } from "./random.ts"

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

// Item definitions gained a `look` (band styles only): the drops stored before it carry an item with none, so they
// get `look: null`, which every item but a band style has.
const bandLooks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE server_events
    SET data = jsonb_set(data, '{item,look}', 'null'::jsonb)
    WHERE type = 'loot.dropped' AND data -> 'item' IS NOT NULL AND data -> 'item' -> 'look' IS NULL
  `
})

// The stats gained the best grade, the prompting profile (each quality score's sum, which the profile averages) and the
// best streak. The grades are worked out again from the graded prompts the log accepted, priced by the starter's
// weights (all 1), written out here so this migration means the same thing whatever the rules later become. The best
// streak starts at 0: the current streak stands in for it until it passes it.
const statsProfile = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    WITH graded AS (
      SELECT player_id, input -> 'event' -> 'data' -> 'scores' AS s
      FROM event_log
      WHERE status = 'accepted' AND input ->> 'kind' = 'client' AND input -> 'event' ->> 'type' = 'prompt.graded'
    ),
    sums AS (
      SELECT
        p.player_id,
        COALESCE(SUM((s ->> 'clarity')::numeric), 0) AS clarity,
        COALESCE(SUM((s ->> 'grammar')::numeric), 0) AS grammar,
        COALESCE(SUM((s ->> 'specificity')::numeric), 0) AS specificity,
        COALESCE(SUM((s ->> 'instructive')::numeric), 0) AS instructive,
        COALESCE(SUM((s ->> 'context')::numeric), 0) AS context,
        COALESCE(SUM((s ->> 'doneCriteria')::numeric), 0) AS done_criteria,
        COALESCE(SUM((s ->> 'focus')::numeric), 0) AS focus,
        COALESCE(MAX(ROUND((
          (s ->> 'clarity')::numeric + (s ->> 'grammar')::numeric + (s ->> 'specificity')::numeric +
          (s ->> 'instructive')::numeric + (s ->> 'context')::numeric + (s ->> 'doneCriteria')::numeric +
          (s ->> 'focus')::numeric
        ) / 7, 3)), 0) AS best
      FROM player_state p
      LEFT JOIN graded g ON g.player_id = p.player_id
      GROUP BY p.player_id
    )
    UPDATE player_state p
    SET state = jsonb_set(
      p.state,
      '{progress,stats,prompts}',
      (p.state -> 'progress' -> 'stats' -> 'prompts') || jsonb_build_object(
        'best', sums.best,
        'dimensions', jsonb_build_object(
          'clarity', sums.clarity,
          'grammar', sums.grammar,
          'specificity', sums.specificity,
          'instructive', sums.instructive,
          'context', sums.context,
          'doneCriteria', sums.done_criteria,
          'focus', sums.focus
        )
      )
    )
    FROM sums
    WHERE sums.player_id = p.player_id AND p.state -> 'progress' -> 'stats' -> 'prompts' -> 'best' IS NULL
  `
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{progress,bestStreak}', '0'::jsonb)
    WHERE state -> 'progress' -> 'bestStreak' IS NULL
  `
})

// Missions: the quest packs the server has published, each version kept as it was, and the windows the engine last
// rolled missions for. A player made before them has rolled none, so the next step rolls today's and this week's.
const missions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE quest_packs (
      pack text NOT NULL,
      version integer NOT NULL,
      pack_json jsonb NOT NULL,
      published_at text NOT NULL,
      PRIMARY KEY (pack, version)
    )
  `
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{progress,questWindows}', '{"daily":null,"weekly":null}'::jsonb)
    WHERE state -> 'progress' -> 'questWindows' IS NULL
  `
})

// Presence: the sessions a mod keeps live, each with the last time it was heard from, outside the log. A player saved
// before it has no session spans, and no mission waits on parallel prompts, written out here so this migration means
// the same thing whatever the engine later becomes.
const presence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE sessions (
      player_id text NOT NULL REFERENCES players (id),
      session_id text NOT NULL,
      client_version text,
      opened_at text NOT NULL,
      last_heard_at text NOT NULL,
      closed_at text,
      close_reason text,
      PRIMARY KEY (player_id, session_id)
    )
  `
  yield* sql`CREATE INDEX sessions_open ON sessions (last_heard_at) WHERE closed_at IS NULL`
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{progress,presence}', '[]'::jsonb)
    WHERE state -> 'progress' -> 'presence' IS NULL
  `
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(
      state,
      '{progress,quests}',
      (
        SELECT COALESCE(
          jsonb_agg(CASE WHEN mission ? 'prompts' THEN mission ELSE mission || '{"prompts":[]}'::jsonb END ORDER BY i),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(state -> 'progress' -> 'quests') WITH ORDINALITY AS missions (mission, i)
      )
    )
    WHERE jsonb_typeof(state -> 'progress' -> 'quests') = 'array'
  `
})

// Sigils: the level curve steepened from base 100 * L^1.6 to 100 * L^1.66 (rules version 7), so a saved player would
// have dropped a level or more. Each one keeps their level and their share of the way to the next: they are given the
// XP their place takes on the new curve, as reported XP, logged as an `xp.carried` input so a replay of the log adds it
// too. The curves are written out here, so this migration means the same thing whatever the rules later become.
// Boosts gained a kind: any stored before it came from food, the only kind there was. The rows then read as engine 10
// and rules 7, which their state now is.
//
// It writes the state itself rather than running the engine's `step` on the carry: a database migrated later runs this
// with the engine and the state schema of that day, which may not read a state shaped for this one. The engine's
// `xp.carried` keeps to the same effect on such a state (the XP, the peak level already reached), and a test holds
// the two together.
const carriedCurve = { from: { base: 100, exponent: 1.6 }, to: { base: 100, exponent: 1.66 }, rulesVersion: 7 }

/** The XP that puts `total` at the same level, and the same share into it, on the steeper curve. */
export const carriedXp = (total: number): number => {
  const { from, to } = carriedCurve
  const was = levelForXp(from, total)
  const share = was.intoLevel / was.forNextLevel
  const span = xpForLevel(to, was.level + 1) - xpForLevel(to, was.level)
  return Math.max(0, xpForLevel(to, was.level) + Math.floor(share * span) - total)
}

const SavedXp = Schema.Struct({
  progress: Schema.Struct({
    xp: Schema.Struct({ verified: Schema.Number, reported: Schema.Number }),
    prestigeXp: Schema.Number,
  }),
})

const sigils = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const random = yield* ServerRandom
  const now = new Date(yield* Clock.currentTimeMillis).toISOString()
  const rows = yield* sql<{ player_id: string; state: unknown; log_seq: number }>`
    SELECT player_id, state, log_seq FROM player_state WHERE rules_version < ${carriedCurve.rulesVersion}
  `
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(
      state,
      '{progress,boosts}',
      (
        SELECT COALESCE(
          jsonb_agg(CASE WHEN boost ? 'kind' THEN boost ELSE boost || '{"kind":"food"}'::jsonb END ORDER BY i),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(state -> 'progress' -> 'boosts') WITH ORDINALITY AS boosts (boost, i)
      )
    )
    WHERE jsonb_typeof(state -> 'progress' -> 'boosts') = 'array' AND rules_version < ${carriedCurve.rulesVersion}
  `
  for (const row of rows) {
    const saved = yield* Schema.decodeUnknownEffect(SavedXp)(row.state)
    const { xp, prestigeXp } = saved.progress
    const amount = carriedXp(Math.max(0, xp.verified + xp.reported - prestigeXp))
    if (amount === 0) continue
    const logSeq = row.log_seq + 1
    const input = { kind: "system", event: { type: "xp.carried", amount, rulesVersion: carriedCurve.rulesVersion } }
    const id = yield* random.id(now, logSeq)
    // The versions the carry was made under: engine 10, rules 7, catalogue 4, the first input schema.
    yield* sql`
      INSERT INTO event_log (
        player_id, log_seq, input_id, natural_key, schema_version, input, received_at,
        engine_version, rules_version, catalog_version, status, reason, refusal
      ) VALUES (
        ${row.player_id}, ${logSeq}, ${id}, ${`xp.carried:${carriedCurve.rulesVersion}`}, 1,
        ${JSON.stringify(input)}::jsonb, ${now}, 10, ${carriedCurve.rulesVersion}, 4, 'accepted', NULL, NULL
      )
    `
    yield* sql`
      UPDATE player_state
      SET state = jsonb_set(state, '{progress,xp,reported}', to_jsonb(${xp.reported + amount}::integer)),
          log_seq = ${logSeq}
      WHERE player_id = ${row.player_id}
    `
  }
  yield* sql`
    UPDATE player_state SET engine_version = 10, rules_version = ${carriedCurve.rulesVersion}
    WHERE rules_version < ${carriedCurve.rulesVersion}
  `
})

// The shop and pet care (engine 11, rules 8): a pet now keeps the pats of the last hour, as only so many an hour lift
// its mood. A pet saved before it has had none, since every pet.pet the log holds was refused, so a replay of the log
// keeps the pet just as this leaves it. The rows then read as engine 11 and rules 8, which their state now is.
const shopPetCare = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{holdings,pet,petted}', '[]'::jsonb)
    WHERE jsonb_typeof(state -> 'holdings' -> 'pet') = 'object' AND state -> 'holdings' -> 'pet' -> 'petted' IS NULL
  `
  yield* sql`UPDATE player_state SET engine_version = 11, rules_version = 8 WHERE engine_version < 11`
})

// The first-run welcome (engine 13, rules 11): the state keeps when the player finished or skipped it, and the egg they
// picked in it. A player saved before it has done neither, since every command that sets them is new, so a replay of
// the log ends with both empty, as this leaves them: such a player is offered the welcome once, their save untouched.
// The rows then read as engine 13 and rules 11, which their state now is.
const welcome = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{welcomedAt}', 'null'::jsonb)
    WHERE state -> 'welcomedAt' IS NULL
  `
  yield* sql`
    UPDATE player_state
    SET state = jsonb_set(state, '{holdings,egg}', 'null'::jsonb)
    WHERE jsonb_typeof(state -> 'holdings') = 'object' AND state -> 'holdings' -> 'egg' IS NULL
  `
  yield* sql`UPDATE player_state SET engine_version = 13, rules_version = 11 WHERE engine_version < 13`
})

// Accounts on the public server. A sign-in trades a GitHub token for a game token, of which only the SHA-256 is kept,
// so a copy of the table signs nobody in. A GitHub login names one account at a time, in any case, so the sign-in
// clears a login from the row that held it before another account took it. `profile` holds what a player shows on
// their public page: private until they say otherwise, and a section it has no key for shown. The partial index
// serves a profile's XP history, by player and time, over the two event types it reads.
const accounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE api_tokens (
      token_hash text PRIMARY KEY,
      player_id text NOT NULL REFERENCES players (id),
      created_at text NOT NULL
    )
  `
  yield* sql`CREATE INDEX api_tokens_player ON api_tokens (player_id)`
  yield* sql`ALTER TABLE players ADD COLUMN profile jsonb NOT NULL DEFAULT '{"public": false}'::jsonb`
  yield* sql`CREATE UNIQUE INDEX players_github_login ON players (lower(github_login))`
  yield* sql`
    CREATE INDEX server_events_progress ON server_events (player_id, at)
    WHERE type IN ('xp.granted', 'level.up')
  `
})

/** Every migration, by the name the migrator records it under. */
export const migrations = {
  "0001_initial": initial,
  "0002_player_stats": playerStats,
  "0003_celebration_tiers": celebrationTiers,
  "0004_level_glyphs": levelGlyphs,
  "0005_band_looks": bandLooks,
  "0006_stats_profile": statsProfile,
  "0007_missions": missions,
  "0008_presence": presence,
  "0009_sigils": sigils,
  "0010_shop_pet_care": shopPetCare,
  "0011_welcome": welcome,
  "0012_accounts": accounts,
}

/** A migration: what it needs past the database is the server's randomness, for the ids of the inputs it logs. */
export type Migration = Effect.Effect<void, SqlError | Schema.SchemaError, SqlClient.SqlClient | ServerRandom>

/** Runs those of `record` not applied yet, in the order of their names. */
export const runMigrations = (record: Readonly<Record<string, Migration>>) =>
  Effect.gen(function* () {
    const random = yield* ServerRandom
    const provided = Object.fromEntries(
      Object.entries(record).map(([name, migration]) => [name, Effect.provideService(migration, ServerRandom, random)]),
    )
    return yield* Migrator.make({})({ loader: Migrator.fromRecord(provided) })
  })

/** Runs the migrations not applied yet, in order. */
export const migrate = runMigrations(migrations)
