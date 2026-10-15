import { it as prop } from '@effect/vitest'
import { isGithubLogin as isServerLogin } from '@pathofdev/schema'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import type { BetaAsk } from '../hooks/beta'
import { betaAskOf, betaRouteOf, betaTextOf, betaUsage, isGithubLogin, onlyAdmins } from '../hooks/beta'

// The beta list from the prompt, as properties: the mod reads any args without throwing, names a login only when it is
// one (the server's own rule, so nothing it would turn down for its spelling ever leaves), sends it on a route that
// carries it whole, and reads any answer at all into a printable line.

const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8}){0,3}$/))
const Words = Schema.Array(Schema.Union([Schema.String, Login, Schema.Literals(['beta', 'list', 'add', 'remove'])]))

const Ask = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('list') }),
  Schema.Struct({ kind: Schema.Literals(['add', 'remove']), login: Login }),
])

const Response = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  text: Schema.Union([
    Schema.String,
    Schema.Literals([
      '{"entries":[{"source":"added","login":"a\\u0007b","addedAt":"2026-10-09T08:00:00.000Z","addedBy":7}]}',
      '{"login":"ada","changed":true,"message":"ada is on the beta list now\\u001b[31m"}',
      '{"_tag":"Forbidden","message":"no"}',
      '{"_tag":"InvalidLogin","message":"That is not a GitHub login"}',
    ]),
  ]),
})

const origin = 'https://api.pathof.dev'

describe('/pathofdev beta', () => {
  prop.prop("spells a GitHub login exactly as the server does", [Schema.String], ([text]) => {
    expect(isGithubLogin(text)).toBe(isServerLogin(text))
  })

  prop.prop('reads any args without throwing: an ask, a line to show, or not the beta at all', [Words], ([words]) => {
    const args = words.join(' ')
    const ask = betaAskOf(args)
    if (args.trim().split(/\s+/)[0] !== 'beta') expect(ask).toBeNull()
    else if (typeof ask === 'string') expect(ask).toContain(betaUsage)
    else if (ask !== null && ask.kind !== 'list') expect(isGithubLogin(ask.login)).toBe(true)
  })

  prop.prop('asks for a login the player names, in the case they typed it', [Schema.Literals(['add', 'remove']), Login], ([kind, login]) => {
    expect(betaAskOf(`  beta ${kind}   ${login} `)).toEqual({ kind, login })
  })

  prop.prop('sends a login on a route that carries it whole', [Ask], ([ask]) => {
    const route = betaRouteOf(ask as BetaAsk)
    if (ask.kind === 'list') expect(route).toEqual({ path: '/v1/beta' })
    if (ask.kind === 'add') expect(route).toEqual({ path: '/v1/beta', body: { login: ask.login } })
    if (ask.kind === 'remove') {
      expect(route.method).toBe('DELETE')
      expect(decodeURIComponent(route.path.slice('/v1/beta/'.length))).toBe(ask.login)
      expect(route.path.split('/')).toHaveLength(4)
    }
  })

  prop.prop('reads any answer into printable text, and a 403 as for admins only', [Ask, Schema.NullOr(Response)], ([ask, response]) => {
    const text = betaTextOf(ask as BetaAsk, response === null ? null : { ...response, ok: response.status < 300 }, origin)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/^[\n -~]*$/)
    if (response?.status === 403) expect(text).toBe(onlyAdmins)
  })
})
