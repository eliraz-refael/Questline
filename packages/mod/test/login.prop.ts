import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { Poll, TokenAnswer } from '../hooks/login'
import {
  accessTokenRequest,
  accountAskOf,
  clientId,
  deviceCodeOf,
  deviceCodeRequest,
  firstPoll,
  minIntervalMs,
  nextPoll,
  pollAnswerOf,
  signInOf,
  signInRequestOf,
  slowDownMs,
  tokenAnswerOf,
} from '../hooks/login'
import type { Target } from '../hooks/server'
import { originOf } from '../hooks/server'
import { github } from './github'

// Signing in, as properties: GitHub's answers read whatever they hold, the device flow's poll only ever slows, ends
// for good and never outlives its code, and a token goes only where it may. The recorded GitHub answers pin the
// decoders to what GitHub really sends.

const decodedPoll = (text: string) => tokenAnswerOf(text)

describe("GitHub's recorded answers", () => {
  it('a device code: the code to enter, where, for how long, and how often to ask', () => {
    expect(deviceCodeOf(github.deviceCode)).toEqual({
      deviceCode: '3584d83530557fdd1f46af8289938c8ef79f9dc5',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 899,
      interval: 5,
    })
  })

  it('pending, slow_down with its new interval, expired, denied, and the token', () => {
    expect(decodedPoll(github.pending)).toEqual({ kind: 'pending' })
    expect(decodedPoll(github.slowDown)).toEqual({ kind: 'slowDown', interval: 10 })
    expect(decodedPoll(github.expired)).toEqual({ kind: 'expired' })
    expect(decodedPoll(github.denied)).toEqual({ kind: 'denied' })
    expect(decodedPoll(github.success)).toEqual({ kind: 'token', token: 'gho_16C7e42F292c6912E7710c838347Ae178B4a' })
  })

  it('no poll answer is a device code, and the device code is no poll answer', () => {
    for (const text of [github.pending, github.slowDown, github.expired, github.denied, github.success])
      expect(deviceCodeOf(text)).toBeNull()
    expect(decodedPoll(github.deviceCode).kind).toBe('failed')
    // JSON may name a key `__proto__`: it is only a field, never the object's prototype.
    expect(decodedPoll('{"__proto__":{"error":"access_denied"}}')).toEqual({ kind: 'failed', error: 'no token' })
    expect(deviceCodeOf('{"__proto__":{"device_code":"d","user_code":"U"}}')).toBeNull()
  })
})

/** JSON shaped like GitHub's answers: its field names, and values of every kind, right or wrong. */
const Field = Schema.Literals([
  'device_code',
  'user_code',
  'verification_uri',
  'expires_in',
  'interval',
  'error',
  'error_description',
  'access_token',
  'token_type',
  'scope',
  'token',
  'player',
  'message',
])
const Leaf = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Literals(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'https://github.com/login/device']),
  Schema.Array(Schema.String),
  Schema.Record(Schema.String, Schema.String),
])
const Body = Schema.Union([Schema.Record(Field, Leaf), Leaf])
const Status = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))

describe('the decoders are total', () => {
  prop.prop('any text, JSON or not, decodes to an answer and never throws', [Schema.String, Body], ([text, body]) => {
    for (const raw of [text, JSON.stringify(body)]) {
      const code = deviceCodeOf(raw)
      if (code !== null) {
        expect(code.verificationUri).toMatch(/^https:\/\/\S+$/)
        expect(Number.isFinite(code.expiresIn) && code.expiresIn >= 0).toBe(true)
        expect(Number.isFinite(code.interval) && code.interval >= 0).toBe(true)
      }
      const answer = tokenAnswerOf(raw)
      if (answer.kind === 'failed') expect(answer.error).toMatch(/^[a-z_ ]+$|^an answer that is not JSON$/i)
      if (answer.kind === 'token') expect(answer.token).not.toBe('')
    }
  })

  prop.prop('any response to a sign-in is a sign-in, refused, unavailable or unexpected', [Status, Schema.String, Body], ([status, text, body]) => {
    for (const raw of [text, JSON.stringify(body)]) {
      const signIn = signInOf({ status, ok: status >= 200 && status < 300, text: raw })
      expect(signIn.kind === 'refused').toBe(status === 401)
      expect(signIn.kind === 'unavailable').toBe([429, 502, 503, 504].includes(status))
      if (signIn.kind === 'signedIn') expect(signIn.token).toMatch(/^[!-~]+$/)
      if (signIn.kind === 'refused' && signIn.message !== null) expect(signIn.message).toMatch(/^[ -~]{0,120}$/)
      expect(pollAnswerOf({ status, text: raw }) === null).toBe(status >= 500 || status === 429)
    }
  })
})

const Answer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('token'), token: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('pending') }),
  Schema.Struct({ kind: Schema.Literal('slowDown'), interval: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 }))) }),
  Schema.Struct({ kind: Schema.Literal('expired') }),
  Schema.Struct({ kind: Schema.Literal('denied') }),
  Schema.Struct({ kind: Schema.Literal('failed'), error: Schema.String }),
])
/** A poll's answer, or none at all (GitHub down or limiting). */
const MaybeAnswer = Schema.NullOr(Answer)
const Ms = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000 }))
const Code = Schema.Struct({
  expiresIn: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
  interval: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
})
const codeOf = (code: typeof Code.Type) => ({ deviceCode: 'd', userCode: 'U', verificationUri: 'https://github.com/login/device', ...code })

