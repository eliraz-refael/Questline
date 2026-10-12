import { starterQuestPack } from "@pathofdev/engine"
import type { QuestPack as QuestPackType } from "@pathofdev/schema"
import { QuestPack } from "@pathofdev/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { nowIso, rules } from "./game.ts"

// The quest packs missions are drawn from. Every version a server publishes stays in `quest_packs` as it was; the
// rules config's `questPacks` names the active packs, and the newest version of each is in force. The server
// publishes the starter pack itself as it starts; publishing others (the admin route, a folder) comes later.

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = yield* nowIso
  // A version once published never changes: a starter pack edited in place needs a new version to take effect.
  yield* sql`
    INSERT INTO quest_packs (pack, version, pack_json, published_at)
    VALUES (${starterQuestPack.id}, ${starterQuestPack.version}, ${JSON.stringify(starterQuestPack)}::jsonb, ${now})
    ON CONFLICT (pack, version) DO NOTHING
  `
  const newest = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ pack_json: QuestPack }),
    execute: () => sql`SELECT DISTINCT ON (pack) pack_json FROM quest_packs ORDER BY pack, version DESC`,
  })
  const rows = yield* newest(undefined)
  const packs = rows.map((row) => row.pack_json)
  const active = rules.questPacks.flatMap((id) => packs.filter((pack) => pack.id === id))
  return QuestPacks.of({ active })
})

export class QuestPacks extends Context.Service<
  QuestPacks,
  {
    /** The newest version of each active pack, in the rules config's order. */
    readonly active: ReadonlyArray<QuestPackType>
  }
>()("pathofdev/QuestPacks") {
  static readonly layer: Layer.Layer<QuestPacks, SqlError | Schema.SchemaError, SqlClient.SqlClient> = Layer.effect(
    QuestPacks,
    make,
  )
}
