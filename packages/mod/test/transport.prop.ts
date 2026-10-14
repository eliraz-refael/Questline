import { it as prop } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { checkoutRef, commitRef, repoIn, repoOf, repoRef, subjectFormOf, workRef } from '../hooks/observe'
import type { Target } from '../hooks/server'
import {
  answerOf,
  failureOf,
  idOf,
  isEvents,
  originOf,
  publicOrigin,
  queueAfter,
  requestOf,
  ServerDown,
  settledBy,
  SignedOut,
  storeKey,
  targetOf,
} from '../hooks/server'

// The mod's transport, as properties: where a target sends, what rides with it, and what a failed answer leaves in
// the queue. Hosts and URLs are built from parts, so the cases mix valid https origins with near misses.

const chars = (alphabet: string, min: number, max: number) =>
  Schema.Array(Schema.Literals([...alphabet])).check(Schema.isMinLength(min), Schema.isMaxLength(max))

const Url = Schema.Struct({
  scheme: Schema.Literals(['https://', 'HTTPS://', 'http://', 'ftp://', '']),
  credentials: Schema.Literals(['', '', '', 'user:pw@']),
  host: Schema.Array(chars('abcXYZ019-', 1, 8)).check(Schema.isMinLength(0), Schema.isMaxLength(3)),
  port: Schema.Literals(['', '', ':443', ':8080', ':']),
  rest: Schema.Literals(['', '', '/', '/v1', '?q=1', '#x', '/a/b', ' ']),
})
const urlOf = (url: typeof Url.Type): string =>
  `${url.scheme}${url.credentials}${url.host.map((label) => label.join('')).join('.')}${url.port}${url.rest}`

/** Any value an option may hold. */
const Option = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null, Schema.Undefined])
const Server = Schema.Union([Schema.Literals(['default', 'dev', 'online']), Option])

/** A target, valid or hand-made with any origin at all. */
const AnyTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('local') }),
  Schema.Struct({ kind: Schema.Literal('online'), origin: Schema.Union([Url, Schema.String]) }),
])
const targetFrom = (target: typeof AnyTarget.Type): Target =>
  target.kind === 'local'
    ? { kind: 'local' }
    : { kind: 'online', origin: typeof target.origin === 'string' ? target.origin : urlOf(target.origin) }

const Token = Schema.NullOr(Schema.String)
const Path = Schema.String

describe('targets', () => {
  prop.prop('every pair of options is a target, online only at an https origin', [Server, Schema.Union([Url, Option])], ([server, url]) => {
    const target = targetOf({ server, serverUrl: typeof url === 'object' && url !== null ? urlOf(url) : url } as never)
    expect(target.kind).toBe(server === 'online' ? 'online' : 'local')
    if (target.kind === 'online') {
      expect(originOf(target.origin)).toBe(target.origin)
      expect(new URL(target.origin).origin).toBe(target.origin)
    }
  })

  prop.prop('an origin is a fixed point: https, a host, maybe a port, and nothing else', [Url], ([parts]) => {
    const origin = originOf(urlOf(parts))
    if (origin === null) return
    expect(originOf(origin)).toBe(origin)
    expect(new URL(origin).origin).toBe(origin)
  })

  prop.prop('a URL the option names is kept, and one that names no origin plays on the public server', [Url], ([parts]) => {
    const url = urlOf(parts)
    const target = targetOf({ server: 'online', serverUrl: url })
    expect(target).toEqual({ kind: 'online', origin: originOf(url) ?? publicOrigin })
  })
})

describe('requests', () => {
  prop.prop(
    'a token rides only to an https origin, and only to its own',
    [AnyTarget, Schema.String, Token, Path],
    ([made, socketPath, token, rest]) => {
      const target = targetFrom(made)
      const { url, init } = requestOf(target, { path: `/${rest}` }, { socketPath, token })
      const authorization = init.headers?.['authorization']
      if (authorization === undefined) return
      expect(target.kind).toBe('online')
      if (target.kind !== 'online') return
      expect(originOf(target.origin)).toBe(target.origin)
      expect(new URL(url).origin).toBe(target.origin)
      expect(new URL(url).protocol).toBe('https:')
      expect(authorization).toBe(`Bearer ${token}`)
      expect(init.socketPath).toBeUndefined()
    },
  )

  prop.prop('a local request goes over the socket with no token, whatever token there is', [Schema.String, Token, Path], ([socketPath, token, rest]) => {
    const { url, init } = requestOf({ kind: 'local' }, { path: `/${rest}` }, { socketPath, token })
    expect(init.headers?.['authorization']).toBeUndefined()
    expect(init.socketPath).toBe(socketPath)
    expect(url).toBe(`http://pathofdev/${rest}`)
  })

  prop.prop('an online request carries the token it was given', [Url, Schema.String, Path], ([parts, token, rest]) => {
    const origin = originOf(urlOf(parts))
    if (origin === null) return
    const { init } = requestOf({ kind: 'online', origin }, { path: `/${rest}` }, { socketPath: '', token })
    expect(init.headers?.['authorization']).toBe(`Bearer ${token}`)
  })
})

