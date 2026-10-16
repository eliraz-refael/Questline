import { it as prop } from '@effect/vitest'
import { DeleteRequest, exportParts, ProfileChangeRequest } from '@pathofdev/schema'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import type { ExportState, ExportStep } from '../hooks/account'
import {
  dataAskOf,
  dataUsage,
  deleteRouteOf,
  deleteTextOf,
  exportsDirOf,
  exportStart,
  exportStep,
  exportTextOf,
  keysAfterDelete,
  stampOf,
} from '../hooks/account'
import { accountAskOf } from '../hooks/login'
import { betaAskOf } from '../hooks/beta'
import { devAskOf } from '../hooks/dev'
import type { ProfileAsk } from '../hooks/profile'
import { profileAskOf, profileRouteOf, profileTextOf, profileUsage } from '../hooks/profile'
import { storeKey } from '../hooks/server'
import { serverAskOf } from '../hooks/switching'

// The account and the profile from the prompt, as properties: every parser reads any args without throwing, and no two
// read the same args; an ask said back as args reads as itself; each route carries what the server's schema takes; any
// answer reads as printable text; a delete forgets only its own server's keys; and the export, run against any answers
// at all, ends, writing complete.json last and only once every part has ended.

const origin = 'https://api.pathof.dev'

const Word = Schema.Union([
  Schema.String,
  Schema.Literals(['profile', 'public', 'private', 'hide', 'show', 'pet', 'stats', 'account', 'export', 'delete', 'Ada']),
  Schema.Literals(['beta', 'list', 'add', 'login', 'logout', 'server', 'online', 'dev', 'level']),
])
const Words = Schema.Array(Word).check(Schema.isMaxLength(5))

const Section = Schema.String.check(Schema.isPattern(/^[!-~]{1,12}$/))
const Ask = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('view') }),
  Schema.Struct({ kind: Schema.Literals(['public', 'private']) }),
  Schema.Struct({ kind: Schema.Literals(['hide', 'show']), section: Section }),
])

const Response = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  text: Schema.Union([
    Schema.String,
    Schema.Literals([
      '{"isPublic":true,"hidden":["pet\\u001b[2J"],"sections":["pet","streak","stats"],"url":"https://pathof.dev/u/ada\\u0007"}',
      '{"isPublic":false,"hidden":[],"sections":[7,null],"url":null}',
      '{"_tag":"InvalidSection","message":"That names no section to hide or show: the sections are pet, streak, stats"}',
      '{"deleted":true,"onBetaList":true}',
      '{"_tag":"ConfirmMismatch","message":"That isn\'t this account\'s GitHub login\\u001b"}',
    ]),
  ]),
})
const answerOf = (response: typeof Response.Type) => ({ ...response, ok: response.status >= 200 && response.status < 300 })

const isPrintable = (text: string) => /^[\n -~]+$/.test(text)

/** An ask as the player would type it. */
const said = (ask: ProfileAsk): string => ['profile', ...(ask.kind === 'view' ? [] : [ask.kind]), ...('section' in ask ? [ask.section] : [])].join(' ')

describe('the /pathofdev parsers', () => {
  prop.prop('read any args without throwing, and no two read the same args', [Words], ([words]) => {
    const args = words.join(' ')
    const read = [accountAskOf(args), betaAskOf(args), profileAskOf(args), dataAskOf(args), serverAskOf(args), devAskOf(args)]
    expect(read.filter((one) => one !== null).length).toBeLessThanOrEqual(1)
  })
})

describe('/pathofdev profile', () => {
  prop.prop('reads an ask said back as args as itself', [Ask], ([ask]) => {
    expect(profileAskOf(`  ${said(ask as ProfileAsk)} `)).toEqual(ask)
  })

  prop.prop('reads any profile args as an ask or the usage', [Words], ([words]) => {
    const read = profileAskOf(['profile', ...words].join(' '))
    expect(read).not.toBeNull()
    if (typeof read === 'string') expect(read).toBe(profileUsage)
  })

  prop.prop("sends a change the server's schema takes, and a look with no body", [Ask], ([ask]) => {
    const route = profileRouteOf(ask as ProfileAsk)
    expect(route.path).toBe('/v1/account/profile')
    if (ask.kind === 'view') expect(route.body).toBeUndefined()
    else expect(Schema.decodeUnknownSync(ProfileChangeRequest)(route.body)).toEqual(ask)
  })

  prop.prop('reads any answer into printable text', [Ask, Schema.NullOr(Response)], ([ask, response]) => {
    const text = profileTextOf(ask as ProfileAsk, response === null ? null : answerOf(response), origin)
    expect(isPrintable(text)).toBe(true)
  })
})

