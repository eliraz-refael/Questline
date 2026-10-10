import type { CommandResponse, EventsResponse, SessionResponse, StreamResponse } from '@questline/schema'
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

/** The URL a route is fetched at: the host name is a placeholder, since the socket picks the server. */
export const urlOf = (path: string): string => `http://questline${path}`

/** A request to the server: a POST with a JSON body, or a GET without one. */
export const initOf = (socketPath: string, body?: unknown): HttpInit => ({
  method: body === undefined ? 'GET' : 'POST',
  socketPath,
  headers: { 'content-type': 'application/json', 'questline-client': clientVersion },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

/** The answer's body when the server answered as `is` expects, else an error naming the route. */
export const answerOf = <A>(path: string, response: HttpResponse, is: (value: unknown) => value is A): A => {
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  const parsed: unknown = JSON.parse(response.text)
  if (!is(parsed)) throw new Error(`${path} answered something unexpected`)
  return parsed
}

/** The socket's path under the Questline home, given the two variables that decide it. */
export const socketPathOf = (questlineHome: string | undefined, home: string | undefined): string =>
  `${questlineHome || `${home ?? ''}/.questline`}/server.sock`
