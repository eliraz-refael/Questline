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

/** Runs the migrations not applied yet, in order. */
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord({ "0001_initial": initial }) })