describe('/pathofdev account', () => {
  const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,20}$/))

  prop.prop('reads an ask said back as args as itself', [Schema.NullOr(Login)], ([login]) => {
    expect(dataAskOf('account export')).toEqual({ kind: 'export' })
    expect(dataAskOf(`account delete ${login ?? ''}`)).toEqual({ kind: 'delete', login })
  })

  prop.prop('reads any account args as an ask or the usage', [Words], ([words]) => {
    const read = dataAskOf(['account', ...words].join(' '))
    expect(read).not.toBeNull()
    if (typeof read === 'string') expect(read).toBe(dataUsage)
    else if (read.kind === 'delete' && read.login !== null) expect(read.login).toMatch(/^\S+$/)
  })

  prop.prop("sends a delete the server's schema takes, with the login as typed", [Login], ([login]) => {
    const route = deleteRouteOf(login)
    expect(route.method).toBeUndefined()
    expect(Schema.decodeUnknownSync(DeleteRequest)(route.body)).toEqual({ login })
  })

  prop.prop('reads any delete answer into printable text, unsure on none or a 5xx', [Schema.NullOr(Response)], ([response]) => {
    const text = deleteTextOf(response === null ? null : answerOf(response), origin)
    expect(isPrintable(text)).toBe(true)
    if (response === null || response.status >= 500) expect(text).toContain("didn't say whether")
  })

  prop.prop("forgets only its own server's keys: the token, the queue and the explored repos", [Login, Login], ([one, other]) => {
    const target = { kind: 'online', origin: `https://${one.toLowerCase()}.test` } as const
    const keys = keysAfterDelete(target.origin)
    expect(keys).toEqual(['token', 'queue', 'explored'].map((name) => storeKey(target, name)))
    if (one.toLowerCase() !== other.toLowerCase()) {
      for (const key of keysAfterDelete(`https://${other.toLowerCase()}.test`)) expect(keys).not.toContain(key)
    }
    // The player's own local save keeps its keys.
    for (const key of keys) expect(['token', 'queue', 'explored']).not.toContain(key)
  })

  prop.prop('exports under the server home or ~/.pathofdev, never the working directory', [Schema.UndefinedOr(Schema.String), Schema.UndefinedOr(Schema.String)], ([named, home]) => {
    const dir = exportsDirOf(named, home)
    if (named) expect(dir).toBe(`${named}/exports`)
    else if (home) expect(dir).toBe(`${home}/.pathofdev/exports`)
    else expect(dir).toBeNull()
  })

  prop.prop('names a folder with the time, in characters any file system takes', [Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4e12 }))], ([ms]) => {
    expect(stampOf(ms)).toMatch(/^[0-9]{4,6}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$/)
  })
})

// ── the export ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A server that keeps its word: a head of some parts, and each part's rows, paged as it likes. */
const Honest = Schema.Array(
  Schema.Struct({
    rows: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    perPage: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    isBounded: Schema.Boolean,
  }),
).check(Schema.isMaxLength(5))

const ok = (body: unknown) => ({ status: 200, ok: true, text: JSON.stringify(body) })

/** Runs an export to its end against `answer`, which answers each ask; at most `limit` asks. */
const runExport = (answer: (ask: string, i: number) => { status: number; ok: boolean; text: string } | null, limit = 400) => {
  let step: ExportStep = exportStart('/home/player/.pathofdev/exports', '2026-10-16T10-00-00Z')
  const writes: Array<string> = []
  const asks: Array<string> = []
  while (step.ask !== null && asks.length < limit) {
    asks.push(step.ask.path)
    step = exportStep(step.state, answer(step.ask.path, asks.length - 1), origin)
    writes.push(...step.writes.map((write) => write.path.split('/').at(-1)!))
  }
  return { state: step.state, writes, asks, isEnded: step.ask === null }
}

