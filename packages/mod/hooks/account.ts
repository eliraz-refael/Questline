import type { HttpResponse } from 'claude-code'
import type { Route } from './server'
import { argsOf, commonTextOf, isRecord, messageOf, parsed, printable } from './server'

// The player's account on the online server, from the prompt: `/pathofdev account export` writes everything the server
// keeps of them to files, and `/pathofdev account delete <login>` deletes it all. This file holds the pure half: what
// each ask is, the export as a state machine the mod only runs, and what a delete leaves the mod to forget.
//
// The export: the head, then each part a page at a time, each answer a file under the exports folder (never the
// session's working directory, which is often a repo). complete.json comes last, once every part has ended; an export
// it is missing from stopped part way.
//
//   start ─▶ GET /v1/account/export ──▶ head? ─ no ───────────────────────────────▶ failed (nothing written)
//                                        └─ yes ─▶ write head.json
//   ┌──▶ part i ─▶ GET /v1/account/export/<part>?after&upto ─▶ page? ─ no ────────▶ failed (what is written stays)
//   │                                                          └─ yes ─▶ write <part>-NNNN.json
//   │        next ≠ null (and a row, and pages left) ─▶ the same part, after next ─┐
//   └─────── next = null ─▶ part i + 1 ◀────────────────────────────────────────────┘
//            no part left ─▶ write complete.json ─▶ done
//
// The delete: the server checks the login against the account's (the mod keeps no login). Once it answers 2xx, the mod
// forgets the token, the queue and the explored repos it kept for that server; a 401 says the token is dead, which it
// forgets alone; with no answer, or a 5xx that may have come after the commit, it keeps them all.

/** What `/pathofdev account …` asks: an export, or a delete with the login the player typed, if any. */
export type DataAsk = { readonly kind: 'export' } | { readonly kind: 'delete'; readonly login: string | null }

export const dataUsage =
  'Your account, on the online server: /pathofdev account export | delete <your-github-login>.'

/** What `/pathofdev <args>` asks of the account: null when the args are not `account …`, the usage when they don't parse. */
export const dataAskOf = (args: string): DataAsk | string | null => {
  const [head, what, login, ...rest] = argsOf(args)
  if (head !== 'account') return null
  if (rest.length > 0) return dataUsage
  if (what === 'export') return login === undefined ? { kind: 'export' } : dataUsage
  if (what === 'delete') return { kind: 'delete', login: login ?? null }
  return dataUsage
}

/** What a delete with no login says, and sends nothing for. */
export const deleteWarning =
  'This deletes your account on the online server for good: your character, pet, items and history. Export it ' +
  'first with /pathofdev account export. To go on, type /pathofdev account delete <your-github-login>.'

/** The route a delete is sent on: a POST, as it carries the login. */
export const deleteRouteOf = (login: string): Route => ({ path: '/v1/account/delete', body: { login } })

/** The keys the mod keeps for an online origin that a delete leaves nothing behind for. */
export const keysAfterDelete = (origin: string): ReadonlyArray<string> =>
  ['token', 'queue', 'explored'].map((name) => `${name}@${origin}`)

/** What the server made of a delete; `response` null: no answer at all, so it may have gone through. */
export const deleteTextOf = (response: Pick<HttpResponse, 'ok' | 'status' | 'text'> | null, origin: string): string => {
  // A gateway's 502 or 504 may come after the delete committed: only a 4xx says for sure that nothing was deleted.
  if (response === null || response.status >= 500) {
    return `The server at ${origin} didn't say whether the account was deleted: run it again, or sign in to check.`
  }
  if (response.status === 401) {
    return `You're not signed in to ${origin}, so nothing was deleted now. If an earlier delete went through, the ` +
      'account is gone; /pathofdev login signs you in to check.'
  }
  const common = commonTextOf(response, origin)
  if (common !== null) return common
  if (response.status === 400) {
    const message = messageOf(response.text, 200)
    return message === '' ? `The server turned the delete down: ${dataUsage}` : `${message}.`
  }
  const body = parsed(response.text)
  if (!response.ok || !isRecord(body) || body['deleted'] !== true) {
    return `The Path of Dev server at ${origin} answered the delete with ${response.status}.`
  }
  const again = body['onBetaList'] === true
    ? ' /pathofdev login starts a new one, if you like.'
    : ' The beta no longer lets this GitHub account in.'
  return `Your account on ${origin} is deleted, and this mod is signed out of it.${again}`
}