describe('store keys', () => {
  const Name = Schema.Literals(['queue', 'explored', 'token'])
  const ValidTarget = Schema.Union([Schema.Struct({ kind: Schema.Literal('local'), dev: Schema.Boolean }), Url])
  const valid = (target: typeof ValidTarget.Type): Target => {
    if ('kind' in target) return target.dev ? { kind: 'local', dev: true } : { kind: 'local' }
    return { kind: 'online', origin: originOf(urlOf(target)) ?? publicOrigin }
  }

  prop.prop('a local server keeps the keys from before targets', [Name], ([name]) => {
    expect(storeKey({ kind: 'local' }, name)).toBe(name)
  })

  prop.prop('no two targets or names share a key', [ValidTarget, Name, ValidTarget, Name], ([a, first, b, second]) => {
    const [one, two] = [valid(a), valid(b)]
    expect(storeKey(one, first) === storeKey(two, second)).toBe(
      first === second && JSON.stringify(one) === JSON.stringify(two),
    )
  })
})

describe('answers and the queue', () => {
  const Status = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
  const response = (status: number, text: string) => ({ status, ok: status >= 200 && status < 300, headers: {}, text })

  prop.prop('a failure is named for every status but a 2xx', [Status], ([status]) => {
    const failure = failureOf(response(status, ''))
    expect(failure === null).toBe(status >= 200 && status < 300)
    expect(failure === 'signedOut').toBe(status === 401)
    expect(failure === 'unavailable').toBe([429, 502, 503, 504].includes(status))
  })

  prop.prop('a 401 settles nothing, whatever its body: the mod is signed out and keeps every event', [Schema.String], ([text]) => {
    expect(() => answerOf('/v1/events', response(401, text), isEvents)).toThrow(SignedOut)
    expect(new SignedOut()).toBeInstanceOf(ServerDown)
  })

  prop.prop('no failed answer settles anything', [Status, Schema.String], ([status, text]) => {
    if (status >= 200 && status < 300) return
    expect(() => answerOf('/v1/events', response(status, text), isEvents)).toThrow()
  })

  const Queue = Schema.Array(Schema.Struct({ id: Schema.String, n: Schema.Number }))
  const Results = Schema.Array(
    Schema.Struct({ pick: Schema.Int, other: Schema.String, reason: Schema.Literals(['unknown_type', 'stale', 'none']) }),
  )

  prop.prop(
    'an answer takes out exactly the events it settled, and the rest stay in order',
    [Queue, Results],
    ([queue, picks]) => {
      const ids = queue.map((event) => event.id)
      const results = picks.map(({ pick, other, reason }) => ({
        id: ids.length > 0 && pick % 2 === 0 ? ids[Math.abs(pick) % ids.length]! : other,
        ...(reason === 'none' ? {} : { reason }),
      }))
      const settled = settledBy({ results } as never)
      const after = queueAfter(queue, settled)
      expect(after).toEqual(queue.filter((event) => !settled.has(event.id)))
      expect(queueAfter(after, settled)).toEqual(after)
      expect(after.every((event) => !settled.has(idOf(event) ?? ''))).toBe(true)
      // An event answered only as a type the server doesn't know waits for a newer server.
      const unknownOnly = (id: string) => results.every((result) => result.id !== id || result.reason === 'unknown_type')
      for (const event of queue) if (unknownOnly(event.id)) expect(after).toContainEqual(event)
    },
  )
})

describe('subjects online', () => {
  const Remote = Schema.Struct({
    prefix: Schema.Literals(['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']),
    owner: chars('abcXYZ019', 1, 12),
    name: chars('abcXYZ019._-', 1, 12),
    suffix: Schema.Literals(['', '.git', '/']),
  })
  const Fields = Schema.Struct({ sha: chars('0123456789abcdef', 40, 40), number: Schema.Int, branch: Schema.NullOr(Schema.String) })
  const secret = 'a'.repeat(64)
  const opaque = /^[0-9a-f]{64}$/

  prop.effect.prop('carry only opaque keys, never the repo, a sha, a number or a branch', [Remote, Fields], ([remote, fields]) =>
    Effect.promise(async () => {
      const name = `${remote.owner.join('')}/${remote.name.join('')}`
      const local = repoOf(`${remote.prefix}${name}${remote.suffix}`, '/work')
      // A name the GitHub pattern takes: the case the online form exists for.
      if (local.kind !== 'github') return
      const online = repoIn(subjectFormOf({ kind: 'online', origin: publicOrigin }), local)
      const refs = [
        await repoRef(secret, online),
        await commitRef(secret, online, fields.sha.join('')),
        await workRef(secret, online, fields.number),
        await checkoutRef(secret, online, fields.branch),
      ]
      for (const ref of refs) {
        expect(Object.keys(ref).sort()).toEqual(['key', 'repo', 'type'])
        expect(ref.type).toBe('private')
        expect(ref.repo).toMatch(opaque)
        expect(ref.key).toMatch(opaque)
        expect(JSON.stringify(ref)).not.toContain(local.name)
      }
      // A local server is the player's own, so it still hears the repo's name.
      expect(await repoRef(secret, repoIn(subjectFormOf({ kind: 'local' }), local))).toMatchObject({ type: 'github', repo: local.name })
    }),
  )
})
