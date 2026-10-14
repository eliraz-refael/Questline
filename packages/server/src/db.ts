import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import type { Redacted } from "effect"
import { Layer } from "effect"
import type { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

// Where a server keeps its tables. The local server runs PGlite, Postgres compiled to WASM inside the process; a public
// server runs a real Postgres. Both speak the same SQL, so the migrations and every query run unchanged on either:
//
//   Database ──▶ sqlLayer ──▶ SqlClient ──▶ migrate ──▶ Players, PlayerWriter, Presence, …
//     pglite     PgliteClient (a folder, or memory)
//     postgres   PgClient (a pool on a url, in one schema)

export type Database =
  /** PGlite in `dataDir`, or in memory without one. */
  | { readonly kind: "pglite"; readonly dataDir?: string | undefined }
  /**
   * Postgres at `url`. `schema`, when set, is every connection's search_path, so several servers (or test runs) can
   * share one database, each in a schema of its own.
   */
  | {
    readonly kind: "postgres"
    readonly url: Redacted.Redacted
    readonly schema?: string | undefined
    readonly maxConnections?: number | undefined
  }

/** The SQL client over `database`, open for as long as the layer is. */
export const sqlLayer = (database: Database): Layer.Layer<SqlClient.SqlClient, SqlError> => {
  switch (database.kind) {
    case "pglite":
      return PgliteClient.layer(database.dataDir === undefined ? {} : { dataDir: database.dataDir })
    case "postgres":
      return PgClient.layer({
        url: database.url,
        ...(database.schema === undefined ? {} : { startupParameters: { search_path: database.schema } }),
        ...(database.maxConnections === undefined ? {} : { maxConnections: database.maxConnections }),
      })
  }
}
