import type { SignInResponse } from '@pathofdev/schema'
import type { HttpInit, HttpResponse } from 'claude-code'
import type { Target } from './server'
import { failureOf, headersOf, isRecord, originOf, parsed } from './server'

// Signing in to the online server: `/pathofdev login` runs GitHub's device flow straight against github.com, with the
// game's public client id and no scopes (no secret anywhere), then trades the GitHub token for a game token at the
// target's own origin and forgets the GitHub token. This file holds the pure half: what each request looks like, total
// decoders for GitHub's answers (they never throw), and the poll's state machine.
//
//   /pathofdev login ─▶ POST github.com/login/device/code ─ no code ─▶ "GitHub did not start a sign-in"
//                         └─ { device_code, user_code, verification_uri, expires_in, interval }
//                              │  the player opens the URL and enters the code
//                              ▼
//                   ┌──▶ waiting(intervalMs, expiresAt) ── wait intervalMs ─▶ POST github.com/login/oauth/access_token
//                   │        │
//                   │        ├─ authorization_pending, no answer, 5xx ──▶ waiting, the same interval ──┐
//                   │        ├─ slow_down ──────────────────────────────▶ waiting, interval + 5 s ───────┤
//                   │        │                                               (or GitHub's, if longer)   │
//                   └────────┼──────────────────── while now + interval < expiresAt ◀───────────────────┘
//                            │                    else ──────────────────▶ expired ┐
//                            ├─ expired_token ───────────────────────────▶ expired ├─ terminal: absorbing, never
//                            ├─ access_denied ───────────────────────────▶ denied  │  polled again
//                            ├─ any other error ─────────────────────────▶ failed  │
//                            └─ access_token ────────────────────────────▶ signedIn┘
//                                                                            │
//   POST <origin>/v1/auth/github { githubToken, timezone }  (https, its own origin, no Authorization) ◀─┘
//     ├─ 200 { token, player } ─▶ the game token in $.store under token@<origin>; the GitHub token is dropped
//     ├─ 401 ───────────────────▶ refused: GitHub said no, or not in the beta; the sign-in stays as it was
//     ├─ 503 (429/502/504) ─────▶ unavailable: GitHub or the server couldn't check it; try again, the sign-in stays as it was
//     └─ anything else ─────────▶ unexpected

/** Path of Dev's GitHub app, as the device flow names it: public, with no secret. */
export const clientId = 'Ov23liaxznq5Qln0tRis'

export const deviceCodeUrl = 'https://github.com/login/device/code'
export const accessTokenUrl = 'https://github.com/login/oauth/access_token'
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'

/** GitHub's floor on the poll's interval, and what each `slow_down` adds to it (RFC 8628). */
export const minIntervalMs = 5_000
export const slowDownMs = 5_000

/** What `/pathofdev login|logout` asks; the usage line when the args don't parse; null when they are neither. */
export type AccountAsk = { readonly kind: 'login' } | { readonly kind: 'logout' }

export const accountUsage =
  'Sign-in: /pathofdev login signs you in to the online server with GitHub, and /pathofdev logout signs you out.'

export const accountAskOf = (args: string): AccountAsk | string | null => {
  const [head, ...rest] = args.trim().split(/\s+/)
  if (head !== 'login' && head !== 'logout') return null
  return rest.length > 0 ? accountUsage : { kind: head }
}

/** A form field, encoded: a lone surrogate, which `encodeURIComponent` throws on, goes as U+FFFD. */
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const encoded = (text: string): string => encodeURIComponent(text.replace(loneSurrogate, '\ufffd'))

const form = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([name, value]) => `${encoded(name)}=${encoded(value)}`)
    .join('&')

// To github.com only the client id and the device code go: no token of the game's, and no Authorization at all.
const toGitHub = (fields: Record<string, string>): HttpInit => ({
  method: 'POST',
  headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
  body: form(fields),
})

