import { starterCatalog, starterRules } from "@questline/engine"

// The rules the proof of concept runs under. Publishing rules versions (rules_versions, rules_head) comes later; for
// now every input runs under the starter config and catalogue.

export const rules = starterRules
export const catalog = starterCatalog
/** The oldest mod this server talks to. */
export const minClientVersion = "0.0.0"
/** The first version of each input's raw JSON in the log; upcasters key on it once the shapes change. */
export const inputSchemaVersion = 1