// ── the export ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The most a file may hold: the host's write takes 4 MiB. */
const maxFileBytes = 4 * 1024 * 1024

/** One part as the head lists it. */
interface PartHead {
  readonly part: string
  readonly rows: number
  readonly upto: number | null
}

/** Where an export stands. */
export type ExportState =
  | { readonly kind: 'head'; readonly base: string; readonly stamp: string }
  | {
    readonly kind: 'parts'
    readonly dir: string
    readonly parts: ReadonlyArray<PartHead>
    /** The part being read, its pages so far, and the cursor its next page starts after. */
    readonly at: number
    readonly pages: number
    readonly after: string | null
    /** The rows each part sent, by part. */
    readonly got: Readonly<Record<string, number>>
    readonly files: number
  }
  | { readonly kind: 'done'; readonly dir: string; readonly files: number; readonly short: ReadonlyArray<string> }
  | { readonly kind: 'failed'; readonly dir: string | null; readonly why: string }

/** What a step leaves the mod to do: files to write, in order, then the next request, if any. */
export interface ExportStep {
  readonly state: ExportState
  readonly writes: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly ask: Route | null
}

const headRoute: Route = { path: '/v1/account/export' }

/** The export as it starts: its files go under `base`, in a folder named by the login and `stamp`. */
export const exportStart = (base: string, stamp: string): ExportStep => ({
  state: { kind: 'head', base, stamp },
  writes: [],
  ask: headRoute,
})

/**
 * Where exports go: under the server's home, as `PATHOFDEV_HOME` names it, else `~/.pathofdev`; null with neither, as
 * a relative path would land in the session's working directory.
 */
export const exportsDirOf = (named: string | undefined, home: string | undefined): string | null =>
  named ? `${named}/exports` : home ? `${home}/.pathofdev/exports` : null

/** A time as a folder name may carry it: `2026-10-16T10-56-36Z`. */
export const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')

