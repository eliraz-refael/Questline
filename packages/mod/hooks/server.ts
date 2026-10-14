import type { CommandResponse, EventsResponse, SessionClosed, SessionResponse, StreamResponse } from '@pathofdev/schema'
import type { HttpInit, HttpResponse, PluginOptions } from 'claude-code'

// The mod's one way to the game is HTTP through the host's fetch: to a local server over its Unix socket, or to the
// public server over https. This file says what each request looks like and checks each answer. The server encodes
// every answer through the shared schemas, so the mod checks only what tells one answer from another.
//
//   server option ── default | dev ──▶ local  ── http://pathofdev/… over the socket ─┐   (no token, ever)
//                 └─ online + url ──▶ online ── https://<origin>/… + Bearer token ───┤   (token only to that origin)
//                                                                                     ▼
//              answer ── 2xx ───────────────────────▶ checked against the route's shape, settles what it answered
//                     ├─ 401 ───────────────────────▶ SignedOut   ─┐
//                     ├─ 429 / 502 / 503 / 504 ─────▶ ServerDown  ─┼─▶ band offline; the queue keeps every event
//                     ├─ no answer (no socket, net) ─▶ ServerDown  ─┘
//                     └─ anything else ─────────────▶ Error: "answered something unexpected"; the queue keeps it too

export const clientVersion = '0.1.0'

/** The server can't be reached, or can't take the request now: the band shows it offline, and what waits stays. */
export class ServerDown extends Error {}

/** The online server wants a sign-in: its token is missing, revoked, or no longer in the beta. */
export class SignedOut extends ServerDown {}

/**
 * Where the mod plays: a local server over its Unix socket (the player's own save, or with `dev` the dev sandbox), or
 * the public server at an https origin.
 */
export type Target =
  | { readonly kind: 'local'; readonly dev?: true }
  | { readonly kind: 'online'; readonly origin: string }

/** The public server, when the `serverUrl` option names none. */
export const publicOrigin = 'https://api.pathof.dev'

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
// The last label starts with a letter, so no URL parser reads the host as an IPv4 address.
const httpsOrigin = new RegExp(`^https://((?:${label}\\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([0-9]{1,5}))?/?$`, 'i')

/**
 * The https origin a URL names, as a URL parser writes it (the host lower-cased, no default port, no trailing
 * slash), or null for anything else: plain http, credentials, a path, a query, a fragment or an address.
 */
export const originOf = (url: string): string | null => {
  const match = httpsOrigin.exec(url.trim())
  if (match === null) return null
  const port = match[2] === undefined ? 443 : Number(match[2])
  if (port < 1 || port > 65_535) return null
  return `https://${(match[1] ?? '').toLowerCase()}${port === 443 ? '' : `:${port}`}`
}

/**
 * The `server` and `serverUrl` options as a target: online at the URL's https origin, or the public server's when the
 * URL names none; any other server is a local one.
 */
export const targetOf = (options: PluginOptions): Target => {
  const url = options['serverUrl']
  return options['server'] === 'online'
    ? { kind: 'online', origin: (typeof url === 'string' ? originOf(url) : null) ?? publicOrigin }
    : options['server'] === 'dev'
      ? { kind: 'local', dev: true }
      : { kind: 'local' }
}

/**
 * The store key of `name` for a target: the player's own local save keeps the name itself, as before there were
 * targets; the dev sandbox and each online origin have their own, so nothing queued for one server is ever sent to
 * another.
 */
export const storeKey = (target: Target, name: string): string =>
  target.kind === 'online' ? `${name}@${target.origin}` : target.dev === true ? `${name}@dev` : name

/** The player's game token as the store holds it, or null when there is none. */
export const tokenOf = (stored: unknown): string | null => (typeof stored === 'string' && stored !== '' ? stored : null)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const isSession = (value: unknown): value is SessionResponse =>
  isRecord(value) && isRecord(value['snapshot']) && typeof value['snapshot']['cursor'] === 'number'
export const isEvents = (value: unknown): value is EventsResponse => isRecord(value) && Array.isArray(value['results'])
export const isStream = (value: unknown): value is StreamResponse =>
  isRecord(value) && Array.isArray(value['events']) && typeof value['cursor'] === 'number'
export const isCommand = (value: unknown): value is CommandResponse =>
  isRecord(value) && (value['status'] === 'ok' || value['status'] === 'refused')
export const isClosed = (value: unknown): value is SessionClosed =>
  isRecord(value) && typeof value['closed'] === 'boolean'

/** The stream after `after`, naming the session, so each poll keeps it live on a server that tracks presence. */
export const streamPathOf = (after: number, sessionId: string): string =>
  `/v1/stream?after=${after}&session=${encodeURIComponent(sessionId)}`

