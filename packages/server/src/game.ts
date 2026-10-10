import { starterCatalog, starterRules } from "@questline/engine"
import { Context, Layer } from "effect"

// The rules the proof of concept runs under. Publishing rules versions (rules_versions, rules_head) comes later; for
// now every input runs under the starter config and catalogue.

export const rules = starterRules
export const catalog = starterCatalog
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