const isPartName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z]{1,32}$/.test(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const partsOf = (head: Record<string, unknown>): ReadonlyArray<PartHead> | null => {
  const parts = head['parts']
  if (!Array.isArray(parts)) return null
  const read = parts.map((part: unknown): PartHead | null =>
    isRecord(part) && isPartName(part['part']) && isCount(part['rows']) && (part['upto'] === null || isCount(part['upto']))
      ? { part: part['part'], rows: part['rows'], upto: part['upto'] as number | null }
      : null
  )
  return read.every((part): part is PartHead => part !== null) && new Set(read.map((part) => part?.part)).size === read.length
    ? (read as ReadonlyArray<PartHead>)
    : null
}

/** The folder name a login gives: its letters, digits and hyphens. */
const loginPart = (player: unknown): string => {
  const login = isRecord(player) ? printable(player['github_login'], 39).replace(/[^A-Za-z0-9-]/g, '') : ''
  return login === '' ? 'account' : login
}

const pageRoute = (part: PartHead, after: string | null): Route => {
  const query = [
    after === null ? null : `after=${encodeURIComponent(after)}`,
    part.upto === null ? null : `upto=${part.upto}`,
  ].filter((one) => one !== null)
  return { path: `/v1/account/export/${part.part}${query.length === 0 ? '' : `?${query.join('&')}`}` }
}

/** A part may take a page per row it had at the head, and a few more for rows that came since (sessions). */
const pagesAllowed = (part: PartHead): number => part.rows + 8

const fileName = (part: string, page: number): string => `${part}-${String(page).padStart(4, '0')}.json`

/** The step after the last ask was answered `answer` (null: no answer); a done or failed export stays as it is. */
export const exportStep = (
  state: ExportState,
  answer: { readonly status: number; readonly ok: boolean; readonly text: string } | null,
  origin: string,
): ExportStep => {
  const stay = (to: ExportState): ExportStep => ({ state: to, writes: [], ask: null })
  if (state.kind === 'done' || state.kind === 'failed') return stay(state)
  const dir = state.kind === 'parts' ? state.dir : null
  const fail = (why: string): ExportStep => stay({ kind: 'failed', dir, why })
  const common = commonTextOf(answer, origin)
  if (common !== null || answer === null) return fail(common ?? '')
  if (!answer.ok) return fail(`The Path of Dev server at ${origin} answered ${answer.status}.`)
  if (new TextEncoder().encode(answer.text).length > maxFileBytes) return fail('The server sent a page too big to write.')
  const body = parsed(answer.text)
  const odd = fail(`The Path of Dev server at ${origin} answered something unexpected.`)
  if (!isRecord(body)) return odd

  if (state.kind === 'head') {
    const parts = partsOf(body)
    if (parts === null) return odd
    const into = `${state.base}/${loginPart(body['player'])}-${state.stamp}`
    const next: ExportState = { kind: 'parts', dir: into, parts, at: 0, pages: 0, after: null, got: {}, files: 1 }
    return advance(next, [{ path: `${into}/head.json`, text: answer.text }])
  }

  const part = state.parts[state.at]!
  const rows = body['rows']
  const after = body['next']
  if (!Array.isArray(rows) || (after !== null && typeof after !== 'string')) return odd
  // A page that names a next one carries a row, or the export could ask forever.
  if (after !== null && rows.length === 0) return odd
  const pages = state.pages + 1
  if (pages > pagesAllowed(part)) return fail(`The server sent more pages of ${part.part} than it has rows.`)
  const write = { path: `${state.dir}/${fileName(part.part, pages)}`, text: answer.text }
  const got = { ...state.got, [part.part]: (state.got[part.part] ?? 0) + rows.length }
  const files = state.files + 1
  if (after !== null) {
    return { state: { ...state, pages, after, got, files }, writes: [write], ask: pageRoute(part, after) }
  }
  return advance({ ...state, at: state.at + 1, pages: 0, after: null, got, files }, [write])
}

/** The next part's first page, or, past the last part, complete.json and done. */
const advance = (state: Extract<ExportState, { kind: 'parts' }>, writes: ExportStep['writes']): ExportStep => {
  const part = state.parts[state.at]
  if (part !== undefined) return { state, writes, ask: pageRoute(part, null) }
  // Sessions change while the export reads; every other part's rows are the head's, to the row.
  const short = state.parts
    .filter((one) => one.upto !== null && (state.got[one.part] ?? 0) !== one.rows)
    .map((one) => one.part)
  const complete = {
    parts: state.parts.map((one) => ({ part: one.part, rows: state.got[one.part] ?? 0, atHead: one.rows })),
  }
  return {
    state: { kind: 'done', dir: state.dir, files: state.files + 1, short },
    writes: [...writes, { path: `${state.dir}/complete.json`, text: `${JSON.stringify(complete, null, 2)}\n` }],
    ask: null,
  }
}

/** What an export that ended says. */
export const exportTextOf = (state: ExportState): string => {
  switch (state.kind) {
    case 'done': {
      const short = state.short.length === 0 ? '' : ` The server sent another count than it said for ${state.short.join(', ')}.`
      return `Exported your account to ${state.dir}: ${state.files} files, complete.json last.${short}`
    }
    case 'failed':
      return state.dir === null
        ? `The export did not start: ${state.why}`
        : `The export stopped part way: ${state.why} What it wrote is in ${state.dir}, without complete.json.`
    case 'head':
    case 'parts':
      return 'The export is under way.'
  }
}