/** Asks GitHub for a device code and the code the player enters, with no scopes: the server only asks who they are. */
export const deviceCodeRequest = (): { readonly url: string; readonly init: HttpInit } => ({
  url: deviceCodeUrl,
  init: toGitHub({ client_id: clientId }),
})

/** Asks GitHub whether the player has entered the code yet. */
export const accessTokenRequest = (deviceCode: string): { readonly url: string; readonly init: HttpInit } => ({
  url: accessTokenUrl,
  init: toGitHub({ client_id: clientId, device_code: deviceCode, grant_type: deviceGrant }),
})

const filled = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** A device code GitHub gave: what the mod polls with, and what the player enters where. Times in seconds. */
export type DeviceCode = {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresIn: number
  readonly interval: number
}

/**
 * GitHub's answer to the device code request, or null for anything else: an error, a page that isn't JSON, a field
 * missing, or a verification URL that isn't plain https (it is shown to the player to open).
 */
export const deviceCodeOf = (text: string): DeviceCode | null => {
  const body = parsed(text)
  if (!isRecord(body)) return null
  const deviceCode = filled(body['device_code'])
  const userCode = filled(body['user_code'])
  const verificationUri = filled(body['verification_uri'])
  const expiresIn = seconds(body['expires_in'])
  if (deviceCode === null || userCode === null || verificationUri === null || expiresIn === null) return null
  // Each is shown to the player or sent back as it is: printable ASCII only.
  if (!/^https:\/\/[!-~]+$/.test(verificationUri) || !/^[!-~]{1,32}$/.test(userCode)) return null
  if (!/^[!-~]{1,256}$/.test(deviceCode)) return null
  const interval = seconds(body['interval']) ?? minIntervalMs / 1000
  return { deviceCode, userCode, verificationUri, expiresIn, interval }
}

/** GitHub's answer to a poll. */
export type TokenAnswer =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'slowDown'; readonly interval: number | null }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'failed'; readonly error: string }

/** A poll's answer, from any text at all: GitHub answers 200 with an `error` while the flow is under way. */
export const tokenAnswerOf = (text: string): TokenAnswer => {
  const body = parsed(text)
  if (!isRecord(body)) return { kind: 'failed', error: 'an answer that is not JSON' }
  const error = body['error']
  if (error === undefined) {
    const token = filled(body['access_token'])
    return token === null ? { kind: 'failed', error: 'no token' } : { kind: 'token', token }
  }
  switch (error) {
    case 'authorization_pending':
      return { kind: 'pending' }
    case 'slow_down':
      return { kind: 'slowDown', interval: seconds(body['interval']) }
    case 'expired_token':
      return { kind: 'expired' }
    case 'access_denied':
      return { kind: 'denied' }
    default:
      // Shown to the player: only a code of GitHub's shape, never free text from the answer.
      return { kind: 'failed', error: typeof error === 'string' && /^[a-z_]{1,64}$/.test(error) ? error : 'an error' }
  }
}

/**
 * A poll's answer from the response: null, as no answer, when GitHub is down or limiting (5xx, 429), which keeps the
 * flow waiting; any other answer is read as GitHub's word.
 */
export const pollAnswerOf = (response: Pick<HttpResponse, 'status' | 'text'>): TokenAnswer | null =>
  response.status >= 500 || response.status === 429 ? null : tokenAnswerOf(response.text)

/** Where the device flow stands: waiting for the player, or done one way or another. Times are clock ms. */
export type Poll =
  | { readonly kind: 'waiting'; readonly intervalMs: number; readonly expiresAt: number }
  | { readonly kind: 'signedIn'; readonly githubToken: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'failed'; readonly error: string }

/** Waiting only while the next poll, `intervalMs` from now, still comes before the code expires: never after. */
const waitOrExpire = (intervalMs: number, expiresAt: number, now: number): Poll =>
  now + intervalMs < expiresAt ? { kind: 'waiting', intervalMs, expiresAt } : { kind: 'expired' }