/** The URL a route is fetched at: the host name is a placeholder, since the socket picks the server. */
export const urlOf = (path: string): string => `http://pathofdev${path}`

/**
 * The headers of a request to a target: the client's version, and the player's token only to an online target, whose
 * origin is https, so the token never rides plain http or a local socket.
 */
export const headersOf = (target: Target, token: string | null): Record<string, string> => ({
  'content-type': 'application/json',
  'pathofdev-client': clientVersion,
  // `questline-client` too, for a server from before Path of Dev, which reads only that name.
  'questline-client': clientVersion,
  ...(target.kind === 'online' && token !== null && originOf(target.origin) === target.origin
    ? { authorization: `Bearer ${token}` }
    : {}),
})

/** A route of the server: a POST with a JSON body, or a GET without one, unless `method` says otherwise. */
export interface Route {
  readonly path: string
  readonly body?: unknown
  readonly method?: 'DELETE'
}

const sent = (body: unknown, method: 'DELETE' | undefined) => ({
  method: method ?? (body === undefined ? 'GET' : 'POST'),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

/** A request to a local server over `socketPath`. */
export const initOf = (socketPath: string, body?: unknown, method?: 'DELETE'): HttpInit => ({
  ...sent(body, method),
  socketPath,
  headers: headersOf({ kind: 'local' }, null),
})

/** One request to a target: to a local server over `socketPath`, or to the online origin with the player's token. */
export const requestOf = (
  target: Target,
  route: Route,
  via: { readonly socketPath: string; readonly token: string | null },
): { readonly url: string; readonly init: HttpInit } =>
  target.kind === 'local'
    ? { url: urlOf(route.path), init: initOf(via.socketPath, route.body, route.method) }
    : { url: `${target.origin}${route.path}`, init: { ...sent(route.body, route.method), headers: headersOf(target, via.token) } }

/**
 * Why an answer is no answer: the player is signed out, the server can't take it now (busy, deploying, or a gateway
 * that lost it), or something else went wrong. Null for a 2xx.
 */
export type Failure = 'signedOut' | 'unavailable' | 'unexpected'

export const failureOf = (response: Pick<HttpResponse, 'ok' | 'status'>): Failure | null =>
  response.ok
    ? null
    : response.status === 401
      ? 'signedOut'
      : [429, 502, 503, 504].includes(response.status)
        ? 'unavailable'
        : 'unexpected'

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The answer's body when the server answered as `is` expects, else the failure, naming the route. */
export const answerOf = <A>(path: string, response: HttpResponse, is: (value: unknown) => value is A): A => {
  const failure = failureOf(response)
  if (failure === 'signedOut') throw new SignedOut(`${path} answered 401: sign in again`)
  if (failure === 'unavailable') throw new ServerDown(`${path} answered ${response.status}`)
  if (failure === 'unexpected') throw new Error(`${path} answered ${response.status}`)
  const body = parsed(response.text)
  if (!is(body)) throw new Error(`${path} answered something unexpected`)
  return body
}

/** An event's id, or null for anything that isn't an event. */
export const idOf = (event: unknown): string | null =>
  typeof event === 'object' && event !== null && 'id' in event && typeof event.id === 'string' ? event.id : null

/**
 * The events an answer to a batch settles: each one it answered, but one of a type the server doesn't know yet,
 * which waits for a newer server.
 */
export const settledBy = (answer: EventsResponse): ReadonlySet<string> =>
  new Set(answer.results.filter((result) => result.reason !== 'unknown_type').map((result) => result.id))

/** The queue once the settled events leave it: the rest stay, in order. */
export const queueAfter = (queue: ReadonlyArray<unknown>, settled: ReadonlySet<string>): Array<unknown> =>
  queue.filter((event) => !settled.has(idOf(event) ?? ''))

/**
 * Where the server's socket may be, as the server picks its home: under `named` (`PATHOFDEV_HOME`, or
 * `QUESTLINE_HOME` from before Path of Dev) when set, else `~/.pathofdev` (`~/.pathofdev-dev` for the dev server),
 * then `~/.questline` (`~/.questline-dev`), where a server from before Path of Dev listens until it restarts and moves
 * its save.
 */
export const socketPathsOf = (named: string | undefined, home: string | undefined, isDev = false): Array<string> =>
  named
    ? [`${named}/server.sock`]
    : [isDev ? '.pathofdev-dev' : '.pathofdev', isDev ? '.questline-dev' : '.questline'].map(
        (folder) => `${home ?? ''}/${folder}/server.sock`,
      )