const Terminal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('signedIn'), githubToken: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('expired') }),
  Schema.Struct({ kind: Schema.Literal('denied') }),
  Schema.Struct({ kind: Schema.Literal('failed'), error: Schema.String }),
])

describe('the device flow polls', () => {
  prop.prop('a done flow stays done, whatever answers and whenever', [Terminal, MaybeAnswer, Ms], ([done, answer, now]) => {
    expect(nextPoll(done, answer as TokenAnswer | null, now)).toBe(done)
  })

  prop.prop(
    'the interval only grows, and a slow_down adds at least 5 seconds',
    [Code, Ms, Schema.Array(Schema.Struct({ answer: MaybeAnswer, late: Ms }))],
    ([code, start, steps]) => {
      let poll: Poll = firstPoll(codeOf(code), start)
      let now = start
      for (const { answer, late } of steps) {
        if (poll.kind !== 'waiting') return
        now += poll.intervalMs + late
        const next = nextPoll(poll, answer as TokenAnswer | null, now)
        if (next.kind === 'waiting') {
          expect(next.intervalMs).toBeGreaterThanOrEqual(poll.intervalMs)
          expect(next.intervalMs).toBeGreaterThanOrEqual(minIntervalMs)
          if (answer?.kind === 'slowDown') expect(next.intervalMs).toBeGreaterThanOrEqual(poll.intervalMs + slowDownMs)
          expect(next.expiresAt).toBe(poll.expiresAt)
        }
        poll = next
      }
    },
  )

  prop.prop(
    'no poll is ever sent once the code has expired',
    [Code, Ms, Schema.Array(Schema.Struct({ answer: MaybeAnswer, late: Ms }))],
    ([code, start, steps]) => {
      const expiresAt = start + code.expiresIn * 1000
      let poll: Poll = firstPoll(codeOf(code), start)
      let now = start
      for (const { answer, late } of steps) {
        if (poll.kind !== 'waiting') return
        // A waiting flow's next poll comes before the code expires: the timer fires at intervalMs or later.
        expect(now + poll.intervalMs).toBeLessThan(expiresAt)
        now += poll.intervalMs
        expect(now).toBeLessThan(expiresAt)
        // The poll's answer can take its time.
        poll = nextPoll(poll, answer as TokenAnswer | null, now + late)
        now += late
      }
    },
  )

  prop.prop('a flow whose code expires before its first poll never waits', [Code, Ms], ([code, start]) => {
    const poll = firstPoll(codeOf(code), start)
    expect(poll.kind === 'waiting').toBe(Math.max(minIntervalMs, code.interval * 1000) < code.expiresIn * 1000)
  })
})

/** A target, valid or hand-made with any origin at all. */
const Origin = Schema.Union([
  Schema.Literals(['https://api.pathof.dev', 'https://play.example:8443', 'http://api.pathof.dev', 'https://a.b/path', '']),
  Schema.String,
])
const AnyTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('local'), dev: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ kind: Schema.Literal('online'), origin: Origin }),
])

describe('where a token goes', () => {
  prop.prop(
    "a GitHub token is traded only over https, at the target's own origin, and with no Authorization",
    [AnyTarget, Schema.String, Schema.String],
    ([made, githubToken, timezone]) => {
      const target = made as Target
      const asked = signInRequestOf(target, githubToken, timezone)
      expect(asked !== null).toBe(target.kind === 'online' && originOf(target.origin) === target.origin)
      if (asked === null || target.kind !== 'online') return
      const url = new URL(asked.url)
      expect(url.protocol).toBe('https:')
      expect(url.origin).toBe(target.origin)
      expect(url.pathname).toBe('/v1/auth/github')
      expect(asked.init.headers?.['authorization']).toBeUndefined()
      expect(asked.init.socketPath).toBeUndefined()
      expect(JSON.parse(asked.init.body ?? '')).toEqual({ githubToken, timezone })
    },
  )

  prop.prop('GitHub hears only the client id and the device code: no token, no scope', [Schema.String], ([deviceCode]) => {
    for (const { url, init } of [deviceCodeRequest(), accessTokenRequest(deviceCode)]) {
      expect(new URL(url).origin).toBe('https://github.com')
      expect(init.headers?.['authorization']).toBeUndefined()
      const fields = new URLSearchParams(init.body ?? '')
      expect(fields.get('client_id')).toBe(clientId)
      expect(fields.has('scope')).toBe(false)
      expect(fields.has('client_secret')).toBe(false)
      expect([...new Set(init.body?.split('&').map((field) => field.split('=')[0]))].sort()).toEqual(
        url.endsWith('/device/code') ? ['client_id'] : ['client_id', 'device_code', 'grant_type'],
      )
      // A device code GitHub gave is printable ASCII; any other string still encodes, a lone surrogate as U+FFFD.
      if (!url.endsWith('/device/code') && !/[\ud800-\udfff]/.test(deviceCode))
        expect(fields.get('device_code')).toBe(deviceCode)
    }
  })
})

describe('the command', () => {
  prop.prop('login and logout alone are asks; anything after them gets the usage', [Schema.String], ([rest]) => {
    expect(accountAskOf('login')).toEqual({ kind: 'login' })
    expect(accountAskOf(' logout ')).toEqual({ kind: 'logout' })
    const words = rest.trim()
    const ask = accountAskOf(`login ${rest}`)
    if (words === '') expect(ask).toEqual({ kind: 'login' })
    else expect(typeof ask).toBe('string')
    if (!/^(login|logout)(\s|$)/.test(rest.trim())) expect(accountAskOf(rest)).toBeNull()
  })
})