/** The flow as a device code starts it, `now`. */
export const firstPoll = (code: DeviceCode, now: number): Poll =>
  waitOrExpire(Math.max(minIntervalMs, code.interval * 1000), now + code.expiresIn * 1000, now)

/**
 * The flow after a poll answered `answer` (null: no answer) at `now`. A done flow stays as it is; the interval only
 * grows; and a waiting flow's next poll, `intervalMs` from `now`, always comes before it expires.
 */
export const nextPoll = (poll: Poll, answer: TokenAnswer | null, now: number): Poll => {
  if (poll.kind !== 'waiting') return poll
  if (answer === null) return waitOrExpire(poll.intervalMs, poll.expiresAt, now)
  switch (answer.kind) {
    case 'token':
      return { kind: 'signedIn', githubToken: answer.token }
    case 'pending':
      return waitOrExpire(poll.intervalMs, poll.expiresAt, now)
    case 'slowDown':
      return waitOrExpire(
        Math.max(poll.intervalMs + slowDownMs, (answer.interval ?? 0) * 1000),
        poll.expiresAt,
        now,
      )
    case 'expired':
      return { kind: 'expired' }
    case 'denied':
      return { kind: 'denied' }
    case 'failed':
      return { kind: 'failed', error: answer.error }
  }
}

/** The player's time zone, for a new player's local days; UTC when the runtime can't say. */
export const timeZoneOf = (): string => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone !== 'string' || zone === '') return 'UTC'
    // The server takes an IANA zone only: a runtime that can't place itself says `Etc/Unknown`, which it turns away.
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone === 'Etc/Unknown' ? 'UTC' : zone
  } catch {
    return 'UTC'
  }
}

/**
 * The trade of a GitHub token for a game token, at an online target's own https origin, carrying no Authorization;
 * null for any other target, so the GitHub token never goes over plain http, a local socket or elsewhere.
 */
export const signInRequestOf = (
  target: Target,
  githubToken: string,
  timezone: string,
): { readonly url: string; readonly init: HttpInit } | null =>
  target.kind === 'online' && originOf(target.origin) === target.origin
    ? {
        url: `${target.origin}/v1/auth/github`,
        init: { method: 'POST', headers: headersOf(target, null), body: JSON.stringify({ githubToken, timezone }) },
      }
    : null

/** What the server made of a sign-in. */
export type SignIn =
  | { readonly kind: 'signedIn'; readonly token: string; readonly login: string | null }
  | { readonly kind: 'refused'; readonly message: string | null }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly status: number }

// The token rides in a header from now on: printable ASCII with no spaces, or it is no token.
const isSignIn = (value: unknown): value is SignInResponse =>
  isRecord(value) &&
  typeof value['token'] === 'string' &&
  /^[!-~]{1,512}$/.test(value['token']) &&
  isRecord(value['player'])

/** The server's answer to a sign-in, from any response: a 401 says why when its body does, in a line at most. */
export const signInOf = (response: Pick<HttpResponse, 'ok' | 'status' | 'text'>): SignIn => {
  const failure = failureOf(response)
  const body = parsed(response.text)
  if (failure === 'signedOut') {
    const message = isRecord(body) ? filled(body['message']) : null
    return { kind: 'refused', message: message === null ? null : message.replace(/[^ -~]/g, '').slice(0, 120) }
  }
  if (failure === 'unavailable') return { kind: 'unavailable' }
  if (failure === 'unexpected' || !isSignIn(body)) return { kind: 'unexpected', status: response.status }
  // Shown to the player in a toast: printable ASCII only, like a refusal's message.
  const login = filled(body.player.githubLogin)?.replace(/[^ -~]/g, '').slice(0, 64) ?? ''
  return { kind: 'signedIn', token: body.token, login: login === '' ? null : login }
}
