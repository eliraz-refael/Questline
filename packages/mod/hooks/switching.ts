import type { ConfigRow } from 'claude-code'
import type { Target } from './server'

// Switching servers from the prompt: `/pathofdev server` says where the mod plays, and `server play|dev|online` (or
// `dev off`, the way back from dev mode) moves it. The choice is the `server` option itself, written as the player
// would in /config, so the settings and the command never disagree; this file says what each answer reads.
//
//   /pathofdev server ──────────────▶ where: "Playing on …", and how to switch
//   /pathofdev server play|default ─┐
//   /pathofdev dev off ─────────────┼─▶ switch to the player's own save
//   /pathofdev server dev ──────────┼─▶ switch to the dev sandbox
//   /pathofdev server online ───────┘─▶ switch to the public server

/** A value of the `server` option. */
export type ServerName = 'default' | 'dev' | 'online'

/** What `/pathofdev server …` asks: where the mod plays, or to play somewhere else. */
export type ServerAsk = { readonly kind: 'where' } | { readonly kind: 'switch'; readonly to: ServerName }

export const serverUsage =
  'Servers: /pathofdev server play (your own save; default works too) | dev (the dev sandbox) | online (the public ' +
  'server). /pathofdev dev off is server play.'

// A Map, not an object: `server toString` or `server __proto__` must read as no server, not as Object's own.
const names: ReadonlyMap<string, ServerName> = new Map([
  ['play', 'default'],
  ['default', 'default'],
  ['dev', 'dev'],
  ['online', 'online'],
])

/**
 * What `/pathofdev <args>` asks of the servers: null when the args are neither `server …` nor `dev off`, the usage
 * line when they don't parse.
 */
export const serverAskOf = (args: string): ServerAsk | string | null => {
  const words = args.trim().split(/\s+/)
  if (words.length === 2 && words[0] === 'dev' && words[1] === 'off') return { kind: 'switch', to: 'default' }
  if (words[0] !== 'server') return null
  if (words.length === 1) return { kind: 'where' }
  const to = names.get(words[1] ?? '')
  return to === undefined || words.length > 2 ? serverUsage : { kind: 'switch', to }
}

/** The `server` option's value for a target. */
export const nameOf = (target: Target): ServerName =>
  target.kind === 'online' ? 'online' : target.dev === true ? 'dev' : 'default'

/** What the pane's header names beside its title: the dev sandbox or online, and nothing for the player's own save. */
export const tagOf = (target: Target): string =>
  target.kind === 'online' ? 'online' : target.dev === true ? 'dev' : ''

/** The folder a local server keeps its save in, as the player would type it: `PATHOFDEV_HOME` when it names one. */
export const folderOf = (named: string | undefined, isDev: boolean): string =>
  named !== undefined && named !== '' ? named : isDev ? '~/.pathofdev-dev' : '~/.pathofdev'

/** Where a target is, in the player's words: "your own save (~/.pathofdev)", or the online server's origin. */
export const placeOf = (target: Target, named: string | undefined): string =>
  target.kind === 'online'
    ? `the online server at ${target.origin}`
    : target.dev === true
      ? `the dev sandbox (${folderOf(named, true)})`
      : `your own save (${folderOf(named, false)})`

/** What a switch answers once it has moved: "Now playing on your own save (~/.pathofdev)." and the like. */
export const nowText = (target: Target, named: string | undefined): string =>
  target.kind === 'local' && target.dev === true
    ? `Now on ${placeOf(target, named)}.`
    : `Now playing on ${placeOf(target, named)}.`

/** What `/pathofdev server` answers: where the mod plays, and how to move it. */
export const whereText = (target: Target, named: string | undefined): string =>
  `Playing on ${placeOf(target, named)}. Switch with /pathofdev server play, dev or online.`

/**
 * The `/config` row of this plugin's `server` option, as `$.config.list` lists it: the row's key is `<plugin>.server`,
 * the plugin named by its manifest (`questline`), or by where it was installed from (`questline@<marketplace>`).
 * Null when no row is this plugin's.
 */
export const serverRowOf = (rows: ReadonlyArray<ConfigRow>, plugin: string): ConfigRow | null => {
  const isOurs = (name: string) => name === plugin || name.startsWith(`${plugin}@`)
  return (
    rows.find(
      (row) =>
        row.key.endsWith('.server') &&
        (isOurs(row.provider.plugin) || isOurs(row.key.slice(0, -'.server'.length))) &&
        (row.options === undefined || row.options.includes('dev')),
    ) ?? null
  )
}
