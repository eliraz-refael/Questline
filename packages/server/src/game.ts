import { starterCatalog, starterRules } from "@questline/engine"
import type { ItemDef, RulesConfig } from "@questline/schema"
import { catalogIssue } from "@questline/schema"
import { Clock, Context, Effect, Layer } from "effect"

// The rules the proof of concept runs under. Publishing rules versions (rules_versions, rules_head) comes later; for
// now every input runs under the starter config and catalogue.

/**
 * The catalogue as the rules allow it: a sigil outside its rarity's range would be held to the range unseen, so the
 * server refuses to start on one instead.
 */
export const checkedCatalog = (rules: RulesConfig, catalog: ReadonlyArray<ItemDef>): ReadonlyArray<ItemDef> => {
  const issue = catalogIssue(rules.prompt.sigilMultiplier, catalog)
  if (issue !== undefined) throw new Error(`The catalogue doesn't fit the rules: ${issue}`)
  return catalog
}

export const rules = starterRules
export const catalog = checkedCatalog(rules, starterCatalog)
/** The oldest mod this server talks to. */
export const minClientVersion = "0.0.0"
/** The first version of each input's raw JSON in the log; upcasters key on it once the shapes change. */
export const inputSchemaVersion = 1

/**
 * Dev mode: the sandbox that takes the dev commands. Only the local server turns it on, from `QUESTLINE_DEV=1`, and
 * only over a home of its own; any other server leaves it off, so the engine refuses them there.
 */
export class DevMode extends Context.Service<DevMode, { readonly isOn: boolean }>()("questline/DevMode") {
  static readonly layer = (isOn: boolean) => Layer.succeed(DevMode, { isOn })
}

/** The clock's time as the ISO string the engine and the log read. */
export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
