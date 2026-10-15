import type { BetaChange, BetaEntry, BetaList } from '@pathofdev/schema'
import type { HttpResponse } from 'claude-code'
import type { Route } from './server'
import { failureOf, isRecord, parsed } from './server'

// The online server's beta list, from the prompt: `/pathofdev beta list|add <login>|remove <login>`, for the server's
// admins (by GitHub user id, set on the server). The mod sends the request with the player's game token and shows the
// server's answer; this file holds the pure half: what each ask is, its route, and the answer in the player's words.
//
//   /pathofdev beta list ───────────▶ GET    <origin>/v1/beta           ─┐
//   /pathofdev beta add <login> ────▶ POST   <origin>/v1/beta {login}   ─┼─▶ Bearer <game token>, the online origin only
//   /pathofdev beta remove <login> ─▶ DELETE <origin>/v1/beta/<login>   ─┘
//     answer ── 200 ────────────────▶ the list, or the server's line on what changed
//            ├─ 403 ────────────────▶ "Only the server's admins can see or change the beta list."
//            ├─ 400 ────────────────▶ the server's line: not a GitHub login
//            ├─ 401 ────────────────▶ signed out: /pathofdev login
//            └─ none, 429, 5xx, … ──▶ not answering, or what it answered
//
// A login that is no GitHub login is turned away here, before any request: it never rides in a URL.

/** What `/pathofdev beta …` asks. */
export type BetaAsk =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly login: string }
  | { readonly kind: 'remove'; readonly login: string }

export const betaUsage =
  'Beta list, for the online server\'s admins: /pathofdev beta list | add <github-login> | remove <github-login>.'

export const onlyAdmins = "Only the server's admins can see or change the beta list."

/** A GitHub login: 1 to 39 letters, digits and hyphens, no hyphen first; older accounts may end in or double one. */
export const isGithubLogin = (text: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(text)

/** What `/pathofdev <args>` asks of the beta list: null when the args are not `beta …`, the usage when they don't parse. */
export const betaAskOf = (args: string): BetaAsk | string | null => {
  const [head, what, login, ...rest] = args.trim().split(/\s+/)
  if (head !== 'beta') return null
  if (rest.length > 0) return betaUsage
  if (what === 'list') return login === undefined ? { kind: 'list' } : betaUsage
  if (what !== 'add' && what !== 'remove') return betaUsage
  if (login === undefined) return betaUsage
  if (!isGithubLogin(login)) return `${shown(login, 40)} is not a GitHub login. ${betaUsage}`
  return { kind: what, login }
}

/** The route an ask is sent on, to the online target. */
export const betaRouteOf = (ask: BetaAsk): Route => {
  switch (ask.kind) {
    case 'list':
      return { path: '/v1/beta' }
    case 'add':
      return { path: '/v1/beta', body: { login: ask.login } }
    case 'remove':
      return { path: `/v1/beta/${encodeURIComponent(ask.login)}`, method: 'DELETE' }
  }
}

/** Text from the server, as the player sees it: printable ASCII only, cut to `max` characters. */
const shown = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[^ -~]/g, '').slice(0, max) : ''

const isList = (value: unknown): value is BetaList => isRecord(value) && Array.isArray(value['entries'])
const isChange = (value: unknown): value is BetaChange =>
  isRecord(value) && typeof value['changed'] === 'boolean' && typeof value['message'] === 'string'

/** The day of an ISO time, or nothing. */
const dayOf = (at: unknown): string => {
  const day = shown(at, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/** The list, a line for each source: added (with the day), `ALLOWED_LOGINS`, and the admins. */
export const listText = (list: BetaList, origin: string): string => {
  const entries: ReadonlyArray<unknown> = list.entries
  const of = (source: BetaEntry['source']) =>
    entries.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry['source'] === source)
  const added = of('added').map((entry) => {
    const day = dayOf(entry['addedAt'])
    return `${shown(entry['login'], 39)}${day === '' ? '' : ` (${day})`}`
  })
  const listed = of('env').map((entry) => shown(entry['login'], 39))
  const admins = of('admin').map((entry) => {
    const id = typeof entry['githubUserId'] === 'number' ? entry['githubUserId'] : '?'
    const login = shown(entry['login'], 39)
    return login === '' ? `id ${id} (not signed in yet)` : `${login} (id ${id})`
  })
  const line = (names: ReadonlyArray<string>) => (names.length === 0 ? 'none' : names.join(', '))
  return [
    `The beta list on ${origin}:`,
    `- added from the mod: ${line(added)}`,
    `- ALLOWED_LOGINS (a redeploy changes these): ${line(listed)}`,
    `- admins, always in (ADMIN_GITHUB_IDS): ${line(admins)}`,
  ].join('\n')
}

/** What the server made of an ask, in the player's words; `response` null: no answer at all. */
export const betaTextOf = (
  ask: BetaAsk,
  response: Pick<HttpResponse, 'ok' | 'status' | 'text'> | null,
  origin: string,
): string => {
  if (response === null) return `The Path of Dev server at ${origin} is not answering: try again in a minute.`
  const body = parsed(response.text)
  if (response.status === 403) return onlyAdmins
  if (response.status === 400) {
    const message = isRecord(body) ? shown(body['message'], 160) : ''
    return message === '' ? `The server turned the login down: ${betaUsage}` : `${message}.`
  }
  const failure = failureOf(response)
  if (failure === 'signedOut') return `You're not signed in to ${origin}: /pathofdev login signs you in.`
  if (failure === 'unavailable')
    return `The Path of Dev server at ${origin} answered ${response.status}: try again in a minute.`
  if (failure === null && ask.kind === 'list' && isList(body)) return listText(body, origin)
  if (failure === null && ask.kind !== 'list' && isChange(body)) return shown(body.message, 240)
  return `The Path of Dev server at ${origin} answered the beta ${ask.kind} with ${response.status}.`
}