const honestAnswer = (parts: typeof Honest.Type) => {
  const names = exportParts.slice(0, parts.length)
  const head = {
    format: 1,
    player: { github_login: 'Ada' },
    parts: parts.map((part, i) => ({ part: names[i], rows: part.rows, upto: part.isBounded ? 99 : null })),
  }
  return (path: string) => {
    if (path === '/v1/account/export') return ok(head)
    const url = new URL(`https://x${path}`)
    const i = names.indexOf(url.pathname.split('/').at(-1) as (typeof exportParts)[number])
    const part = parts[i]!
    const after = Number(url.searchParams.get('after') ?? '0')
    const rows = Array.from({ length: Math.min(part.perPage, part.rows - after) }, (_, k) => ({ n: after + k + 1 }))
    const end = after + rows.length
    return ok({ rows, next: end < part.rows ? String(end) : null })
  }
}

describe('the export', () => {
  prop.prop('against a server that keeps its word, writes the head, every page in order, then complete.json', [Honest], ([parts]) => {
    const run = runExport(honestAnswer(parts))
    expect(run.isEnded).toBe(true)
    expect(run.state.kind).toBe('done')
    if (run.state.kind === 'done') expect(run.state.short).toEqual([])
    expect(run.writes[0]).toBe('head.json')
    expect(run.writes.at(-1)).toBe('complete.json')
    const names = exportParts.slice(0, parts.length)
    const expected = parts.flatMap((part, i) =>
      Array.from({ length: Math.max(1, Math.ceil(part.rows / part.perPage)) }, (_, page) => `${names[i]}-${String(page + 1).padStart(4, '0')}.json`))
    expect(run.writes.slice(1, -1)).toEqual(expected)
    expect(run.state.kind === 'done' && run.state.dir).toBe('/home/player/.pathofdev/exports/Ada-2026-10-16T10-00-00Z')
  })

  prop.prop('stopped by any failure on the way writes no complete.json, and says where the rest is', [Honest, Schema.Int, Schema.NullOr(Response)], ([parts, at, failure]) => {
    const honest = honestAnswer(parts)
    const total = runExport(honest).asks.length
    const stopAt = Math.abs(at) % total
    const broken = failure === null ? null : answerOf(failure)
    // A failure that happens to be a good answer is no failure.
    if (broken !== null && broken.ok) return
    const run = runExport((path, i) => (i === stopAt ? broken : honest(path)))
    expect(run.state.kind).toBe('failed')
    expect(run.writes).not.toContain('complete.json')
    expect(isPrintable(exportTextOf(run.state))).toBe(true)
    if (stopAt > 0) expect(exportTextOf(run.state)).toContain('/home/player/.pathofdev/exports/Ada-')
  })

  const Chaos = Schema.Array(
    Schema.Union([
      Schema.Null,
      Response,
      Schema.Literals(['head', 'page', 'last', 'empty', 'endless']),
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(30))

  prop.prop('ends against any answers at all, writing complete.json only last and only when done', [Chaos], ([answers]) => {
    const run = runExport((_, i) => {
      const answer = answers[i % answers.length]!
      if (answer === null) return null
      if (typeof answer !== 'string') return answerOf(answer)
      switch (answer) {
        case 'head':
          return ok({ player: {}, parts: [{ part: 'events', rows: 2, upto: 5 }, { part: 'sessions', rows: 1, upto: null }] })
        case 'page':
          return ok({ rows: [{}], next: 'k' })
        case 'last':
          return ok({ rows: [{}], next: null })
        case 'empty':
          return ok({ rows: [], next: 'k' })
        case 'endless':
          return ok({ rows: [{}, {}], next: 'again' })
      }
    })
    expect(run.isEnded).toBe(true)
    expect(['done', 'failed']).toContain(run.state.kind)
    expect(run.writes.filter((write) => write === 'complete.json').length).toBe(run.state.kind === 'done' ? 1 : 0)
    if (run.state.kind === 'done') expect(run.writes.at(-1)).toBe('complete.json')
    // A done or failed export stays as it is, whatever comes after.
    const after = exportStep(run.state as ExportState, ok({ rows: [], next: null }), origin)
    expect(after).toEqual({ state: run.state, writes: [], ask: null })
  })
})
