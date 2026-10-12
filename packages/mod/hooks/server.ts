import type { CommandResponse, EventsResponse, SessionClosed, SessionResponse, StreamResponse } from '@pathofdev/schema'
import type { HttpInit, HttpResponse } from 'claude-code'

// The mod's one way to the game is HTTP over the local server's Unix socket, through the host's fetch: this file
// says what each request looks like and checks each answer. The server encodes every answer through the shared
// schemas, so the mod checks only what tells one answer from another.

export const clientVersion = '0.1.0'

/** The local server is not there: no socket, or nothing listening on it. */
export class ServerDown extends Error {}

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

/** A request to the server: a POST with a JSON body, or a GET without one, unless `method` says otherwise. */
export const initOf = (socketPath: string, body?: unknown, method?: 'DELETE'): HttpInit => ({
  method: method ?? (body === undefined ? 'GET' : 'POST'),
  socketPath,
  // `questline-client` too, for a server from before Path of Dev, which reads only that name.
  headers: { 'content-type': 'application/json', 'pathofdev-client': clientVersion, 'questline-client': clientVersion },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

/** The answer's body when the server answered as `is` expects, else an error naming the route. */
export const answerOf = <A>(path: string, response: HttpResponse, is: (value: unknown) => value is A): A => {
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  const parsed: unknown = JSON.parse(response.text)
  if (!is(parsed)) throw new Error(`${path} answered something unexpected`)
  return parsed
}

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
