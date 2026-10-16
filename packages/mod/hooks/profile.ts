import type { ProfileSettings } from '@pathofdev/schema'
import type { HttpResponse } from 'claude-code'
import type { Route } from './server'
import { argsOf, commonTextOf, isRecord, messageOf, parsed, printable } from './server'

// What the player's public page shows, from the prompt: `/pathofdev profile [public|private|hide <s>|show <s>]`, on the
// online server. The page is private until the player makes it public; a section is shown unless they hide it. The
// server alone knows which sections there are: the mod sends the word the player typed, and shows what the server
// says, the list of sections included.
//
//   /pathofdev profile ───────────────▶ GET  <origin>/v1/account/profile                  ─┐
//   /pathofdev profile public|private ─▶ POST <origin>/v1/account/profile {kind}           ─┼─▶ Bearer <game token>
//   /pathofdev profile hide|show <s> ──▶ POST <origin>/v1/account/profile {kind, section}  ─┘
//     answer ── 200 ─────────────▶ public or private, what it hides, and its address once there is one
//            ├─ 400 ─────────────▶ the server's line: no such section, and which there are
//            ├─ 401 ─────────────▶ signed out: /pathofdev login
//            └─ none, 429, 5xx ──▶ not answering, or what it answered

/** What `/pathofdev profile …` asks. */
export type ProfileAsk =
  | { readonly kind: 'view' }
  | { readonly kind: 'public' | 'private' }
  | { readonly kind: 'hide' | 'show'; readonly section: string }

export const profileUsage =
  'Your public profile, on the online server: /pathofdev profile | public | private | hide <section> | show <section>.'

/** What `/pathofdev <args>` asks of the profile: null when the args are not `profile …`, the usage when they don't parse. */
export const profileAskOf = (args: string): ProfileAsk | string | null => {
  const [head, what, section, ...rest] = argsOf(args)
  if (head !== 'profile') return null
  if (rest.length > 0) return profileUsage
  if (what === undefined) return { kind: 'view' }
  if (what === 'public' || what === 'private') return section === undefined ? { kind: what } : profileUsage
  if ((what === 'hide' || what === 'show') && section !== undefined) return { kind: what, section }
  return profileUsage
}

/** The route an ask is sent on, to the online target. */
export const profileRouteOf = (ask: ProfileAsk): Route =>
  ask.kind === 'view' ? { path: '/v1/account/profile' } : { path: '/v1/account/profile', body: ask }

const isSettings = (value: unknown): value is ProfileSettings =>
  isRecord(value) &&
  typeof value['isPublic'] === 'boolean' &&
  Array.isArray(value['hidden']) &&
  Array.isArray(value['sections'])

/** Words in a line: "a", "a and b", "a, b and c". */
const listed = (words: ReadonlyArray<string>): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** Where the profile stands, in the player's words: every word from the server printable. */
export const settingsText = (settings: ProfileSettings): string => {
  const sections = settings.sections.map((section) => printable(section, 32)).filter((section) => section !== '')
  const hidden = settings.hidden.map((section) => printable(section, 32)).filter((section) => section !== '')
  const shown = sections.filter((section) => !hidden.includes(section))
  const url = printable(settings.url, 200)
  const page = url === '' ? 'your page' : url
  const showing = shown.length === 0 ? 'only your level' : `your level, ${listed(shown)}`
  const status = settings.isPublic
    ? `Your profile is public: ${page} shows ${showing}.`
    : `Your profile is private: nobody sees it. /pathofdev profile public shows ${showing}.`
  const kept = hidden.length === 0 ? '' : ` Hidden: ${listed(hidden)}.`
  return `${status}${kept} Sections: ${sections.join(', ')}.`
}

/** What the server made of an ask, in the player's words; `response` null: no answer at all. */
export const profileTextOf = (
  ask: ProfileAsk,
  response: Pick<HttpResponse, 'ok' | 'status' | 'text'> | null,
  origin: string,
): string => {
  const common = commonTextOf(response, origin)
  if (common !== null || response === null) return common ?? ''
  if (response.status === 400) {
    const message = messageOf(response.text, 160)
    return message === '' ? profileUsage : `${message}. ${profileUsage}`
  }
  const body = parsed(response.text)
  if (response.ok && isSettings(body)) return settingsText(body)
  return `The Path of Dev server at ${origin} answered the profile ${ask.kind} with ${response.status}.`
}
