import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type {
  CommandInfo,
  ConfigRow,
  ModelCompleteInput,
  ModelCompleteResult,
  On,
  PromptOrigin,
  RenderPropsOf,
  SessionMessage,
  SessionStartInput,
} from 'claude-code'
import type { QuestRewards } from '@pathofdev/schema'
import type { BandLook, BandView, Celebration, MissionsView, MissionView, WelcomeStep, WelcomeView } from '../types'
import { barCells } from './band'
import { joinQueue, queueOf, rewardsText } from './celebrate'
import { cellsOf, cellsOfRow, glyphSlot } from './cells'
import { hmac } from './ids'
import { barRow } from './frames'
import { sheenHead } from './looks'
import { exitIsTheRuns, githubName, testRunner } from './observe'
import { missionChip, missionsLayout, timeLeft } from './missions'
import { headerOf, renamedNote, tabBarOf } from './pane'
import { clientVersion, initOf, socketPathsOf } from './server'
import { statsLayout, twoColumnsFrom } from './stats'
import { statsViewOf } from './view'
import { closeSetsAside, freshWizard, lootText, stepperRow, taperText, welcomeLayout, xpText } from './welcome'
import { github as recorded } from '../test/github'

// A fake local server beneath the mod: it answers the four routes, records what the mod sends, and holds the
// stream until the test's clock passes 25 seconds, as the real one does.

type Sent = { path: string; body: unknown; method: string; query: string; socket: string; authorization?: string | undefined }

/**
 * GitHub's device flow beneath the mod, from the recorded answers: the device code, then each poll's answer in turn
 * (a number answers with that status), the last one again once they run out. It records when each request came.
 */
type GitHubFake = { device: string | number; polls: Array<string | number>; seen: Array<{ url: string; at: number; init: unknown }> }

/**
 * The online server's accounts: the game tokens it takes, and the GitHub token it trades for `issue`. An https request
 * without a token it takes is answered 401; a sign-in or a logout answers `signIn` or `logout` when set.
 */
type Accounts = {
  tokens: Set<string>
  githubToken: string
  issue: string
  login: string
  signIn?: { status: number; body: unknown }
  logout?: number
  /** The beta list: the tokens of the server's admins, and the logins added, by their lower case. */
  beta?: { admins: Set<string>; logins: Map<string, string> }
}

/** What the player owns in the fake server: entries, their definitions, and what is equipped where. */
type Owned = { inventory: Array<{ id: string; itemId: string }>; items: Array<unknown>; equipped: Record<string, string> }

/** A mission as the snapshot carries it. */
type Quest = {
  questId: string
  packId: string
  title: string
  description: string | null
  cadence: string
  start: string
  status: string
  progress: number
  goal: number
  goalKind?: string
  rewards: Record<string, unknown>
  expiresAt: string | null
}

/** What the stats tab reads: the player stats, and the streak the character carries. */
type Counted = { stats: unknown; streak: unknown }

/** The welcome as a server that runs it keeps it: done or not, the egg, and the character's name, which it changes. */
type Greeting = { done: boolean; egg: { species: string; name: string } | null; name: string }

/**
 * What the shop and the pet's card read: the offers, the pet, the boosts running, the shards and the gold; and the
 * welcome, from a server that runs it.
 */
type Kept = {
  shop?: Array<unknown>
  pet?: unknown
  boosts?: Array<unknown>
  shards?: Record<string, number>
  gold?: number
  welcome?: Greeting
}

const snapshot = (
  level: number,
  pet: unknown = null,
  cursor = 0,
  glyph = '⚔',
  owned?: Owned,
  isDev = false,
  counted?: Counted,
  quests?: ReadonlyArray<Quest>,
  kept: Kept = {},
) => ({
  ...(isDev ? { dev: true } : {}),
  serverId: 'local-test',
  streamEpoch: 1,
  cursor,
  pet: kept.pet ?? pet,
  ...(kept.shop === undefined ? {} : { shop: kept.shop }),
  ...(kept.boosts === undefined ? {} : { boosts: kept.boosts }),
  ...(kept.welcome === undefined ? {} : { welcome: { done: kept.welcome.done }, egg: kept.welcome.egg }),
  character: {
    name: kept.welcome?.name ?? 'Player',
    level,
    title: 'Apprentice',
    glyph,
    xp: { total: 130, verified: 0, reported: 130, intoLevel: 30, forNextLevel: 203 },
    gold: kept.gold ?? 25,
    ...(kept.shards === undefined ? {} : { shards: kept.shards }),
    streak: counted?.streak ?? { days: 2, restDaysLeftThisWeek: 1, lastDay: '2026-10-09' },
    equipped: { ...owned?.equipped },
  },
  ...(counted === undefined ? {} : { stats: counted.stats }),
  ...(quests === undefined ? {} : { quests }),
  inventory: (owned?.inventory ?? []).map((entry) => ({
    ...entry,
    acquiredAt: '2026-10-09T08:00:00Z',
    source: { kind: 'drop', ref: '1' },
    dye: null,
  })),
  items: owned?.items ?? [],
})

const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** A session's bottom: what the engine itself answers beneath every plugin, and the commands and panes it took. */
const engineBeneath = (on: On, isPaneUp = false) => {
  const registered: Array<string> = []
  const opened: Array<string> = []
  const toasts: Array<string> = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/work/widgets' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.run', ($, e) => ({ text: `ran ${e.command}` }))
  on('command.list', () => ({ value: commands }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.panes', () => ({
    value: isPaneUp ? [{ id: 'questline', title: 'Path of Dev', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', ($, e) => {
    opened.push(e.focus === true ? `${e.id}+focus` : e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  return { registered, opened, toasts }
}

/** The commands the session lists: a built-in, a plugin's, and the player's own. */
const commands: Array<CommandInfo> = [
  { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
  { name: 'pr-watch:watch', description: 'Watch a PR', source: 'plugin', plugin: 'pr-watch' },
  { name: 'ship-acme-secret', description: 'Ship it', source: 'user' },
]

type Clock = ReturnType<typeof mock.clock>

/** Lets the mod's work run until `check` holds: its start-up chains several calls, more than one settle may cover. */
const until = async (clock: Clock, check: () => boolean | Promise<boolean>) => {
  for (let round = 0; round < 100; round++) {
    if (await check()) return
    await clock.settle()
  }
  throw new Error('the mod never got there')
}

type ServerOptions = {
  level?: number
  glyph?: string
  isDown?: boolean
  stream?: Array<{ seq: number }>
  owned?: Owned
  /** A dev server: its snapshot says so, and it takes the dev commands. */
  isDev?: boolean
  /** The status the command route answers with, when not 200. */
  commandStatus?: number
  /** The stats the snapshot carries; none, as from a server older than the stats, when not given. */
  counted?: Counted
  /** The missions the snapshot carries, which quest.accept and quest.abandon change; none, as from an older server. */
  quests?: Array<Quest>
  /** The rules the session answer carries; none, as from an older server. */
  rules?: Record<string, unknown>
  /** A server from before presence: it has no route to close a session. */
  predatesPresence?: boolean
  /** A server that takes this long to answer a close, in ms. */
  closeTakes?: number
  /** The shop, the pet, the boosts, the shards and the gold the snapshot carries. */
  kept?: Kept
  /** A server that goes away once it has answered a command. */
  downAfterCommand?: boolean
  /** The one socket the server listens on, which a test may move; it answers on any when not given. */
  listensOn?: { at: string }
  /** The mod's pane is up already, as the engine keeps it across a reload. */
  isPaneUp?: boolean
  /** A server that takes this long to answer a command, in ms. */
  commandTakes?: number
  /** A server that takes this long to answer a batch of events, in ms. */
  eventsTake?: number
  /** The one socket whose stream hands the mod the test's events, any other holding its 25 seconds; any when unset. */
  streamsOn?: string
  /** GitHub, for a sign-in. */
  github?: GitHubFake
  /** The online server's accounts, which hold every https request to a token. */
  accounts?: Accounts
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * What the fake server answers a command: an equip or unequip changes what it owns, a pick or a give-up changes its
 * missions (a pick of a mission not on offer refused), and anything else is refused.
 */
const commandAnswer = (
  body: unknown,
  owned: Owned | undefined,
  isDev: boolean,
  quests: Array<Quest> | undefined,
  kept: Kept = {},
) => {
  const data = isRecord(body) && isRecord(body['data']) ? body['data'] : {}
  const greeting = kept.welcome
  // The welcome's choices, held to the server's rules on names and species as far as these tests go.
  const named = typeof data['name'] === 'string' ? data['name'].trim().replace(/\s+/g, ' ') : ''
  const message = `A name takes at most 20 characters, and that one has ${named.length}`
  const tooLong = { status: 'refused', code: 'invalid', message }
  if (greeting !== undefined && isRecord(body) && body['type'] === 'character.rename') {
    if (named.length > 20) return tooLong
    greeting.name = named
    return { status: 'ok', events: [] }
  }
  if (greeting !== undefined && isRecord(body) && body['type'] === 'egg.choose') {
    if (kept.pet !== undefined && kept.pet !== null) {
      return { status: 'refused', code: 'not_allowed', message: 'It has hatched, and keeps its species and name' }
    }
    if (named.length > 20) return tooLong
    greeting.egg = { species: String(data['species']), name: named }
    return { status: 'ok', events: [] }
  }
  if (greeting !== undefined && isRecord(body) && body['type'] === 'welcome.done') {
    greeting.done = true
    return { status: 'ok', events: [] }
  }
  const questId = typeof data['questId'] === 'string' ? data['questId'] : ''
  const type = isRecord(body) ? body['type'] : undefined
  const quest = quests?.find((one) => one.questId === questId)
  if (type === 'quest.accept' && quest?.status === 'offered') {
    quest.status = 'active'
    return { status: 'ok', events: [] }
  }
  if (type === 'quest.accept') return { status: 'refused', code: 'not_allowed', message: 'That mission is not on offer' }
  if (type === 'quest.abandon' && quest?.status === 'active') {
    quest.status = 'offered'
    quest.progress = 0
    return { status: 'ok', events: [] }
  }
  const slot = typeof data['slot'] === 'string' ? data['slot'] : ''
  const entryId = typeof data['entryId'] === 'string' ? data['entryId'] : ''
  if (owned !== undefined && isRecord(body) && body['type'] === 'item.equip') {
    owned.equipped[slot] = entryId
    return { status: 'ok', events: [{ seq: 900, at: '2026-10-09T08:00:00.000Z', cause: null, type: 'item.equipped', data }] }
  }
  if (owned !== undefined && isRecord(body) && body['type'] === 'item.unequip') {
    delete owned.equipped[slot]
    return { status: 'ok', events: [] }
  }
  // A purchase, a meal, a pat or a trade: what it did arrives on the stream.
  const choices = ['shop.buy', 'pet.feed', 'pet.pet', 'item.reroll', 'item.salvage', 'shards.craft']
  if (isRecord(body) && typeof body['type'] === 'string' && choices.includes(body['type'])) return { status: 'ok', events: [] }
  // What the dev commands make arrives on the stream; the answer needn't repeat it.
  if (isDev && isRecord(body) && typeof body['type'] === 'string' && body['type'].startsWith('dev.')) return { status: 'ok', events: [] }
  return { status: 'refused', code: 'not_allowed', message: 'The egg hatches at level 1' }
}

const fakeServer = (on: On, clock: Clock, options: ServerOptions = {}) => {
  const sent: Array<Sent> = []
  const tried: Array<string> = []
  /** Each request tried, with the socket it was tried on. */
  const attempts: Array<{ path: string; socket: string }> = []
  const sockets = new Set<string>()
  /** The socket of each request the server answered, in order. */
  const answeredOn: Array<string> = []
  const { registered, opened, toasts } = engineBeneath(on, options.isPaneUp === true)
  on('http.fetch', async ($, e) => {
    const github = options.github
    if (new URL(e.url).host === 'github.com') {
      if (github === undefined) throw new Error('getaddrinfo ENOTFOUND github.com')
      github.seen.push({ url: e.url, at: await clock.now(), init: e.init })
      const answer = e.url.endsWith('/login/device/code') ? github.device : (github.polls.length > 1 ? github.polls.shift() : github.polls[0])
      return typeof answer === 'number' ? reply(answer, {}) : { value: { status: 200, ok: true, headers: {}, text: answer ?? '' } }
    }
    tried.push(new URL(e.url).pathname)
    const socketPath = e.init?.socketPath ?? ''
    sockets.add(socketPath)
    attempts.push({ path: new URL(e.url).pathname, socket: socketPath })
    if (options.isDown === true) throw new Error('connect ENOENT /home/player/.pathofdev/server.sock')
    const listening = options.listensOn?.at ?? socketPath
    if (socketPath !== listening) throw new Error(`connect ENOENT ${socketPath}`)
    answeredOn.push(socketPath)
    const path = new URL(e.url).pathname
    const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    const method = e.init?.method ?? 'GET'
    const authorization = e.init?.headers?.['authorization']
    sent.push({ path, body, method, query: new URL(e.url).search, socket: socketPath, authorization })
    const accounts = options.accounts
    if (accounts !== undefined && e.url.startsWith('https://')) {
      const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
      const signInAgain = { _tag: 'Unauthorized', message: 'This sign-in is no longer valid: sign in again' }
      if (path === '/v1/auth/github') {
        if (accounts.signIn !== undefined) return reply(accounts.signIn.status, accounts.signIn.body)
        if (!isRecord(body) || body['githubToken'] !== accounts.githubToken)
          return reply(401, { _tag: 'Unauthorized', message: 'GitHub did not accept this sign-in: sign in again' })
        accounts.tokens.add(accounts.issue)
        const player = { id: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T', githubUserId: 1, githubLogin: accounts.login, displayName: 'Mona', createdAt: '2026-10-09T08:00:00.000Z' }
        return reply(200, { token: accounts.issue, player })
      }
      if (path === '/v1/auth/logout') {
        if (accounts.logout !== undefined) return reply(accounts.logout, {})
        if (!accounts.tokens.delete(token)) return reply(401, signInAgain)
        return reply(200, { signedOut: true })
      }
      if (!accounts.tokens.has(token)) return reply(401, signInAgain)
      const beta = accounts.beta
      if (beta !== undefined && path.startsWith('/v1/beta')) {
        if (!beta.admins.has(token))
          return reply(403, { _tag: 'Forbidden', message: "Only the server's admins can see or change the beta list" })
        if (method === 'GET') {
          const entries = [...beta.logins.values()].map((login) => ({ source: 'added', login, addedAt: '2026-10-09T08:00:00.000Z', addedBy: 7 }))
          return reply(200, { entries: [...entries, { source: 'env', login: 'bob' }, { source: 'admin', githubUserId: 7, login: 'root' }] })
        }
        const login = method === 'DELETE' ? decodeURIComponent(path.slice('/v1/beta/'.length)) : isRecord(body) ? String(body['login']) : ''
        const changed = method === 'DELETE' ? beta.logins.delete(login.toLowerCase()) : !beta.logins.has(login.toLowerCase())
        if (method === 'POST' && changed) beta.logins.set(login.toLowerCase(), login)
        const message = method === 'DELETE'
          ? changed ? `${login} is off the beta list: their next request is turned away.` : `${login} was not on the beta list, so nothing changed.`
          : changed ? `${login} is on the beta list now: they can sign in.` : `${login} was on the beta list already: nothing changed.`
        return reply(200, { login, changed, message })
      }
    }
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) {
      if (options.closeTakes !== undefined) await clock.sleep(options.closeTakes)
      return options.predatesPresence === true ? reply(404, { code: 'not_found', message: 'Not found' }) : reply(200, { closed: true })
    }
    if (path === '/v1/sessions')
      return reply(200, {
        snapshot: snapshot(
          options.level ?? 0,
          null,
          0,
          options.glyph,
          options.owned,
          options.isDev === true,
          options.counted,
          options.quests,
          options.kept,
        ),
        rules: options.rules ?? {},
        minClientVersion: '0.0.0',
        acceptedEventTypes: [],
      })
    if (path === '/v1/events') {
      if (options.eventsTake !== undefined) await clock.sleep(options.eventsTake)
      const events = typeof body === 'object' && body !== null && 'events' in body && Array.isArray(body.events) ? body.events : []
      // A type from a newer mod than this server knows, as `future.*` stands for here.
      const resultOf = (event: { id: string; type: string }) =>
        event.type.startsWith('future.')
          ? { id: event.id, status: 'rejected', reason: 'unknown_type' }
          : { id: event.id, status: 'accepted' }
      return reply(200, { results: events.map(resultOf), events: [] })
    }
    if (path === '/v1/commands') {
      if (options.commandStatus !== undefined) return reply(options.commandStatus, { error: 'internal' })
      if (options.downAfterCommand === true) options.isDown = true
      if (options.commandTakes !== undefined) await clock.sleep(options.commandTakes)
      return reply(200, commandAnswer(body, options.owned, options.isDev === true, options.quests, options.kept))
    }
    // The stream answers as soon as the test hands it events, or after 25 seconds with none.
    const isFed = options.streamsOn === undefined || options.streamsOn === socketPath
    const stream = isFed ? (options.stream ?? []) : []
    if (options.stream === undefined || !isFed) await clock.sleep(25_000)
    else for (let waited = 0; waited < 25_000 && stream.length === 0; waited += 100) await clock.sleep(100)
    const events = stream.splice(0)
    const cursor = Math.max(0, ...events.map((event) => event.seq))
    return reply(200, { events, cursor, rulesVersion: 1, minClientVersion: '0.0.0' })
  })
  on('process.run', ($, e) => {
    const args = e.argv.join(' ')
    if (args === 'git rev-parse --show-toplevel') return ran(0, '/work/widgets\n')
    if (args === 'git remote get-url origin') return ran(0, 'git@github.com:acme/widgets.git\n')
    if (args === 'git rev-parse --abbrev-ref HEAD') return ran(0, 'main\n')
    return ran(1, '')
  })
  return { sent, tried, attempts, registered, opened, toasts, sockets, answeredOn }
}

const start: SessionStartInput = { cwd: '/work/widgets', surface: 'terminal', isInteractive: true }
const bandOf = (): RenderPropsOf['AbovePrompt'] => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})
const surfaces: ReadonlyArray<'terminal' | 'desktop'> = ['terminal', 'desktop']

const eventsOf = (sent: ReadonlyArray<Sent>): Array<Record<string, unknown>> =>
  sent
    .filter((one) => one.path === '/v1/events')
    .flatMap((one) =>
      typeof one.body === 'object' && one.body !== null && 'events' in one.body && Array.isArray(one.body.events) ? one.body.events : [],
    )

/** Events of a type from a newer mod, already queued, as a store holds them. */
const futureEvents = (count: number): Array<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => ({
    id: `future-${i}`,
    occurredAt: '2026-10-09T07:00:00.000Z',
    sessionId: 'earlier',
    type: 'future.thing',
    data: {},
  }))

describe('the band', () => {
  test('says how to start the server when none answers', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    fakeServer(on, clock, { isDown: true })
    await $.session.start(start)
    await until(clock, async () => {
      const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: bandOf() }).catch(() => null)
      if (ui === null) return false
      const hint = await ui.find({ type: 'Text', text: /pnpm --filter @pathofdev\/server start/ })
      await ui.unmount()
      return hint !== undefined
    })
  })

  test('draws the character, and offers the egg from level 1', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock, { level: 1 })
    await $.session.start(start)
    // The stream is held once the snapshot is in.
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    for (const surface of surfaces) {
      const ui = await $.ui.mount({ plugin: 'questline', surface, component: 'AbovePrompt', props: bandOf() })
      expect(await ui.find({ type: 'Text', text: /Lv 1/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /30\/203 xp/ })).toBeDefined()
      await ui.press({ key: 'hatch' })
      await ui.unmount()
    }
    const hatches = sent.filter((one) => one.path === '/v1/commands')
    expect(hatches.length).toBe(2)
    expect(hatches[0]?.body).toMatchObject({ type: 'pet.hatch', data: { species: 'fox', name: 'Ember' } })
  })

  test('starts again after a /clear, under a new session id', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const server = { level: 1 }
    const { sent } = fakeServer(on, clock, server)
    const opened = () => sent.filter((one) => one.path === '/v1/sessions')
    await $.session.start(start)
    await until(clock, () => opened().length === 1)
    // A /clear fires no session.start; the band draws what the new session's snapshot says.
    server.level = 2
    await $.session.end({ reason: 'clear', sessionId: 'first', resume: { id: 'first' } })
    await until(clock, () => opened().length === 2)
    expect(opened()[1]?.body).not.toEqual(opened()[0]?.body)
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: bandOf() })
    expect(await ui.find({ type: 'Text', text: /Lv 2/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('reporting work', () => {
  test('sends a commit, a test run and the finished turn, named by the GitHub repo', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock)
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      if (e.command.startsWith('git commit')) {
        return {
          result: {
            stdout: '',
            stderr: '',
            interrupted: false,
            gitOperation: { commit: { sha: 'a'.repeat(40), kind: 'committed', branch: 'main' } },
          },
        }
      }
      const result = { stdout: '', stderr: '', interrupted: false }
      return e.command.includes('fail') ? { result, isError: true } : { result }
    })
    await $.session.start(start)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))

    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add widgets"' })
    await $.tool.call({ tool: 'Bash', command: 'pnpm test # fail' })
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    await $.tool.call({ tool: 'Bash', command: 'pnpm test | tail -5' })
    await $.turn.complete({ answer: 'Done', durationMs: 4200, isAborted: false, turnId: 't1', reason: 'answer' })
    await until(clock, () => eventsOf(sent).some((event) => event['type'] === 'turn.completed'))

    const events = eventsOf(sent)
    expect(events.map((event) => event['type'])).toEqual([
      'repo.explored',
      'commit.made',
      'tests.failed',
      'tests.passed',
      'turn.completed',
    ])
    expect(events[1]).toMatchObject({ data: { commit: { type: 'github', repo: 'acme/widgets', sha: 'a'.repeat(40) } } })
    expect(events[2]).toMatchObject({ data: { runner: 'npm', checkout: { repo: 'acme/widgets', branch: 'main' } } })
    expect(events[4]).toMatchObject({ data: { durationMs: 4200, toolCalls: 4 } })
  })

  test('keeps events while the server is down, and sends them once it answers', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const server = { isDown: true }
    const { sent, tried } = fakeServer(on, clock, server)
    await $.session.start(start)
    // The mod tries the server once it knows its repo and has queued the exploration.
    await until(clock, () => tried.includes('/v1/sessions'))
    await $.turn.complete({ answer: 'Done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't2', reason: 'aborted' })
    await clock.settle()
    expect(sent).toEqual([])
    server.isDown = false
    await clock.advance(5_000)
    await until(clock, () => eventsOf(sent).length >= 2)
    expect(eventsOf(sent).map((event) => event['type'])).toEqual(['repo.explored', 'turn.completed'])
  })

  test('sends what queued behind a full batch of types the server does not know yet', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on, { queue: futureEvents(100) })
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock)
    await $.session.start(start)
    await until(clock, () => eventsOf(sent).some((event) => event['type'] === 'repo.explored'))
  })

  test('keeps one flush interval across session starts', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    // An event the server keeps answering unknown_type, so every flush sends it again.
    mock.store(on, { queue: futureEvents(1), explored: ['acme/widgets'] })
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock)
    const flushes = () => sent.filter((one) => one.path === '/v1/events').length
    await $.session.start(start)
    await until(clock, () => flushes() === 1)
    await $.session.start(start)
    await until(clock, () => flushes() === 2)
    await clock.advance(30_000)
    expect(flushes()).toBe(3)
  })
})

const USAGE = { input_tokens: 812, output_tokens: 41, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const REPLY =
  '{"clarity":7,"grammar":8,"specificity":5,"instructive":6,"context":4,"doneCriteria":3,"focus":9,"regret":1,"note":"clear ask"}'
const composer: PromptOrigin = { kind: 'composer' }
const presentation = { isFullscreen: false, columns: 100 }
const typed = 'why did that explode, please fix the parser and add a failing test first'

/** Haiku beneath the mod: it records what it was asked and answers `answer` (a reply text, a failure or a throw). */
const grader = (on: On, answer: string | ModelCompleteResult | Error = REPLY) => {
  const asked: Array<ModelCompleteInput> = []
  on('model.complete', ($, e) => {
    asked.push(e)
    if (answer instanceof Error) throw answer
    return { value: typeof answer === 'string' ? { isAnswered: true, text: answer, usage: USAGE } : answer }
  })
  return asked
}

/** A started session with the server up, its stream held; `flushed` sends what queued and reads all it has sent. */
const started = async ($: Parameters<TestBody>[0], on: On) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
  mock.store(on, { explored: ['acme/widgets'] })
  mock.env(on, { HOME: '/home/player' })
  const { sent } = fakeServer(on, clock)
  await $.session.start(start)
  await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
  const flushed = async () => {
    await clock.settle()
    await clock.advance(30_000)
    await clock.settle()
    return eventsOf(sent)
  }
  return { clock, sent, flushed }
}

const ofType = (events: ReadonlyArray<Record<string, unknown>>, type: string) => events.filter((event) => event['type'] === type)

describe('grading prompts', () => {
  test('grades a typed prompt with Haiku and sends the scores, never the text', async ($, on) => {
    const asked = grader(on)
    const { sent, flushed } = await started($, on)
    await $.turn.complete({ answer: 'I refactored the parser.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    const entered = await $.prompt.submit({ text: typed, wait: false, origin: composer })
    expect(entered).toEqual({ text: typed })
    const graded = ofType(await flushed(), 'prompt.graded')
    expect(graded).toHaveLength(1)
    expect(graded[0]?.['data']).toEqual({
      scores: { clarity: 7, grammar: 8, specificity: 5, instructive: 6, context: 4, doneCriteria: 3, focus: 9, regret: 1 },
      rubricVersion: 1,
      words: 14,
      grader: 'haiku',
    })
    expect(asked[0]).toMatchObject({ model: 'haiku', maxTokens: 120 })
    expect(asked[0]?.systemBlocks?.[0]?.cache).toBe(true)
    expect(asked[0]?.prompt).toContain(typed)
    expect(asked[0]?.prompt).toContain('I refactored the parser.')
    const wire = JSON.stringify(sent)
    expect(wire).not.toContain('explode')
    expect(wire).not.toContain('clear ask')
  })

  test('reads the previous graded prompt beside the next one', async ($, on) => {
    const asked = grader(on)
    const { flushed } = await started($, on)
    await $.prompt.submit({ text: typed, wait: false, origin: composer })
    await $.prompt.submit({ text: 'now also cover the empty input case in that test', wait: false, origin: composer })
    expect(ofType(await flushed(), 'prompt.graded')).toHaveLength(2)
    expect(asked[1]?.prompt).toContain(`Previous prompt by the user:\n${typed}`)
  })

  test('reads the prompt the player typed last beside the next one, even one too short to grade', async ($, on) => {
    const asked = grader(on)
    const { flushed } = await started($, on)
    await $.prompt.submit({ text: typed, wait: false, origin: composer })
    await $.prompt.submit({ text: 'yes do it', wait: false, origin: composer })
    await $.prompt.submit({ text: 'now also cover the empty input case in that test', wait: false, origin: composer })
    expect(ofType(await flushed(), 'prompt.graded')).toHaveLength(2)
    expect(asked[1]?.prompt).toContain('Previous prompt by the user:\nyes do it')
  })

  test('grades a prompt that opens with a path, not a command', async ($, on) => {
    const asked = grader(on)
    const { flushed } = await started($, on)
    await $.prompt.submit({ text: '/src/parser.ts throws on empty input, add a failing test and fix it', wait: false, origin: composer })
    expect(ofType(await flushed(), 'prompt.graded')).toHaveLength(1)
    expect(asked).toHaveLength(1)
  })

  test('sends nothing for a short prompt, a slash command or a prompt the player did not type', async ($, on) => {
    const asked = grader(on)
    const { flushed } = await started($, on)
    await $.prompt.submit({ text: 'yes do it', wait: false, origin: composer })
    await $.prompt.submit({ text: '/code-review medium with plenty of words here', wait: false, origin: composer })
    await $.prompt.submit({ text: typed, wait: false, origin: { kind: 'task-notification' } })
    expect(ofType(await flushed(), 'prompt.graded')).toEqual([])
    expect(asked).toEqual([])
  })

  test('grades from the minWords option', { options: { minWords: 3 } }, async ($, on) => {
    grader(on)
    const { flushed } = await started($, on)
    await $.prompt.submit({ text: 'yes do it', wait: false, origin: composer })
    await $.prompt.submit({ text: 'go', wait: false, origin: composer })
    expect(ofType(await flushed(), 'prompt.graded').map((event) => event['data'])).toMatchObject([{ words: 3 }])
  })

  const failures: ReadonlyArray<[string, string | ModelCompleteResult | Error]> = [
    ['an API error', { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }],
    ['a call that throws', new Error('refused')],
    ['a reply that is no JSON', 'Sure! The prompt is pretty good.'],
    ['a score out of range', REPLY.replace('"focus":9', '"focus":12')],
    ['a missing score', REPLY.replace('"regret":1,', '')],
  ]
  for (const [what, answer] of failures) {
    test(`sends nothing on ${what}, and the prompt goes on`, async ($, on) => {
      grader(on, answer)
      const { flushed } = await started($, on)
      expect(await $.prompt.submit({ text: typed, wait: false, origin: composer })).toEqual({ text: typed })
      const events = await flushed()
      expect(ofType(events, 'prompt.graded')).toEqual([])
    })
  }
})

describe('counting stats', () => {
  test('a /clear counts under the session it ends', async ($, on) => {
    const { flushed, sent } = await started($, on)
    const opened = sent.find((one) => one.path === '/v1/sessions')?.body
    await $.session.end({ reason: 'clear', sessionId: 'first', resume: { id: 'first' } })
    const cleared = ofType(await flushed(), 'session.cleared')
    expect(cleared).toMatchObject([{ data: {} }])
    expect(opened).toEqual({ sessionId: cleared[0]?.['sessionId'], presence: true })
  })

  test("counts the player's compactions by trigger, not a subagent's, a precompute or a skipped one", async ($, on) => {
    on('session.compact', { trigger: 'plugin' }, () => ({ skip: 'nothing to compact' }))
    const { flushed } = await started($, on)
    const messages: Array<SessionMessage> = [{ role: 'user', text: 'Fix the parser', toolUses: [] }]
    await $.session.compact({ trigger: 'manual', messages })
    await $.session.compact({ trigger: 'auto', messages })
    await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages })
    await $.session.compact({ trigger: 'precompute', messages })
    await $.session.compact({ trigger: 'plugin', messages })
    const compacted = ofType(await flushed(), 'session.compacted').map((event) => event['data'])
    expect(compacted).toEqual([{ trigger: 'manual' }, { trigger: 'auto' }])
  })

  test("counts a command the player ran by name, their own as custom, and none a plugin ran", async ($, on) => {
    const { flushed } = await started($, on)
    await $.command.run({ command: 'compact', args: 'keep the plan', origin: composer, presentation })
    await $.command.run({ command: 'pr-watch:watch', args: '', origin: { kind: 'bridge' }, presentation })
    await $.command.run({ command: 'ship-acme-secret', args: '', origin: composer, presentation })
    await $.command.run({ command: 'compact', args: '', origin: { kind: 'plugin', name: 'other' }, presentation })
    const used = ofType(await flushed(), 'command.used').map((event) => event['data'])
    expect(used).toEqual([{ command: '/compact' }, { command: '/pr-watch:watch' }, { command: 'custom' }])
    expect(JSON.stringify(used)).not.toContain('keep the plan')
  })

  test('reports the fullest the context got once a turn, and nothing for a turn nothing measured', async ($, on) => {
    const { flushed } = await started($, on)
    const measure = (percent: number | undefined, changed: Array<'context' | 'cost'>) =>
      $.session.measure({ context: { window: 200_000, ...(percent === undefined ? {} : { percent }) }, rateLimits: [], changed })
    await measure(40, ['context'])
    await measure(85, ['context'])
    await measure(30, ['context'])
    await measure(99, ['cost'])
    await measure(undefined, ['context'])
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(ofType(await flushed(), 'context.measured').map((event) => event['data'])).toEqual([{ pct: 85 }])
  })
})

describe('the link', () => {
  test('keeps one reconnect waiting however often /clear connects again', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const { attempts } = fakeServer(on, clock, { isDown: true })
    // Each open tries the socket in ~/.pathofdev, then the one a server from before the rename would listen on.
    const opensOn = (socket: string) =>
      attempts.filter((one) => one.path === '/v1/sessions' && one.socket === socket).length
    const opens = () => opensOn('/home/player/.pathofdev/server.sock')
    await $.session.start(start)
    await until(clock, () => opens() === 1)
    for (const id of ['first', 'second', 'third']) {
      await $.session.end({ reason: 'clear', sessionId: id, resume: { id } })
    }
    await until(clock, () => opens() === 4)
    await clock.advance(5_000)
    expect(opens()).toBe(5)
    expect(opensOn('/home/player/.questline/server.sock')).toBe(5)
  })
})

// Server events as the stream carries them, numbered in order.
let seq = 0
const serverEvent = (type: string, data: Record<string, unknown>, cause: string | null = null) => ({
  seq: ++seq,
  at: '2026-10-09T08:00:00.000Z',
  cause,
  type,
  data,
})
/** The same event as one input caused it, with the others that input caused. */
const causedBy = <E extends { cause: string | null }>(cause: string, ...events: Array<E>) =>
  events.map((event) => ({ ...event, cause }))
const drop = (tier: string, name: string, gold = 0) =>
  serverEvent('loot.dropped', {
    entry: { id: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T', itemId: name, acquiredAt: '2026-10-09T08:00:00Z', source: { kind: 'drop', ref: '1' }, dye: null },
    item: { id: name, name, rarity: tier, category: 'wearable', slot: 'head', sprite: null, lore: null, effect: null },
    gold,
    pity: { sinceRare: 0, sinceEpic: 0 },
    tier,
  })
const levelUp = (from: number, to: number, tier: string, more: Record<string, unknown> = {}) =>
  serverEvent('level.up', { from, to, tier, glyph: '🗡️', ...more })
const xpGranted = (amount: number) => serverEvent('xp.granted', { amount, tier: 'reported', reason: 'prompt.graded', totalAfter: 150 })

/** What the band draws now: every text, and how many rows the celebration grew it by. */
const band = async ($: Parameters<TestBody>[0], maxRows = 20) => {
  const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: { ...bandOf(), maxRows } })
  // The gain's own line names the latest drop the whole time; what plays is the rest.
  const texts = (await ui.findAll({ type: 'Text' }))
    .map((one) => one.text)
    .filter((text) => !/ · (common|uncommon|rare|epic|legendary)$/.test(text))
  const grown = (await ui.find({ type: 'Box', key: 'stage' }))?.children.length ?? 0
  await ui.unmount()
  return { all: texts.join('\n'), grown }
}

/** A session with the server up and its stream open, which hands the mod `events` when `send` is called. */
const streaming = async ($: Parameters<TestBody>[0], on: On, owned?: Owned, isDev = false, more: ServerOptions = {}) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
  mock.store(on, { explored: ['acme/widgets'] })
  mock.env(on, { HOME: '/home/player' })
  const stream: Array<{ seq: number }> = []
  const options = { ...more, level: 4, stream, isDev, ...(owned === undefined ? {} : { owned }) }
  const { sent, registered, opened, toasts, sockets, answeredOn } = fakeServer(on, clock, options)
  const played: Array<string> = []
  on('audio.play', ($, e) => {
    played.push(e.clip.mime ?? e.clip.asset ?? '')
    return { value: undefined }
  })
  await $.session.start(start)
  await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
  const send = async (...events: Array<{ seq: number }>) => {
    stream.push(...events)
    await clock.advance(100)
    await until(clock, () => stream.length === 0)
    await clock.settle()
  }
  return { clock, send, played, sent, registered, opened, toasts, sockets, answeredOn }
}

/** Samples the band every 100 ms for `ms`, keeping which of `names` it draws at each sample, without repeats. */
const watch = async ($: Parameters<TestBody>[0], clock: Clock, ms: number, names: ReadonlyArray<string>) => {
  const seen: Array<string> = []
  for (let at = 0; at < ms; at += 100) {
    const { all } = await band($)
    const shown = names.filter((name) => all.includes(name))
    // Two at once would be two celebrations overlapping.
    expect(shown.length).toBeLessThanOrEqual(1)
    const one = shown[0]
    if (one !== undefined && seen[seen.length - 1] !== one) seen.push(one)
    await clock.advance(100)
  }
  return seen
}

describe('the level glyph', () => {
  test('draws the glyph the snapshot names before Lv, in a slot two cells wide', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock, { level: 15, glyph: '👑' })
    await $.session.start(start)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    const { all } = await band($)
    expect(all).toContain('👑 Lv 15')
    expect(glyphSlot('⚔')).toBe('⚔ ')
    expect(cellsOf(glyphSlot('🛡️'))).toBe(2)
    expect(cellsOf(glyphSlot('⚔'))).toBe(2)
  })

  test('sets the XP bar alone on its row under a gap, as wide as the band leaves inside its margins, without the streak', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock, { level: 1 })
    await $.session.start(start)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: bandOf() })
    const barRow = await ui.find({ type: 'Text', text: /^[▰▱]+ 30\/203 xp$/ })
    expect(cellsOf(barRow?.text ?? '')).toBe(bandOf().bodyColumns - 4)
    expect(await ui.find({ type: 'Text', text: /^ $/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Box' })).filter((box) => box.props['paddingX'] === 2)).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /🔥/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('celebrations', () => {
  test('a common drop spins a coin beside its name for about a second, in the band as it is', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(drop('common', 'Plain Cap', 10))
    const playing = await band($)
    expect(playing.all).toMatch(/[◐◓◑◒] Plain Cap/)
    expect(playing.grown).toBe(0)
    await clock.advance(1_200)
    expect((await band($)).all).not.toContain('Plain Cap')
  })

  test('an XP gain runs a glint along the bar and twinkles at its head', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(xpGranted(20))
    expect((await band($)).all).toMatch(/▰✦▱/)
    await clock.advance(1_100)
    expect((await band($)).all).not.toMatch(/[✦✧·]▱/)
  })

  test('a rare drop grows the band by a few rows while a chest opens on its name, then shrinks back', async ($, on) => {
    const { clock, send, played } = await streaming($, on)
    await send(drop('rare', 'Wizard Hat', 70))
    const closed = await band($)
    expect(closed.grown).toBe(4)
    expect(closed.all).toContain('R A R E   D R O P')
    expect(closed.all).not.toContain('Wizard Hat ✦')
    await clock.advance(1_500)
    expect((await band($)).all).toContain('✦ Wizard Hat')
    await clock.advance(600)
    expect((await band($)).grown).toBe(0)
    expect(played).toEqual([])
  })

  test('epic and legendary drops take the band up to its height with a burst and a chime, legendary bigger and longer', async ($, on) => {
    const { clock, send, played } = await streaming($, on)
    await send(drop('epic', 'Pixel Dragon', 175))
    const epic = await band($, 30)
    expect(epic.grown).toBe(8)
    expect((await band($, 7)).grown).toBe(3)
    await clock.advance(700)
    expect((await band($)).all).toContain('Pixel Dragon')
    expect(played).toEqual(['audio/wav'])
    await clock.advance(2_600)
    expect((await band($)).grown).toBe(0)
    await send(drop('legendary', 'Aurora Crown', 400))
    expect((await band($, 30)).grown).toBe(11)
    await clock.advance(700)
    expect((await band($)).all).toContain('L E G E N D A R Y')
    // Past where an epic would have ended, a legendary still plays.
    await clock.advance(3_000)
    expect((await band($)).all).toContain('Aurora Crown  ✦')
    await clock.advance(1_200)
    expect((await band($)).grown).toBe(0)
    expect(played).toEqual(['audio/wav', 'audio/wav'])
  })

  test('a level-up shows the new level and its glyph: a banner for rare, the whole band for a new title', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(levelUp(4, 5, 'rare'))
    const rising = await band($)
    expect(rising.grown).toBe(4)
    expect(rising.all).toContain('🗡️')
    await clock.advance(700)
    expect((await band($)).all).toContain('Lv 5')
    await clock.advance(2_000)
    await send(levelUp(9, 10, 'epic', { title: 'Adept', glyph: '🛡️' }))
    await clock.advance(1_200)
    const titled = await band($)
    expect(titled.grown).toBe(8)
    expect(titled.all).toContain('🛡️ Level 10 🛡️')
    expect(titled.all).toContain('You are now an Adept')
  })

  test('several at once play one after another, the biggest last, never two at a time', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(drop('legendary', 'Aurora Crown'), drop('common', 'Plain Cap'), drop('rare', 'Wizard Hat'))
    const names = ['Plain Cap', 'Wizard Hat', 'Aurora Crown']
    expect(await watch($, clock, 10_000, names)).toEqual(names)
  })

  test('a backlog of small drops collapses into one, counting the rest', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(
      drop('common', 'Plain Cap'),
      drop('common', 'Paper Scarf'),
      drop('uncommon', 'Knit Scarf'),
      drop('common', 'Trail Mix'),
    )
    const names = ['Plain Cap', 'Paper Scarf', 'Knit Scarf', 'Trail Mix']
    const playing = await band($)
    expect(playing.all).toContain('Knit Scarf ')
    expect(playing.all).toContain('+3 more')
    expect(await watch($, clock, 3_000, names.filter((name) => name !== 'Knit Scarf'))).toEqual([])
  })

  test('one that arrives during a turn waits for the idle prompt, and one playing when a turn starts plays again after', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await send(drop('rare', 'Wizard Hat'))
    await clock.advance(3_000)
    expect((await band($)).grown).toBe(0)
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(700)
    expect((await band($)).grown).toBe(4)
    await $.turn.start({ text: 'and the tests', turnId: 't2' })
    expect((await band($)).grown).toBe(0)
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.advance(700)
    const again = await band($)
    expect(again.grown).toBe(4)
    expect(again.all).not.toContain('Wizard Hat ✦')
  })

  test("a subagent's turn holds nothing", async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(drop('rare', 'Wizard Hat'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-1' })
    await clock.advance(200)
    expect((await band($)).grown).toBe(4)
  })

  test('off plays nothing and only names the drop', { options: { animations: 'off' } }, async ($, on) => {
    const { clock, send, played } = await streaming($, on)
    await send(drop('legendary', 'Aurora Crown'), xpGranted(20))
    for (let at = 0; at < 4_000; at += 500) {
      const { all, grown } = await band($)
      expect(grown).toBe(0)
      expect(all).not.toContain('L E G E N D A R Y')
      expect(all).not.toMatch(/[✦✧·]▱/)
      await clock.advance(500)
    }
    expect(played).toEqual([])
  })

  test('reduced shows one still frame in the band as it is, with no sound', { options: { animations: 'reduced' } }, async ($, on) => {
    const { clock, send, played } = await streaming($, on)
    await send(drop('epic', 'Pixel Dragon'))
    const still = await band($)
    expect(still.grown).toBe(0)
    expect(still.all).toContain('✦ Pixel Dragon ✦')
    await clock.advance(1_000)
    expect((await band($)).all).toContain('✦ Pixel Dragon ✦')
    await clock.advance(1_700)
    expect((await band($)).all).not.toContain('✦ Pixel Dragon ✦')
    expect(played).toEqual([])
  })

  test('a reload mid-celebration takes its frame down, then plays it again from its first frame', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(drop('rare', 'Wizard Hat'))
    await clock.advance(1_500)
    expect((await band($)).all).toContain('✦ Wizard Hat')
    await $.session.start(start)
    await clock.settle()
    expect((await band($)).grown).toBe(0)
    await clock.advance(700)
    const again = await band($)
    expect(again.grown).toBe(4)
    expect(again.all).not.toContain('Wizard Hat ✦')
    await clock.advance(2_200)
    expect((await band($)).grown).toBe(0)
  })

  test('a level-up in a band with no rows to spare still moves, in the place of the gain', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(levelUp(0, 1, 'rare', { glyph: '⚔' }))
    // Past the bar's fill and flash, the level's own place keeps moving.
    await clock.advance(900)
    const frames = new Set<string>()
    for (let at = 0; at < 900; at += 170) {
      const { all, grown } = await band($, 6)
      expect(grown).toBe(0)
      for (const text of all.split('\n')) if (text.includes('Level')) frames.add(text)
      await clock.advance(170)
    }
    expect(frames.size).toBeGreaterThan(3)
  })

  test('a level-up, its drop and the XP that brought it, all mid-turn, each play moving after the turn, then leave', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await send(xpGranted(20), levelUp(0, 1, 'rare', { glyph: '⚔' }), drop('common', 'Plain Cap', 10))
    await clock.advance(3_000)
    expect((await band($)).grown).toBe(0)
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    const seen: Record<'xp' | 'coin' | 'level', Set<string>> = { xp: new Set(), coin: new Set(), level: new Set() }
    for (let at = 0; at < 6_000; at += 100) {
      const { all, grown } = await band($)
      if (/[✦✧·]▱/.test(all)) seen.xp.add(all)
      if (/[◐◓◑◒] Plain Cap/.test(all)) seen.coin.add(all)
      if (grown === 4 && all.includes('L E V E L')) seen.level.add(all)
      await clock.advance(100)
    }
    expect([seen.xp.size, seen.coin.size].every((size) => size > 1)).toBe(true)
    expect(seen.level.size).toBeGreaterThan(5)
    const after = await band($)
    expect(after.grown).toBe(0)
    expect(after.all).not.toMatch(/L E V E L|[◐◓◑◒]/)
  })
})

// Band styles as the server sends them: a still bar, and a gold whose icon glints in a loop.
const styleItem = (id: string, name: string, rarity: string, slot: string, look: unknown) => ({
  id,
  name,
  rarity,
  category: 'bandStyle',
  slot,
  sprite: null,
  lore: null,
  effect: null,
  look,
})
const solidBar = styleItem('solid-bar', 'Solid Bar', 'common', 'xpBar', {
  glyphs: { full: '█', empty: '░' },
  colors: { full: '#87d787', empty: '#4e4e4e' },
  frames: null,
  fps: null,
})
const glintingGold = styleItem('dragons-hoard', "Dragon's Hoard", 'legendary', 'goldDisplay', {
  glyphs: { icon: '◈', spark: '✧' },
  colors: { icon: '#ffb627', amount: '#ffd23f' },
  frames: [{ glyphs: { icon: '◆' } }, { glyphs: { icon: '✦', spark: '✦' } }, { glyphs: { spark: '⋆' } }],
  fps: 6,
})
const starlitEdge = styleItem('starlit-edge', 'Starlit Edge', 'epic', 'topEdge', {
  glyphs: { star: '✧' },
  colors: { line: '#5a4a78' },
  frames: [{ marks: [{ at: 0.5, glyph: '✦', color: '#ffffff' }] }, { marks: [{ at: 0.8, glyph: '⋆', color: '#ffffff' }] }],
  fps: 5,
})
const ownedOf = (equipped: Record<string, string> = {}): Owned => ({
  inventory: [
    { id: '01K6ZQ8W3J0000000000009001', itemId: 'solid-bar' },
    { id: '01K6ZQ8W3J0000000000009002', itemId: 'dragons-hoard' },
    { id: '01K6ZQ8W3J0000000000009003', itemId: 'starlit-edge' },
    { id: '01K6ZQ8W3J0000000000009004', itemId: 'plain-cap' },
  ],
  items: [
    solidBar,
    glintingGold,
    starlitEdge,
    { id: 'plain-cap', name: 'Plain Cap', rarity: 'common', category: 'wearable', slot: 'head', sprite: null, lore: null, effect: null, look: null },
  ],
  equipped,
})
const wearing = { xpBar: '01K6ZQ8W3J0000000000009001', goldDisplay: '01K6ZQ8W3J0000000000009002' }

/** The texts the band draws over `ms`, sampled each `every` ms. */
const samples = async ($: Parameters<TestBody>[0], clock: Clock, ms: number, every = 170) => {
  const seen: Array<string> = []
  for (let at = 0; at < ms; at += every) {
    seen.push((await band($)).all)
    await clock.advance(every)
  }
  return seen
}

// Two loops at once at different rates: a 6 fps bar and a 4 fps gold, each frame of the gold a different icon.
const sixFpsBar = styleItem('six-bar', 'Six Bar', 'epic', 'xpBar', {
  glyphs: { head: '✦' },
  colors: { full: '#9d4edd' },
  frames: [{ glyphs: { head: '✦' } }, { glyphs: { head: '✧' } }],
  fps: 6,
})
const fourFpsGold = styleItem('four-gold', 'Four Gold', 'legendary', 'goldDisplay', {
  glyphs: { icon: '◈' },
  colors: { icon: '#ffb627' },
  frames: [{ glyphs: { icon: '◈' } }, { glyphs: { icon: '◆' } }, { glyphs: { icon: '◇' } }, { glyphs: { icon: '●' } }],
  fps: 4,
})
const twoRates = (): Owned => ({
  inventory: [
    { id: '01K6ZQ8W3J0000000000009011', itemId: 'six-bar' },
    { id: '01K6ZQ8W3J0000000000009012', itemId: 'four-gold' },
  ],
  items: [sixFpsBar, fourFpsGold],
  equipped: { xpBar: '01K6ZQ8W3J0000000000009011', goldDisplay: '01K6ZQ8W3J0000000000009012' },
})

/** The clock times, sampled every `every` ms over `ms`, at which `pick` of the band's text changed. */
const changes = async ($: Parameters<TestBody>[0], clock: Clock, ms: number, every: number, pick: (all: string) => string) => {
  const times: Array<number> = []
  let last = pick((await band($)).all)
  for (let at = every; at <= ms; at += every) {
    await clock.advance(every)
    const now = pick((await band($)).all)
    if (now !== last) times.push(at)
    last = now
  }
  return times
}

describe('loop timing', () => {
  test('a 4 fps look worn beside a 6 fps one steps every 250 ms, not 167 and 333 by turns', async ($, on) => {
    const { clock } = await streaming($, on, twoRates())
    const icon = (all: string) => /([◈◆◇●]) 25/.exec(all)?.[1] ?? ''
    const times = await changes($, clock, 3_000, 25, icon)
    const gaps = times.slice(1).map((at, i) => at - (times[i] ?? 0))
    expect(gaps.length).toBeGreaterThan(8)
    for (const gap of gaps) expect(Math.abs(gap - 250)).toBeLessThanOrEqual(25)
  })
})

const view = (intoLevel: number, forNextLevel = 100): BandView => ({
  name: 'Player',
  level: 4,
  title: 'Apprentice',
  glyph: '⚔',
  xp: { total: 400 + intoLevel, intoLevel, forNextLevel },
  gold: 25,
  isDev: false,
  pet: null,
})
const arcane: BandLook = {
  glyphs: { full: '▰', empty: '▱', head: '✦' },
  colors: { full: '#9d4edd', empty: '#3c2a4d' },
  frames: [{ glyphs: { head: '✦' } }, { glyphs: { head: '✧' } }],
  fps: 6,
  sheen: { colors: ['#7b2cbf', '#c77dff', '#e0aaff', '#ffffff'], rest: 6 },
}
/** Where the sheen's white head is in the bar's cells at each frame, over `frames` frames. */
const heads = (look: BandLook, intoLevel: number, frames: number) =>
  Array.from({ length: frames }, (_, tick) => {
    const { cells, from } = barCells(view(intoLevel), 120, look, { ticks: { '6': tick } })
    const at = cells.findIndex((cell) => cell.color === '#ffffff')
    return at < 0 ? null : at - from
  })

describe('review fixes: loop clocks', () => {
  test('a reload with no loop to run leaves no frame of the last copy standing: the pane draws its previews still', async ($, on) => {
    // Owned, not worn: only the open pane's previews loop.
    const { clock } = await streaming($, on, ownedOf())
    const previews = async () => (await paneTexts($, 72)).texts.join('\n')
    const still = await previews()
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    await clock.advance(500)
    expect(await previews()).not.toBe(still)
    // The fresh copy finds no pane open, so no clock runs, and the loops' frames from before must go.
    await $.session.start(start)
    await clock.settle()
    expect(await previews()).toBe(still)
  })
})

describe('the sheen', () => {
  test('travels one cell a frame along a short fill, two along a long one, then rests', () => {
    const short = heads(arcane, 10, 24)
    // 11 cells filled: the head runs 0..12 as the tail follows it out, one cell a frame, then 6 frames of rest.
    expect(short.slice(0, 11)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(short.slice(14, 20)).toEqual([null, null, null, null, null, null])
    // 99 cells filled: two a frame, the whole pass within 51 frames.
    const long = heads(arcane, 90, 51).flatMap((at) => (at === null ? [] : [at]))
    expect(long.at(-1)).toBe(98)
    const steps = long.slice(1).map((at, i) => at - (long[i] ?? 0))
    expect(steps.every((step) => step > 0 && step <= 2)).toBe(true)
  })

  test('is a gradient of the look\'s colors, the head bold, inside the budget, and never on the bar still to fill', () => {
    for (let tick = 0; tick < 30; tick++) {
      const { cells, from, filled } = barCells(view(30), 120, arcane, { ticks: { '6': tick } })
      const lit = cells.filter((cell) => arcane.sheen?.colors.includes(cell.color ?? '') && cell.color !== '#9d4edd')
      expect(lit.length).toBeLessThanOrEqual(4)
      expect(lit.filter((cell) => cell.bold === true).every((cell) => cell.color === '#ffffff')).toBe(true)
      const at = cells.findIndex((cell) => cell.color === '#ffffff')
      if (at >= 0) expect(at - from).toBeLessThan(filled)
    }
    // 33 cells filled, so two a frame: at frame 5 the head is on cell 10, its tail behind it.
    const { cells } = barCells(view(30), 120, arcane, { ticks: { '6': 5 } })
    expect(cells.slice(7, 11).map((cell) => cell.color)).toEqual(arcane.sheen?.colors)
    expect(sheenHead(0, 0, 4, 0)).toBeNull()
  })

  test('rests with the loops: a still band draws no sheen', () => {
    const { cells } = barCells(view(30), 120, arcane, null)
    expect(cells.some((cell) => cell.color === '#ffffff')).toBe(false)
  })

  test("an XP gain's glint is a soft run, dim to white, that never hops more than three cells", () => {
    const celebration: Celebration = { kind: 'xp', amount: 10 }
    const glintAt = (tick: number) => {
      const row = barRow(view(40), 120, { celebration, tick, seed: 1, motion: 'full', load: 1 })
      // The glint's white head as a cell along the row, not a run: the tail's runs come and go around it.
      const run = row.findIndex((one) => one.color === '#ffffff' && one.text.length === 1)
      return run < 0 ? -1 : row.slice(0, run).reduce((cells, one) => cells + cellsOf(one.text), 0)
    }
    const at = [0, 1, 2, 3, 4].map(glintAt).filter((one) => one >= 0)
    expect(at.length).toBeGreaterThan(2)
    const hops = at.slice(1).map((one, i) => one - (at[i] ?? 0))
    expect(hops.every((hop) => hop > 0 && hop <= 3)).toBe(true)
    const runs = barRow(view(40), 120, { celebration, tick: 2, seed: 1, motion: 'full', load: 1 })
    expect(new Set(runs.map((run) => run.color)).size).toBeGreaterThanOrEqual(5)
  })
})

describe('band styles', () => {
  test('the band wears the equipped looks: a still one as it is, a looping one moving', async ($, on) => {
    const { clock } = await streaming($, on, ownedOf(wearing))
    const { all } = await band($)
    expect(all).toMatch(/^█+░+ 30\/203 xp$/m)
    expect(all).toMatch(/[◈◆✦] 25/)
    // Six frames a second at most: the glint moves on within a frame or two, never every few milliseconds.
    const seen = await samples($, clock, 1_000)
    expect(new Set(seen).size).toBeGreaterThan(1)
    expect(new Set(await samples($, clock, 160, 40)).size).toBeLessThanOrEqual(2)
  })

  test('the loops rest through a main-loop turn, drawing the still look, and move again after it', async ($, on) => {
    const { clock } = await streaming($, on, ownedOf(wearing))
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    const resting = await samples($, clock, 1_000)
    expect(new Set(resting).size).toBe(1)
    expect(resting[0]).toContain('◈ 25 ✧')
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(new Set(await samples($, clock, 1_000)).size).toBeGreaterThan(1)
  })

  for (const animations of ['reduced', 'off']) {
    test(`${animations} draws every look still`, { options: { animations } }, async ($, on) => {
      const { clock } = await streaming($, on, ownedOf({ ...wearing, topEdge: '01K6ZQ8W3J0000000000009003' }))
      const seen = await samples($, clock, 1_200)
      expect(new Set(seen).size).toBe(1)
      expect(seen[0]).toContain('◈ 25 ✧')
      expect(seen[0]).toContain('✧ PATH OF DEV ✧')
    })
  }

  test('the loops keep moving after a /clear starts the session again', async ($, on) => {
    const { clock, sent } = await streaming($, on, ownedOf(wearing))
    const opened = () => sent.filter((one) => one.path === '/v1/sessions').length
    await $.session.end({ reason: 'clear', sessionId: 'first', resume: { id: 'first' } })
    await until(clock, () => opened() === 2)
    expect(new Set(await samples($, clock, 1_000)).size).toBeGreaterThan(1)
  })

  test('an edge look keeps the band exactly as wide as its body, marks and all', async ($, on) => {
    const { clock } = await streaming($, on, ownedOf({ topEdge: '01K6ZQ8W3J0000000000009003' }))
    for (let at = 0; at < 600; at += 200) {
      const edge = (await band($)).all.split('\n').find((text) => text.includes('PATH OF DEV')) ?? ''
      expect(cellsOf(edge)).toBe(bandOf().bodyColumns)
      await clock.advance(200)
    }
  })
})

const paneProps = (): RenderPropsOf['Pane'] => ({
  title: 'Path of Dev',
  isFocused: true,
  bodyColumns: 72,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

describe('the /pathofdev pane', () => {
  test('registers /pathofdev, which opens the pane on its inventory', async ($, on) => {
    const { registered, opened } = await streaming($, on, ownedOf(wearing))
    expect(registered).toEqual(['pathofdev', 'questline', 'pet'])
    const answer = await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    expect(answer.text).toBe('Path of Dev pane opened.')
    expect(opened).toEqual(['questline'])
    for (const surface of surfaces) {
      const ui = await $.ui.mount({ plugin: 'questline', surface, component: 'Pane', requestId: 'questline', props: paneProps() })
      const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text).join('\n')
      for (const shown of ['◆ Inventory', 'XP bar', 'Top edge', 'Solid Bar', 'Starlit Edge', 'Plain Cap']) {
        expect(texts).toContain(shown)
      }
      // The Shop, Stats and Missions are built: tabs to switch to, none still to come.
      expect(await ui.find({ type: 'Button', key: 'tab:shop' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'tab:stats' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'tab:missions' })).toBeDefined()
      expect(texts).not.toContain('soon')
      // Each look's preview is drawn by the band's own code, the still one exactly as the band would.
      expect(texts).toMatch(/^█+░+ 30\/203 xp$/m)
      expect(await ui.find({ type: 'Button', key: 'equip:topEdge:starlit-edge' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'unequip:xpBar' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Equip sends the command and the band wears it at once; Unequip puts the band back', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf())
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: paneProps() })
    expect((await band($)).all).toMatch(/^▰+▱+ 30\/203 xp$/m)
    await ui.press({ key: 'equip:xpBar:solid-bar' })
    const commands = sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)
    expect(commands).toMatchObject([{ type: 'item.equip', data: { entryId: '01K6ZQ8W3J0000000000009001', slot: 'xpBar' } }])
    expect((await band($)).all).toMatch(/^█+░+ 30\/203 xp$/m)
    await ui.press({ key: 'unequip:xpBar' })
    expect(sent.filter((one) => one.path === '/v1/commands').at(-1)?.body).toMatchObject({ type: 'item.unequip', data: { slot: 'xpBar' } })
    expect((await band($)).all).toMatch(/^▰+▱+ 30\/203 xp$/m)
    await ui.unmount()
  })
})

describe('review fixes: the pane', () => {
  test('an equipped style the snapshot no longer names still shows, and can be taken off', async ($, on) => {
    const owned = ownedOf({ xpBar: '01K6ZQ8W3J0000000000009009' })
    const { sent } = await streaming($, on, owned)
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    const props = paneProps()
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props })
    expect((await ui.findAll({ type: 'Text' })).map((one) => one.text).join('\n')).toContain('Unknown style')
    await ui.press({ key: 'unequip:xpBar' })
    expect(sent.filter((one) => one.path === '/v1/commands').at(-1)?.body).toMatchObject({ type: 'item.unequip' })
    await ui.unmount()
  })
})

const grant = (amount: number, reason: string, more: Record<string, unknown> = {}) =>
  serverEvent('xp.granted', { amount, tier: 'reported', reason, totalAfter: 150, ...more })
const goldChanged = (delta: number, reason = 'drop') => serverEvent('gold.changed', { delta, totalAfter: 25 + delta, reason })
/** The gain's line at the end of the band, if one shows. */
const gainLine = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: bandOf() })
  const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
  await ui.unmount()
  return texts.find((text) => / · |!$/.test(text) && !text.includes('PATH OF DEV')) ?? null
}

describe('the gain line', () => {
  test('names every reason in words, and a graded prompt by the grade the server priced it at', async ($, on) => {
    const { send } = await streaming($, on)
    const events = [
      grant(9, 'prompt.graded', { grade: 4.66 }),
      grant(9, 'prompt.graded'),
      grant(10, 'streak.day'),
      grant(15, 'commit.made'),
      grant(20, 'tests.green'),
      grant(30, 'change.opened'),
      grant(120, 'change.merged'),
      grant(40, 'issue.closed'),
      grant(25, 'repo.explored'),
      grant(50, 'review.acted_on'),
      grant(60, 'bug.fixed'),
      grant(80, 'first.contribution'),
      grant(500, 'dev'),
      grant(50, 'quest'),
      grant(5, 'future.side_quest'),
      serverEvent('xp.capped', { eventType: 'commit.made', cap: 20 }),
      goldChanged(10),
      goldChanged(-5, 'dev'),
      goldChanged(30, 'quest'),
      drop('uncommon', 'Knit Scarf', 10),
      levelUp(1, 2, 'rare'),
    ]
    const lines: Array<string | null> = []
    for (const event of events) {
      await send(event)
      lines.push(await gainLine($))
    }
    expect(lines).toEqual([
      '+9 XP · prompt graded 4.7',
      '+9 XP · prompt graded',
      '+10 XP · daily streak',
      '+15 XP · commit',
      '+20 XP · tests back to green',
      '+30 XP · pull request opened',
      '+120 XP · pull request merged',
      '+40 XP · issue closed',
      '+25 XP · new repo explored',
      '+50 XP · review acted on',
      '+60 XP · bug fixed',
      '+80 XP · first contribution',
      '+500 XP · dev grant',
      '+50 XP · mission reward',
      '+5 XP · future side quest',
      'commit · daily XP cap reached',
      '+10 gold · loot',
      '−5 gold · dev grant',
      '+30 gold · mission reward',
      'Knit Scarf · uncommon',
      'Level 2!',
    ])
  })

  test("names a batch's biggest moment, and fades a minute after it came", async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(...causedBy('01K6ZQ8W3J0000000000000C01', grant(9, 'prompt.graded', { grade: 4.7 }), drop('uncommon', 'Knit Scarf', 10), goldChanged(10)))
    expect(await gainLine($)).toBe('Knit Scarf · uncommon')
    await send(grant(10, 'streak.day'))
    expect(await gainLine($)).toBe('+10 XP · daily streak')
    await clock.advance(59_000)
    expect(await gainLine($)).toBe('+10 XP · daily streak')
    await clock.advance(1_500)
    expect(await gainLine($)).toBeNull()
  })

  test('a newer line restarts the minute', async ($, on) => {
    const { clock, send } = await streaming($, on)
    await send(grant(10, 'streak.day'))
    await clock.advance(40_000)
    await send(grant(15, 'commit.made'))
    await clock.advance(40_000)
    expect(await gainLine($)).toBe('+15 XP · commit')
    await clock.advance(21_000)
    expect(await gainLine($)).toBeNull()
  })
})

describe('reward toasts', () => {
  test('one toast per cause, summing what it earned, level-ups and drops included', async ($, on) => {
    const { send, toasts } = await streaming($, on)
    await send(
      ...causedBy('01K6ZQ8W3J0000000000000C01', grant(9, 'prompt.graded', { grade: 4.7 }), drop('uncommon', 'Knit Scarf', 10), goldChanged(10)),
      ...causedBy('01K6ZQ8W3J0000000000000C02', grant(10, 'streak.day'), serverEvent('streak.changed', { days: 3, restDaysLeftThisWeek: 1 }), grant(15, 'commit.made')),
      ...causedBy('01K6ZQ8W3J0000000000000C03', grant(120, 'change.merged'), levelUp(4, 5, 'epic', { title: 'Journeyman' }), drop('rare', 'Wizard Hat', 70), goldChanged(70)),
      ...causedBy('01K6ZQ8W3J0000000000000C04', serverEvent('xp.capped', { eventType: 'commit.made', cap: 20 })),
    )
    expect(toasts).toEqual([
      '+9 XP · Knit Scarf (uncommon) · +10 gold',
      '+25 XP',
      '+120 XP · Level 5! New title: Journeyman · Wizard Hat (rare) · +70 gold',
    ])
  })

  test('counts the drops past the first few', async ($, on) => {
    const { send, toasts } = await streaming($, on)
    const names = ['Plain Cap', 'Paper Scarf', 'Trail Mix', 'Knit Scarf', 'Bead String']
    await send(...causedBy('01K6ZQ8W3J0000000000000C01', ...names.map((name) => drop('common', name))))
    expect(toasts).toEqual(['Plain Cap (common) · Paper Scarf (common) · 3 more items'])
  })

  test('off sends none, and the band still celebrates', { options: { toasts: false } }, async ($, on) => {
    const { send, toasts } = await streaming($, on)
    await send(...causedBy('01K6ZQ8W3J0000000000000C01', drop('common', 'Plain Cap', 10), goldChanged(10)))
    expect((await band($)).all).toMatch(/[◐◓◑◒] Plain Cap/)
    expect(toasts).toEqual([])
  })
})

/** The pane's texts at `columns` across its body. */
const paneTexts = async ($: Parameters<TestBody>[0], bodyColumns: number) => {
  const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: { ...paneProps(), bodyColumns } })
  const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
  const tabs = await ui.find({ type: 'Box', key: 'tabs' })
  await ui.unmount()
  return { texts, tabs }
}

describe('the pane fits its width', () => {
  test('a narrow pane drops the name, then closes the tabs up and shortens them, so neither row wraps', async ($, on) => {
    await streaming($, on, ownedOf())
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    const headerAt = async (columns: number) =>
      (await paneTexts($, columns)).texts.find((text) => text.startsWith('✦ PATH OF DEV ✦')) ?? ''
    expect(await headerAt(42)).toBe('✦ PATH OF DEV ✦  Lv 4 Apprentice · ◈ 25')
    const narrow = await paneTexts($, 40)
    const header = narrow.texts.find((text) => text.startsWith('✦ PATH OF DEV ✦')) ?? ''
    expect(header).toBe('✦ PATH OF DEV ✦  Lv 4 · ◈ 25')
    expect(cellsOf(header)).toBeLessThanOrEqual(38)
    // All four tabs still fit at 40 with their names, the gaps closed up.
    expect(narrow.texts).toContain('◆ Inventory')
    expect(narrow.tabs?.props['columnGap']).toBe(1)
    expect(narrow.tabs?.props['flexWrap']).toBeUndefined()
    const narrower = await paneTexts($, 30)
    expect(narrower.texts).toContain('Items')
    expect(narrower.tabs?.props['columnGap']).toBe(1)

    const wide = await paneTexts($, 120)
    expect(wide.texts).toContain('✦ PATH OF DEV ✦  Player · Lv 4 Apprentice · ◈ 25')
    expect(wide.tabs?.props['columnGap']).toBe(3)
  })

  test('the tab bar and the header give way in steps, and always fit', () => {
    const widthOf = (bar: ReturnType<typeof tabBarOf>) =>
      bar.chips.reduce((sum, chip) => sum + cellsOf(chip.text) + (chip.soon ? 5 : 0), 0) + bar.gap * (bar.chips.length - 1)
    for (const columns of [20, 28, 32, 38, 44, 60]) expect(widthOf(tabBarOf('inventory', columns))).toBeLessThanOrEqual(Math.max(columns, 11))
    expect(tabBarOf('inventory', 60)).toMatchObject({
      gap: 3,
      chips: [
        { kind: 'shown' },
        { kind: 'ready' },
        { kind: 'ready' },
        { kind: 'ready', soon: false },
        { kind: 'ready' },
      ],
    })
    expect(tabBarOf('stats', 60).chips.map((chip) => chip.kind)).toEqual(['ready', 'ready', 'shown', 'ready', 'ready'])
    // The welcome, opened rarely, shrinks to its mark and then goes before any other tab gives way, unless it is shown.
    expect(tabBarOf('inventory', 60).chips.map((chip) => chip.text).at(-1)).toBe('◇ Welcome')
    expect(tabBarOf('inventory', 39).chips.map((chip) => chip.text)).toEqual([
      '◆ Inventory',
      '◇ Shop',
      '◇ Stats',
      '◇ Missions',
      '?',
    ])
    const shut = tabBarOf('inventory', 38).chips.map((chip) => chip.text)
    expect(shut).toEqual(['◆ Inventory', '◇ Shop', '◇ Stats', '◇ Missions'])
    expect(tabBarOf('welcome', 24).chips.map((chip) => chip.text)).toEqual(['Inv', 'Shop', 'Stats', 'Quest', 'Hi'])
    expect(tabBarOf('missions', 34).chips.map((chip) => chip.text)).toEqual(['◇ Items', '◇ Shop', '◇ Stats', '◆ Missions'])
    expect(tabBarOf('missions', 28).chips.map((chip) => chip.text)).toEqual(['Items', 'Shop', 'Stats', 'Missions'])
    expect(tabBarOf('inventory', 20).chips.map((chip) => chip.text)).toEqual(['Inv', 'Shop', 'Stats', 'Quest'])
    const view = { name: 'Player', level: 12, title: 'Adept', gold: 1500 }
    expect(headerOf(view, 80)).toBe('Player · Lv 12 Adept · ◈ 1500')
    expect(headerOf(view, 32)).toBe('Lv 12 · ◈ 1500')
    expect(headerOf(view, 30)).toBe('Lv 12')
    expect(headerOf(view, 10)).toBe('')
  })
})

describe('dev mode', () => {
  const run = ($: Parameters<TestBody>[0], args: string) => $.command.run({ command: 'pathofdev', args, origin: composer, presentation })
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)

  test('needs a dev server: on the real one it sends nothing and shows no dev controls', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf())
    expect((await run($, 'dev xp 50')).text).toContain('PATHOFDEV_DEV=1 pnpm --filter @pathofdev/server start')
    expect((await run($, 'dev celebrate rare')).text).toContain('needs the dev server')
    expect(commandsOf(sent)).toEqual([])
    expect((await band($)).grown).toBe(0)
    expect((await paneTexts($, 72)).texts).not.toContain('Dev')
  })

  test('sends each dev command to a dev server, and answers a bad one with the usage', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf(), true)
    for (const args of ['dev styles', 'dev item wizard-hat', 'dev xp 500', 'dev gold 7']) expect((await run($, args)).text).toBe('Done.')
    expect(commandsOf(sent)).toMatchObject([
      { type: 'dev.grantStyles', data: {} },
      { type: 'dev.grantItem', data: { itemId: 'wizard-hat' } },
      { type: 'dev.grantXp', data: { amount: 500 } },
      { type: 'dev.setGold', data: { gold: 7 } },
    ])
    for (const args of ['dev', 'dev xp', 'dev xp 0', 'dev xp lots', 'dev gold -1', 'dev celebrate huge', 'dev item', 'dev styles now']) {
      expect((await run($, args)).text).toMatch(/^Dev mode: \/pathofdev dev styles/)
    }
    expect(commandsOf(sent)).toHaveLength(4)
  })

  test('celebrate plays a preview in the band, with its toast, and sends nothing', async ($, on) => {
    const { sent, toasts, clock } = await streaming($, on, ownedOf(), true)
    expect((await run($, 'dev celebrate rare')).text).toBe('Playing a rare preview.')
    await clock.advance(100)
    const playing = await band($)
    expect(playing.grown).toBe(4)
    expect(playing.all).toContain('R A R E   D R O P')
    expect(toasts).toEqual(['Rare Preview (rare)'])
    expect(commandsOf(sent)).toEqual([])
  })

  test('the pane shows the dev controls on a dev server, and they send the same commands', async ($, on) => {
    const { sent, clock } = await streaming($, on, ownedOf(), true)
    await run($, '')
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: paneProps() })
    expect((await ui.findAll({ type: 'Text' })).map((one) => one.text)).toContain('Dev')
    await ui.press({ key: 'dev:styles' })
    await ui.press({ key: 'dev:level' })
    await ui.press({ key: 'dev:celebrate:levelup' })
    await ui.unmount()
    await clock.settle()
    // 30 of 203 XP into level 4: 173 more reach level 5.
    expect(commandsOf(sent)).toMatchObject([{ type: 'dev.grantStyles' }, { type: 'dev.grantXp', data: { amount: 173 } }])
    expect((await band($)).all).toContain('L E V')
  })

  test('a dev command the server answers oddly says so, and leaves the band online', async ($, on) => {
    await streaming($, on, ownedOf(), true, { commandStatus: 500 })
    expect((await run($, 'dev xp 50')).text).toBe('The dev server answered something unexpected.')
    expect((await band($)).all).not.toContain('offline')
  })

  test('the server option points the mod at the dev socket', { options: { server: 'dev' } }, async ($, on) => {
    const { sockets } = await streaming($, on)
    expect([...sockets]).toEqual(['/home/player/.pathofdev-dev/server.sock'])
    expect(socketPathsOf(undefined, '/home/player')).toEqual([
      '/home/player/.pathofdev/server.sock',
      '/home/player/.questline/server.sock',
    ])
    expect(socketPathsOf(undefined, '/home/player', true)).toEqual([
      '/home/player/.pathofdev-dev/server.sock',
      '/home/player/.questline-dev/server.sock',
    ])
    expect(socketPathsOf('/tmp/pod', '/home/player', true)).toEqual(['/tmp/pod/server.sock'])
  })
})

describe('the rename from Questline', () => {
  const run = ($: Parameters<TestBody>[0], command: string, args: string) =>
    $.command.run({ command, args, origin: composer, presentation })

  test('plays on a server from before it in ~/.questline, then in ~/.pathofdev once it restarts', async ($, on) => {
    const listensOn = { at: '/home/player/.questline/server.sock' }
    const { answeredOn, clock } = await streaming($, on, ownedOf(), false, { listensOn })
    expect(answeredOn).toContain('/home/player/.questline/server.sock')
    expect((await band($)).all).not.toContain('offline')
    // The server restarts in its new home: the next poll finds it there, and every request after goes there.
    listensOn.at = '/home/player/.pathofdev/server.sock'
    const before = answeredOn.length
    await clock.advance(30_000)
    await until(clock, () => answeredOn.length > before)
    expect(answeredOn.slice(before).every((socket) => socket === '/home/player/.pathofdev/server.sock')).toBe(true)
    expect((await run($, 'pathofdev', '')).text).toBe('Path of Dev pane opened.')
    expect((await band($)).all).not.toContain('offline')
  })

  const homes: ReadonlyArray<[string, Record<string, string>, string]> = [
    ['QUESTLINE_HOME while PATHOFDEV_HOME is unset', { QUESTLINE_HOME: '/srv/old' }, '/srv/old/server.sock'],
    [
      'PATHOFDEV_HOME over QUESTLINE_HOME',
      { QUESTLINE_HOME: '/srv/old', PATHOFDEV_HOME: '/srv/new' },
      '/srv/new/server.sock',
    ],
  ]
  for (const [name, named, socket] of homes) {
    test(`reads ${name}`, async ($, on) => {
      const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
      mock.store(on)
      mock.env(on, { HOME: '/home/player', ...named })
      const { sockets, sent } = fakeServer(on, clock)
      await $.session.start(start)
      await until(clock, () => sent.some((one) => one.path === '/v1/sessions'))
      expect([...sockets]).toEqual([socket])
    })
  }

  test('names its version under both header names, so a server from before the rename still hears it', () => {
    expect(initOf('/home/player/.questline/server.sock').headers).toEqual({
      'content-type': 'application/json',
      'pathofdev-client': clientVersion,
      'questline-client': clientVersion,
    })
  })

  test('/questline does what /pathofdev does, and says once that it was renamed', async ($, on) => {
    const { opened, sent } = await streaming($, on, ownedOf())
    expect((await run($, 'questline', '')).text).toBe(`Path of Dev pane opened.\n${renamedNote}`)
    expect(opened).toEqual(['questline'])
    expect((await run($, 'questline', '')).text).toBe('Path of Dev pane opened.')
    expect((await run($, 'questline', 'dev xp 50')).text).toBe((await run($, 'pathofdev', 'dev xp 50')).text)
    expect(sent.filter((one) => one.path === '/v1/commands')).toEqual([])
  })
})

describe('the celebration queue', () => {
  const loot = (tier: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', name: string): Celebration => ({
    kind: 'loot',
    tier,
    name,
    gold: 0,
    more: 0,
  })

  test('orders by size, keeping arrival order among equals', () => {
    const queue = queueOf([loot('epic', 'a'), loot('rare', 'b'), { kind: 'xp', amount: 5 }, loot('rare', 'c')])
    expect(queue.map((one) => (one.kind === 'loot' ? one.name : one.kind))).toEqual(['xp', 'b', 'c', 'a'])
  })

  test('adds up XP gains, keeps the best small drop counting the rest, and lets the smallest big ones go past three', () => {
    const queue = queueOf([
      { kind: 'xp', amount: 5 },
      { kind: 'xp', amount: 7 },
      loot('uncommon', 'u'),
      loot('common', 'c'),
      loot('rare', 'r1'),
      loot('rare', 'r2'),
      loot('epic', 'e'),
      loot('legendary', 'l'),
    ])
    expect(queue).toEqual([
      { kind: 'xp', amount: 12 },
      { ...loot('uncommon', 'u'), more: 1 },
      loot('rare', 'r2'),
      loot('epic', 'e'),
      loot('legendary', 'l'),
    ])
    expect(joinQueue([loot('common', 'old')], loot('common', 'new'))).toEqual([{ ...loot('common', 'new'), more: 1 }])
  })
})

describe('reading the work', () => {
  test('names only GitHub remotes', () => {
    expect(githubName('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(githubName('https://github.com/acme/widgets')).toBe('acme/widgets')
    expect(githubName('ssh://git@github.com/acme/widgets.git\n')).toBe('acme/widgets')
    expect(githubName('git@gitlab.com:acme/widgets.git')).toBeNull()
    expect(githubName('git@work-alias:acme/widgets.git')).toBeNull()
  })

  test('finds the test runner, and trusts the exit code only without a pipe', () => {
    expect(testRunner('pnpm test')).toBe('npm')
    expect(testRunner('npx vitest run src')).toBe('vitest')
    expect(testRunner('go test ./...')).toBe('go')
    expect(testRunner('cargo nextest run')).toBe('cargo')
    expect(testRunner('git commit -m "test the parser"')).toBeNull()
    expect(exitIsTheRuns('pnpm test && echo ok')).toBe(true)
    expect(exitIsTheRuns('pnpm test 2>&1')).toBe(true)
    expect(exitIsTheRuns('pnpm test || true')).toBe(false)
    expect(exitIsTheRuns('pnpm test; echo done')).toBe(false)
    expect(exitIsTheRuns('pnpm test &')).toBe(false)
    expect(exitIsTheRuns('pnpm test | tail -5')).toBe(false)
  })

  test('keys a subject the same way every time under one secret', async () => {
    const secret = 'ab'.repeat(32)
    expect(await hmac(secret, 'repo|acme/widgets')).toBe(await hmac(secret, 'repo|acme/widgets'))
    expect(await hmac(secret, 'repo|acme/widgets')).not.toBe(await hmac('cd'.repeat(32), 'repo|acme/widgets'))
    expect(await hmac(secret, 'repo|acme/widgets')).toMatch(/^[0-9a-f]{64}$/)
  })
})

/** A player some way in: every stat counted, and a streak with a better one behind it. */
const playing: Counted = {
  streak: { days: 12, restDaysLeftThisWeek: 1, lastDay: '2026-10-09', best: 15 },
  stats: {
    clears: 8,
    compactions: { manual: 3, auto: 1 },
    commands: { '/code-review': 12, '/compact': 3, custom: 5, '/pr-watch:watch': 2, '/clear': 7, '/help': 1 },
    contextCrossed: { pct50: 12, pct75: 5, pct100: 1 },
    contextPeak: { lastSession: 62, average: 48.4 },
    prompts: { graded: 1420, gradedToday: 9, averageScore: 7.24, regretted: 71 },
    grades: {
      best: 9.571,
      dimensions: { clarity: 8.1, grammar: 7.4, specificity: 5.2, instructive: 6.6, context: 4.9, doneCriteria: 3.1, focus: 7.9 },
    },
  },
}

/** A new player's stats, as a server that counts them all sends them. */
const newPlayer: Counted = {
  streak: { days: 0, restDaysLeftThisWeek: 1, lastDay: '2026-10-09', best: 0 },
  stats: {
    clears: 0,
    compactions: { manual: 0, auto: 0 },
    commands: {},
    contextCrossed: { pct50: 0, pct75: 0, pct100: 0 },
    contextPeak: { lastSession: 0, average: 0 },
    prompts: { graded: 0, gradedToday: 0, averageScore: 0, regretted: 0 },
    grades: {
      best: 0,
      dimensions: { clarity: 0, grammar: 0, specificity: 0, instructive: 0, context: 0, doneCriteria: 0, focus: 0 },
    },
  },
}

/** Opens the pane and switches it to its Stats tab with the tab bar's button. */
const openStats = async ($: Parameters<TestBody>[0]) => {
  await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
  const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: paneProps() })
  await ui.press({ key: 'tab:stats' })
  await ui.unmount()
}

describe('the Stats tab', () => {
  test('switches from the tab bar and back, and draws every section from the snapshot', async ($, on) => {
    await streaming($, on, ownedOf(wearing), false, { counted: playing })
    await openStats($)
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: paneProps() })
    const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text).join('\n')
    expect(texts).toContain('◆ Stats')
    expect(texts).not.toContain('Band styles')
    for (const title of ['Progress', 'Streak', 'Prompts', 'Prompting profile', 'Context habits', 'Top commands']) {
      expect(texts).toMatch(new RegExp(`^${title} ─+$`, 'm'))
    }
    // Progress, the XP bar and gold in the styles worn.
    expect(texts).toMatch(/^ {2}⚔ {2}Lv 4 Apprentice$/m)
    expect(texts).toMatch(/^ {2}█+░+ 30\/203 xp$/m)
    expect(texts).toMatch(/^ {2}Total XP +130$/m)
    expect(texts).toMatch(/^ {2}├ reported +130$/m)
    expect(texts).toMatch(/^ {2}To Lv 5 +173 xp$/m)
    expect(texts).toMatch(/^ {2}Gold +◆ 25 [✧✦·]?$/m)
    expect(texts).toMatch(/^ {2}Items owned +4$/m)
    // The streak, which left the band for here.
    expect(texts).toMatch(/^ {2}🔥 Current +12 days$/m)
    expect(texts).toMatch(/^ {2}Best +15 days$/m)
    expect(texts).toMatch(/^ {2}Rest days left this week +1$/m)
    // Prompts, the grades as bars.
    expect(texts).toMatch(/^ {2}Graded +1,420$/m)
    expect(texts).toMatch(/^ {2}Today +9$/m)
    expect(texts).toMatch(/^ {2}Average grade +▰+▱+ 7\.2$/m)
    expect(texts).toMatch(/^ {2}Best grade +▰+▱+ 9\.6$/m)
    expect(texts).toMatch(/^ {2}Regretted +71 · 5%$/m)
    // The profile: a bar a quality score, the strongest and the weakest marked, and what to work on.
    expect(texts).toMatch(/^ {2}Clarity +▰+▱+ 8\.1 ▲$/m)
    expect(texts).toMatch(/^ {2}Done criteria +▰+▱+ 3\.1 ▼$/m)
    expect(texts).toMatch(/^ {2}Focus +▰+▱+ 7\.9 {2}$/m)
    expect(texts).toContain('▼ Work on done criteria: say how to know it is done')
    // Context habits.
    expect(texts).toMatch(/^ {2}Last session +▰+▱+ 62%$/m)
    expect(texts).toMatch(/^ {2}Average peak +▰+▱+ 48%$/m)
    expect(texts).toMatch(/^ {2}Sessions past 75% +5$/m)
    expect(texts).toMatch(/^ {2}Compactions +3 manual · 1 auto$/m)
    // The top five commands, most used first, the player's own under one name; the sixth is left out.
    const commands = texts.split('\n').filter((text) => /^ {2}(\/|your own)\S* +▰/.test(text))
    expect(commands.map((text) => text.trim().split(/ +/)[0])).toEqual(['/code-review', '/clear', 'your', '/compact', '/pr-watch:watch'])
    expect(texts).toMatch(/^ {2}\/code-review +▰+ +12$/m)
    expect(texts).not.toContain('/help')
    // An up-to-date server: no word about restarting it.
    expect(texts).not.toContain('Restart')

    await ui.press({ key: 'tab:inventory' })
    await ui.unmount()
    const back = (await paneTexts($, 72)).texts.join('\n')
    expect(back).toContain('◆ Inventory')
    expect(back).toContain('Band styles')
  })

  test('fits a 40-column pane with every number on the right edge, and sets two columns side by side on a wide one', async ($, on) => {
    await streaming($, on, ownedOf(wearing), false, { counted: playing })
    await openStats($)
    const narrow = await paneTexts($, 40)
    for (const text of narrow.texts) expect(cellsOf(text)).toBeLessThanOrEqual(38)
    for (const row of ['  Graded', '  Clarity', '  Last session', '  /code-review', '  Total XP']) {
      const found = narrow.texts.find((text) => text.startsWith(row)) ?? ''
      expect(cellsOf(found)).toBe(38)
    }
    // The tip that fits: the weakest score's, without its name.
    expect(narrow.texts).toContain('  ▼ say how to know it is done')

    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: { ...paneProps(), bodyColumns: 120 } })
    const cards = await ui.find({ type: 'Box', key: 'stats' })
    expect(cards?.children).toHaveLength(2)
    const left = await ui.find({ type: 'Box', key: 'stats:column:0' })
    expect(left?.props['width']).toBe(56)
    const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
    for (const text of texts.filter((one) => one.startsWith('  '))) expect(cellsOf(text)).toBeLessThanOrEqual(56)
    expect(texts.find((text) => text.startsWith('  Graded'))?.length).toBe(56)
    await ui.unmount()
  })

  test('a new player sees every section, each saying what fills it', async ($, on) => {
    await streaming($, on, undefined, false, { counted: newPlayer })
    await openStats($)
    const { texts } = await paneTexts($, 40)
    const all = texts.join('\n')
    for (const shown of [
      'none yet',
      'Any work today starts one.',
      'Prompts you type are graded.',
      'Fills in as your prompts are graded,',
      'Measured each turn, at its fullest.',
      'Slash commands you run count here.',
    ]) {
      expect(all).toContain(shown)
    }
    expect(all).toMatch(/^ {2}Graded +0$/m)
    expect(all).toMatch(/^ {2}Items owned +0$/m)
    expect(all).toMatch(/^ {2}Compactions +0 manual · 0 auto$/m)
    expect(all).not.toContain('Restart')
    expect(all).not.toContain('▲')
    for (const text of texts) expect(cellsOf(text)).toBeLessThanOrEqual(38)
  })

  test('a server older than the stats shows what it sends, and says to restart it for the rest', async ($, on) => {
    await streaming($, on, ownedOf())
    await openStats($)
    const all = (await paneTexts($, 72)).texts.join('\n')
    expect(all).toContain('The server predates the bests and the profile: restart it.')
    expect(all).toContain('Needs a newer server: restart it.')
    expect(all).toMatch(/^ {2}Best +—$/m)
    expect(all).toMatch(/^ {2}🔥 Current +2 days$/m)
    expect(all).toMatch(/^ {2}Graded +0$/m)
  })

  test('lays every row inside its card at any width, the cards never wider than the pane', () => {
    const view: BandView = {
      name: 'Player',
      level: 12,
      title: 'Adept',
      glyph: '🛡️',
      xp: { total: 12_345, intoLevel: 300, forNextLevel: 1200 },
      gold: 1500,
      isDev: false,
      pet: null,
    }
    const long = { name: '/a-plugin-with-a-long-name:and-a-long-command', uses: 1234 }
    const stats = {
      streak: { days: 120, best: 365, restDaysLeftThisWeek: 0 },
      prompts: { graded: 123_456, today: 40, average: 10, best: 10, regretted: 9999 },
      profile: [
        { dimension: 'clarity', average: 10 },
        { dimension: 'doneCriteria', average: 0 },
        { dimension: 'a-dimension-from-a-newer-rubric', average: 5 },
      ],
      context: { lastSession: 100, average: 99.6, pct50: 10_000, pct75: 9000, pct100: 800 },
      clears: 1_000_000,
      compactions: { manual: 12_345, auto: 67_890 },
      commands: [long, { name: 'custom', uses: 3 }],
      xp: { verified: 2345, reported: 10_000 },
      items: 512,
    }
    for (const columns of [20, 30, 38, 40, 56, 83, twoColumnsFrom, 118, 200]) {
      const layout = statsLayout(stats, view, columns, { looks: {}, loop: null })
      expect(layout.width).toBeLessThanOrEqual(Math.max(20, columns))
      expect(layout.columns).toHaveLength(columns >= twoColumnsFrom ? 2 : 1)
      const rows = layout.columns.flat().flatMap((card) => card.rows)
      for (const row of rows) expect(row.reduce((sum, run) => sum + cellsOf(run.text), 0)).toBeLessThanOrEqual(layout.width)
    }
    // A name too long for its card is cut, never wrapped.
    const narrow = statsLayout(stats, view, 38, { looks: {}, loop: null }).columns.flat()
    const commands = narrow.find((card) => card.key === 'commands')?.rows ?? []
    expect(commands[0]?.map((run) => run.text).join('')).toMatch(/^ {2}\/a-plugin-\S*… +▰+ 1,234$/)
  })

  test('reads a snapshot from an older server as nothing yet, with the bests and the profile unknown', () => {
    const view = statsViewOf(JSON.parse(JSON.stringify(snapshot(4))))
    expect(view).toMatchObject({
      streak: { days: 2, best: null, restDaysLeftThisWeek: 1 },
      prompts: { graded: 0, best: null },
      profile: null,
      commands: [],
      items: 0,
    })
  })
})

// Missions as the snapshot carries them: three dailies, one done, and a week with one weekly running and two on offer.
const quest = (questId: string, title: string, cadence: string, status: string, progress: number, goal: number, rewards: Record<string, unknown>, description: string | null = null): Quest => ({
  questId,
  packId: 'starter',
  title,
  description,
  cadence,
  start: cadence === 'daily' ? 'auto' : 'pick',
  status,
  progress,
  goal,
  rewards,
  expiresAt: cadence === 'daily' ? '2026-10-10T00:00:00.000Z' : '2026-10-12T00:00:00.000Z',
})
const missionsNow = (): Array<Quest> => [
  quest('clear-thinker', 'Clear Thinker', 'daily', 'active', 3, 5, { xp: 50, gold: 30 }, 'Write 5 prompts with clarity 8 or more today.'),
  quest('save-points', 'Save Points', 'daily', 'completed', 3, 3, { xp: 30, gold: 20 }),
  quest('steady-voice', 'Steady Voice', 'daily', 'active', 2, 8, { xp: 60, gold: 35 }),
  quest('ship-it', 'Ship It', 'weekly', 'active', 0, 1, { xp: 250, gold: 120, loot: { rarity: 'rare', pool: 'wearable' } }),
  quest('light-packer', 'Light Packer', 'weekly', 'offered', 0, 3, { xp: 200, gold: 100, loot: { rarity: 'rare' } }),
  quest('second-opinion', 'Second Opinion', 'weekly', 'offered', 0, 3, { xp: 150, gold: 80 }),
]
const missionRules = { missions: { daily: { count: 3, tier: 'uncommon' }, weekly: { offered: 5, active: 3, tier: 'rare' } } }
const completed = (questId: string, title: string, tier: string, rewards: Record<string, unknown>) =>
  serverEvent('quest.completed', { questId, title, tier, rewards })

/** Opens the pane on its Missions tab with the tab bar's button. */
const openMissions = async ($: Parameters<TestBody>[0]) => {
  await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
  const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: paneProps() })
  await ui.press({ key: 'tab:missions' })
  await ui.unmount()
}
const mountPane = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'Pane', requestId: 'questline', props: paneProps() })
const textsOf = async (ui: Awaited<ReturnType<typeof mountPane>>) => (await ui.findAll({ type: 'Text' })).map((one) => one.text).join('\n')
/** Row 2 of the band at `bodyColumns`, as one line of its texts. */
const bandAt = async ($: Parameters<TestBody>[0], bodyColumns: number) => {
  const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: { ...bandOf(), bodyColumns } })
  const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
  await ui.unmount()
  return texts
}

describe('the Missions tab', () => {
  test("lists today's dailies and the week's weeklies, each with its bar, count, rewards and time left", async ($, on) => {
    await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules })
    await openMissions($)
    const ui = await mountPane($)
    const texts = await textsOf(ui)
    expect(texts).toContain('◆ Missions')
    expect(texts).not.toContain('Band styles')
    expect(texts).toContain('Your missions  dailies run on their own · pick up to 3 weeklies')
    expect(texts).toMatch(/^Today ─+ 1 of 3 done · 16h 0m left$/m)
    expect(texts).toMatch(/^◎ Clear Thinker$/m)
    expect(texts).toContain('Write 5 prompts with clarity 8 or more today.')
    expect(texts).toMatch(/^▰{14}▱{10} {2}3\/5$/m)
    expect(texts).toContain('Reward  +50 XP · ◈ +30 gold')
    expect(texts).toMatch(/^✔ Save Points$/m)
    expect(texts).toMatch(/^▰{24} {2}✔ done$/m)
    expect(texts).toMatch(/^This week ─+ 2d 16h left$/m)
    expect(texts).toMatch(/^Running {2}1 of 3$/m)
    expect(texts).toMatch(/^◎ Ship It$/m)
    expect(texts).toContain('Reward  +250 XP · ◈ +120 gold · ◆ rare drop')
    expect(texts).toMatch(/^On offer {2}pick 2 more$/m)
    expect(texts).toMatch(/^○ Light Packer$/m)
    // A running weekly can be given up, an offered one picked; a daily runs on its own, with neither.
    expect(await ui.find({ type: 'Button', key: 'abandon:ship-it' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'accept:light-packer' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'accept:second-opinion' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'abandon:clear-thinker' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'accept:clear-thinker' })).toBeUndefined()
    // No dev controls off a dev server.
    expect(await ui.find({ type: 'Button', key: 'dev:complete:clear-thinker' })).toBeUndefined()
    expect(texts).not.toContain('Dev')
    await ui.unmount()
  })

  test('keeps the time left current while it stays open', async ($, on) => {
    // Nothing owned loops, so the minute passes without the previews' frames.
    const { clock } = await streaming($, on, undefined, false, { quests: missionsNow(), rules: missionRules })
    await openMissions($)
    const ui = await mountPane($)
    expect(await textsOf(ui)).toContain('16h 0m left')
    await clock.advance(60_000)
    expect(await textsOf(ui)).toContain('15h 59m left')
    await ui.unmount()
  })

  test('Accept picks an offered weekly; Abandon asks first, and only the second press gives it up', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules })
    const commands = () => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)
    await openMissions($)
    const ui = await mountPane($)
    await ui.press({ key: 'accept:light-packer' })
    expect(commands()).toMatchObject([{ type: 'quest.accept', data: { questId: 'light-packer' } }])
    expect(await textsOf(ui)).toMatch(/^Running {2}2 of 3$/m)
    await ui.press({ key: 'abandon:ship-it' })
    expect(commands()).toHaveLength(1)
    expect(await textsOf(ui)).toContain('Give it up? Its progress goes, and it goes back on offer.')
    await ui.press({ key: 'keep:ship-it' })
    expect(await textsOf(ui)).not.toContain('Give it up?')
    await ui.press({ key: 'abandon:ship-it' })
    await ui.press({ key: 'confirm-abandon:ship-it' })
    expect(commands()).toMatchObject([{ type: 'quest.accept' }, { type: 'quest.abandon', data: { questId: 'ship-it' } }])
    expect(await textsOf(ui)).toMatch(/^Running {2}1 of 3$/m)
    await ui.unmount()
  })

  test('a full log offers no Accept, and a pick the server refuses says why', async ($, on) => {
    const quests = missionsNow()
    quests.push(
      quest('red-to-green', 'Red to Green', 'weekly', 'active', 2, 5, { xp: 200 }),
      quest('five-days', 'Five Days', 'weekly', 'active', 1, 5, { xp: 200 }),
    )
    const { toasts } = await streaming($, on, ownedOf(), false, { quests, rules: missionRules })
    await openMissions($)
    const ui = await mountPane($)
    const texts = await textsOf(ui)
    expect(texts).toMatch(/^On offer {2}3 running, the most at once$/m)
    expect(texts).toContain('log full')
    expect(await ui.find({ type: 'Button', key: 'accept:light-packer' })).toBeUndefined()
    await ui.unmount()
    expect(toasts).toEqual([])
  })

  test('a pick the server refuses says why', async ($, on) => {
    const quests = missionsNow()
    const { toasts } = await streaming($, on, ownedOf(), false, { quests, rules: missionRules })
    await openMissions($)
    const ui = await mountPane($)
    // The pane drew a pick the server no longer offers.
    const offered = quests.find((one) => one.questId === 'second-opinion')
    if (offered !== undefined) offered.status = 'expired'
    await ui.press({ key: 'accept:second-opinion' })
    expect(toasts).toEqual(['That mission is not on offer'])
    await ui.unmount()
  })

  test('a server older than missions says to restart it, and the band shows none', async ($, on) => {
    await streaming($, on, ownedOf())
    await openMissions($)
    const texts = (await paneTexts($, 72)).texts.join('\n')
    expect(texts).toContain('◇ The server predates missions: restart it.')
    expect(texts).not.toContain('Today')
    expect((await band($)).all).not.toContain('◎')
  })
})

describe('missions on the band', () => {
  test('row 2 shows the running mission closest to done, and gives way as the row fills', async ($, on) => {
    await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules })
    expect(await bandAt($, 120)).toContain('◎ Clear Thinker ▰▰▰▱▱ 3/5')
    const narrow = await bandAt($, 70)
    expect(narrow).toContain('◎ ▰▰▰▱▱ 3/5')
    expect(narrow.join('\n')).not.toContain('Clear Thinker')
  })

  test('steps from the title down to the count, and says how many are done once none runs', () => {
    const mission = (questId: string, status: MissionView['status'], progress: number, goal: number, cadence = 'daily'): MissionView => ({
      questId,
      title: 'Clear Thinker',
      description: null,
      cadence,
      status,
      progress,
      goal,
      goalKind: null,
      rewards: { xp: 50, gold: 30, loot: null },
      expiresAt: null,
    })
    const running: MissionsView = {
      isKnown: true,
      quests: [mission('a', 'active', 1, 5), mission('b', 'active', 2, 4, 'weekly'), mission('c', 'completed', 3, 3)],
      weeklyActive: 3,
      tiers: { daily: 'uncommon', weekly: 'rare' },
    }
    const text = (room: number) => missionChip(running, room, 0)?.map((run) => run.text).join('') ?? null
    // The weekly halfway beats the daily a fifth of the way.
    expect(text(40)).toBe('◎ Clear Thinker ▰▰▰▱▱ 2/4')
    expect(text(23)).toBe('◎ Clear Thin… ▰▰▰▱▱ 2/4')
    expect(text(22)).toBe('◎ ▰▰▰▱▱ 2/4')
    expect(text(12)).toBe('◎ ▰▰▰▱▱ 2/4')
    expect(text(6)).toBe('◎ 2/4')
    expect(text(3)).toBeNull()
    const done: MissionsView = { ...running, quests: [mission('c', 'completed', 3, 3), mission('d', 'completed', 1, 1)] }
    expect(missionChip(done, 40, 0)?.map((run) => run.text).join('')).toBe('✔ 2 missions done')
    expect(missionChip(done, 10, 0)?.map((run) => run.text).join('')).toBe('✔ 2 done')
    expect(missionChip({ ...running, quests: [] }, 40, 0)).toBeNull()
    expect(missionChip(null, 40, 0)).toBeNull()
  })

  test('says the time left in its two largest units', () => {
    const now = Date.parse('2026-10-09T08:00:00Z')
    expect(timeLeft(Date.parse('2026-10-12T00:00:00Z'), now)).toBe('2d 16h left')
    expect(timeLeft(Date.parse('2026-10-09T13:20:30Z'), now)).toBe('5h 20m left')
    expect(timeLeft(Date.parse('2026-10-09T08:20:00Z'), now)).toBe('20m left')
    expect(timeLeft(now, now)).toBe('ending now')
    expect(timeLeft(null, now)).toBeNull()
  })
})

describe('a mission completed', () => {
  test('a daily plays in the band by its name, and the gain line and the toast say so in words', async ($, on) => {
    const { clock, send, toasts } = await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules })
    await send(
      ...causedBy(
        '01K6ZQ8W3J0000000000000C01',
        completed('clear-thinker', 'Clear Thinker', 'uncommon', { xp: 50, gold: 30 }),
        grant(50, 'quest'),
        goldChanged(30, 'quest'),
      ),
    )
    expect(toasts).toEqual(['Mission complete: Clear Thinker · +50 XP · +30 gold'])
    const seen = await samples($, clock, 3_000, 100)
    expect(seen.some((all) => /[˚✧✦❋] Clear Thinker [˚✧✦❋] · mission complete/.test(all))).toBe(true)
    expect(seen.every((all) => !all.includes('M I S S I O N'))).toBe(true)
    expect(await gainLine($)).toBe('Clear Thinker · mission complete')
  })

  test('a rare weekly grows the band: its bar fills, a check stamps, and its title and rewards show', async ($, on) => {
    const { clock, send } = await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules })
    await send(completed('ship-it', 'Ship It', 'rare', { xp: 250, gold: 120, loot: { rarity: 'rare', pool: 'wearable' } }))
    const opening = await band($)
    expect(opening.grown).toBe(4)
    expect(opening.all).toContain('M I S S I O N   C O M P L E T E')
    expect(opening.all).not.toContain('✔')
    await clock.advance(1_500)
    const done = await band($)
    expect(done.all).toMatch(/▕▰{12}▏ ✔ {2}Ship It [✦✧]/)
    expect(done.all).toContain('+250 XP · +120 gold · rare drop')
    expect(done.all).not.toContain('R A R E   D R O P')
    await clock.advance(600)
    expect((await band($)).grown).toBe(0)
  })

  test("collapses with a drop of its size into the mission, never the drop", () => {
    const mission: Celebration = { kind: 'quest', tier: 'uncommon', title: 'Clear Thinker', rewards: '+50 XP', more: 0 }
    const scarf: Celebration = { kind: 'loot', tier: 'uncommon', name: 'Knit Scarf', gold: 10, more: 0 }
    expect(queueOf([mission, scarf])).toEqual([{ ...mission, more: 1 }])
    expect(queueOf([scarf, mission])).toEqual([{ ...mission, more: 1 }])
    // A bigger drop still wins.
    const cap: Celebration = { kind: 'loot', tier: 'rare', name: 'Wizard Hat', gold: 0, more: 0 }
    expect(queueOf([mission, cap])).toEqual([mission, cap])
  })

  test('a new day says its dailies are in, quietly', async ($, on) => {
    const { send, toasts } = await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules })
    const dailies = missionsNow().filter((one) => one.cadence === 'daily')
    await send(serverEvent('quest.offered', { cadence: 'daily', quests: dailies }))
    expect(await gainLine($)).toBe('3 new dailies · /pathofdev')
    await send(serverEvent('quest.offered', { cadence: 'weekly', quests: [] }))
    expect(await gainLine($)).toBe('3 new dailies · /pathofdev')
    expect(toasts).toEqual([])
  })
})

describe('dev mode: missions', () => {
  const run = ($: Parameters<TestBody>[0], args: string) => $.command.run({ command: 'pathofdev', args, origin: composer, presentation })
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)

  test('completes a mission and re-rolls them, from /pathofdev dev and from the Missions tab', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf(), true, { quests: missionsNow(), rules: missionRules })
    expect((await run($, 'dev complete clear-thinker')).text).toBe('Done.')
    expect((await run($, 'dev roll')).text).toBe('Done.')
    for (const args of ['dev complete', 'dev roll now', 'dev complete a b']) expect((await run($, args)).text).toMatch(/complete <mission id> \| roll \| session \| /)
    expect(commandsOf(sent)).toMatchObject([
      { type: 'dev.completeQuest', data: { questId: 'clear-thinker' } },
      { type: 'dev.rollQuests', data: {} },
    ])
    await openMissions($)
    const ui = await mountPane($)
    // Running and offered missions can be completed; a done one can't.
    expect(await ui.find({ type: 'Button', key: 'dev:complete:save-points' })).toBeUndefined()
    await ui.press({ key: 'dev:complete:light-packer' })
    await ui.press({ key: 'dev:roll' })
    await ui.unmount()
    expect(commandsOf(sent).slice(2)).toMatchObject([
      { type: 'dev.completeQuest', data: { questId: 'light-packer' } },
      { type: 'dev.rollQuests', data: {} },
    ])
  })
})

describe('review fixes: missions', () => {
  const view = (quests: ReadonlyArray<MissionView>): MissionsView => ({
    isKnown: true,
    quests,
    weeklyActive: 3,
    tiers: { daily: 'uncommon', weekly: 'rare' },
  })
  const mission = (questId: string, title: string, cadence: string, status: MissionView['status'], progress: number, goal: number, expiresAt: number | null = null): MissionView => ({
    questId,
    title,
    description: null,
    cadence,
    status,
    progress,
    goal,
    goalKind: null,
    rewards: { xp: 50, gold: 0, loot: null },
    expiresAt,
  })

  test("a head leaves room for its Abandon, Accept or 'log full' beside it, so none wraps", () => {
    const long = 'A Very Long Weekly Mission Title That Goes On'
    for (const columns of [30, 44, 72]) {
      const layout = missionsLayout(view([mission('run', long, 'weekly', 'active', 1, 5), mission('offer', long, 'weekly', 'offered', 0, 5)]), columns, 0)
      const entries = layout.sections.flatMap((section) => section.groups.flatMap((group) => group.entries))
      const room = layout.width - 2
      const beside = { abandon: '[ Abandon ]', accept: '[ Accept ]', full: 'log full' }
      for (const entry of entries) {
        if (entry.action === null) continue
        expect(cellsOfRow(entry.head) + 2 + cellsOf(beside[entry.action])).toBeLessThanOrEqual(room)
      }
      const full = missionsLayout(view([1, 2, 3].map((i) => mission(`run-${i}`, 'Short', 'weekly', 'active', 0, 5)).concat(mission('offer', long, 'weekly', 'offered', 0, 5))), columns, 0)
      const offered = full.sections.flatMap((section) => section.groups.flatMap((group) => group.entries)).find((entry) => entry.action === 'full')
      expect(offered).toBeDefined()
      expect(cellsOfRow(offered?.head ?? []) + 2 + cellsOf('log full')).toBeLessThanOrEqual(room)
    }
  })

  test('the band groups a big count by thousands, as the tab does', () => {
    const chip = missionChip(view([mission('big', 'Marathon', 'weekly', 'active', 1500, 10000)]), 60, 0)
    expect(chip?.map((run) => run.text).join('')).toBe('◎ Marathon ▰▱▱▱▱ 1,500/10,000')
  })

  test("a mission whose window has ended reads as ended, however long since the last snapshot", () => {
    const midnight = Date.parse('2026-10-10T00:00:00Z')
    const quests = view([
      mission('daily', 'Clear Thinker', 'daily', 'active', 4, 5, midnight),
      mission('weekly', 'Ship It', 'weekly', 'active', 0, 1, midnight + 2 * 86_400_000),
    ])
    expect(missionChip(quests, 60, midnight - 1)?.map((run) => run.text).join('')).toBe('◎ Clear Thinker ▰▰▰▰▱ 4/5')
    expect(missionChip(quests, 60, midnight)?.map((run) => run.text).join('')).toBe('◎ Ship It ▱▱▱▱▱ 0/1')
    const today = missionsLayout(quests, 72, midnight).sections[0]?.groups[0]?.entries[0]
    expect(today?.mission.status).toBe('expired')
    expect(today?.meter.map((run) => run.text).join('')).toMatch(/4\/5 · ended$/)
  })

  test('only the Missions tab redraws each minute while the pane is open', async ($, on) => {
    const redraws: Array<string> = []
    on('ui.invalidate', ($, e) => {
      redraws.push(e.event)
      return { value: undefined }
    })
    const { clock } = await streaming($, on, undefined, false, { quests: missionsNow(), rules: missionRules })
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    await clock.advance(60_000)
    expect(redraws).toEqual([])
    await openMissions($)
    await clock.advance(60_000)
    expect(redraws).toEqual(['ui.render'])
  })

  test('a pick the server answers oddly says so, and leaves the band online', async ($, on) => {
    const { toasts } = await streaming($, on, ownedOf(), false, { quests: missionsNow(), rules: missionRules, commandStatus: 500 })
    await openMissions($)
    const ui = await mountPane($)
    await ui.press({ key: 'accept:light-packer' })
    await ui.unmount()
    expect(toasts).toEqual(['The server answered something unexpected.'])
    expect((await band($)).all).not.toContain('offline')
  })
})

describe('review fixes: a server from before missions', () => {
  test('one that sends an empty quest list but no missions rules says to restart it, with no mission controls', async ($, on) => {
    // Servers sent `quests: []` from the start; only one with missions has `missions` in its rules.
    const { sent } = await streaming($, on, ownedOf(), true, { quests: [] })
    await openMissions($)
    const ui = await mountPane($)
    const texts = await textsOf(ui)
    expect(texts).toContain('◇ The server predates missions: restart it.')
    expect(texts).not.toContain('No dailies today')
    expect(texts).not.toContain('None this week')
    expect(await ui.find({ type: 'Button', key: 'dev:roll' })).toBeUndefined()
    await ui.unmount()
    const answer = await $.command.run({ command: 'pathofdev', args: 'dev roll', origin: composer, presentation })
    expect(answer.text).toContain('The dev server predates missions: restart it')
    expect(sent.filter((one) => one.path === '/v1/commands')).toEqual([])
    expect((await band($)).all).not.toMatch(/◎|missions done/)
  })
})

describe('presence', () => {
  const opens = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/sessions').map((one) => one.body)
  const closes = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.method === 'DELETE').map((one) => one.path)
  const idOf = (body: unknown): string => (isRecord(body) && typeof body['sessionId'] === 'string' ? body['sessionId'] : '')

  test('opens its session as one it keeps live, and names it on every stream poll, the heartbeat', async ($, on) => {
    const { sent } = await started($, on)
    const [first] = opens(sent)
    expect(first).toEqual({ sessionId: expect.any(String), presence: true })
    const polls = sent.filter((one) => one.path === '/v1/stream')
    expect(polls.length).toBeGreaterThan(0)
    for (const poll of polls) expect(poll.query).toBe(`?after=0&session=${idOf(first)}`)
  })

  test('closes its session as the process exits', async ($, on) => {
    const { sent } = await started($, on)
    const id = idOf(opens(sent)[0])
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'first', resume: { id: 'first' } })
    expect(closes(sent)).toEqual([`/v1/sessions/${id}`])
  })

  test('lets the exit go on when the server is slow to answer the close', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on, { explored: ['acme/widgets'] })
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock, { closeTakes: 60_000 })
    await $.session.start(start)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    let isEnded = false
    const ending = $.session.end({ reason: 'other', sessionId: 'first', resume: { id: 'first' } }).then(() => {
      isEnded = true
    })
    await until(clock, () => closes(sent).length === 1)
    await clock.advance(499)
    expect(isEnded).toBe(false)
    await clock.advance(1)
    await until(clock, () => isEnded)
    await ending
  })

  test('a /clear closes the session it ends and opens the next, and a resume does the same', async ($, on) => {
    const { clock, sent } = await started($, on)
    const first = idOf(opens(sent)[0])
    await $.session.end({ reason: 'clear', sessionId: 'first', resume: { id: 'first' } })
    await until(clock, () => opens(sent).length === 2 && closes(sent).length === 1)
    const second = idOf(opens(sent)[1])
    expect(second).not.toBe(first)
    expect(closes(sent)).toEqual([`/v1/sessions/${first}`])
    await $.session.end({ reason: 'resume', sessionId: 'second', resume: { id: 'second' } })
    await until(clock, () => opens(sent).length === 3 && closes(sent).length === 2)
    expect(closes(sent)[1]).toBe(`/v1/sessions/${second}`)
    expect(idOf(opens(sent)[2])).not.toBe(second)
  })

  test('a reload keeps the session id, so the one session is never counted twice', async ($, on) => {
    const { clock, sent } = await started($, on)
    await $.session.start(start)
    await until(clock, () => opens(sent).length === 2)
    expect(idOf(opens(sent)[1])).toBe(idOf(opens(sent)[0]))
    expect(closes(sent)).toEqual([])
  })

  test('a start after the session was closed opens a new id, as the server never opens a closed one again', async ($, on) => {
    const { clock, sent } = await started($, on)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'first', resume: { id: 'first' } })
    await $.session.start(start)
    await until(clock, () => opens(sent).length === 2)
    expect(idOf(opens(sent)[1])).not.toBe(idOf(opens(sent)[0]))
  })

  test('a server from before presence answers the close with 404, and the band stays online', async ($, on) => {
    const { clock, sent } = await streaming($, on, undefined, false, { predatesPresence: true })
    await $.session.end({ reason: 'clear', sessionId: 'first', resume: { id: 'first' } })
    await until(clock, () => closes(sent).length === 1 && opens(sent).length === 2)
    await clock.settle()
    expect((await band($)).all).not.toContain('offline')
  })
})

describe('missions over sessions run together', () => {
  const together = (status: string, progress: number): Quest => ({
    ...quest('two-minds', 'Two Minds', 'weekly', status, progress, 3, { xp: 150, gold: 80 }),
    goalKind: 'parallel',
  })

  test('the tab counts their moments together, and the band shows one only once it has a moment', async ($, on) => {
    const quests = [together('active', 1)]
    const { clock } = await streaming($, on, undefined, false, { quests, rules: missionRules })
    await openMissions($)
    const ui = await mountPane($)
    expect(await textsOf(ui)).toContain('1 of 3 together')
    await ui.unmount()
    expect((await bandAt($, 120)).join('')).toContain('Two Minds')
    await clock.settle()
  })

  const now = Date.parse('2026-10-09T08:00:00Z')
  const viewOf = (goalKind: string | null, progress: number): MissionsView => ({
    isKnown: true,
    quests: [
      {
        questId: 'two-minds',
        title: 'Two Minds',
        description: null,
        cadence: 'weekly',
        status: 'active',
        progress,
        goal: 3,
        goalKind,
        rewards: { xp: 150, gold: 80, loot: null },
        expiresAt: null,
      },
    ],
    weeklyActive: 3,
    tiers: { daily: 'uncommon', weekly: 'rare' },
  })
  const metersOf = (view: MissionsView) =>
    missionsLayout(view, 72, now)
      .sections.flatMap((section) => section.groups.flatMap((group) => group.entries.map((entry) => entry.meter)))
      .map((row) => row.map((run) => run.text).join(''))

  test('the band never shows one with no moment yet, which would only suggest opening sessions', () => {
    expect(missionChip(viewOf('parallel', 0), 80, now)).toBeNull()
    expect(cellsOfRow(missionChip(viewOf('parallel', 1), 80, now) ?? [])).toBeGreaterThan(0)
    expect(missionChip(viewOf(null, 0), 80, now)).not.toBeNull()
  })

  test('a mission from a server that names no goal kind reads as before', () => {
    expect(metersOf(viewOf(null, 1)).join('')).toContain('1/3')
    expect(metersOf(viewOf(null, 1)).join('')).not.toContain('together')
    expect(metersOf(viewOf('parallel', 1)).join('')).toContain('1 of 3 together')
  })

  test('dev mode opens a stand-in session on a server that knows them, and says to restart one that does not', async ($, on) => {
    const run = ($$: Parameters<TestBody>[0], args: string) => $$.command.run({ command: 'pathofdev', args, origin: composer, presentation })
    const quests = [...missionsNow(), together('active', 0)]
    const { sent } = await streaming($, on, ownedOf(), true, { quests, rules: missionRules })
    expect((await run($, 'dev session')).text).toMatch(/^A stand-in session is open/)
    expect(sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)).toMatchObject([
      { type: 'dev.fakeSession', data: {} },
    ])
    await openMissions($)
    const ui = await mountPane($)
    await ui.press({ key: 'dev:session' })
    await ui.unmount()
    expect(sent.filter((one) => one.path === '/v1/commands')).toHaveLength(2)
  })

  test('dev mode says to restart a dev server that predates parallel missions', async ($, on) => {
    const run = ($$: Parameters<TestBody>[0], args: string) => $$.command.run({ command: 'pathofdev', args, origin: composer, presentation })
    const { sent } = await streaming($, on, ownedOf(), true, { quests: missionsNow(), rules: missionRules })
    expect((await run($, 'dev session')).text).toMatch(/predates parallel missions: restart it/)
    expect(sent.filter((one) => one.path === '/v1/commands')).toEqual([])
    await openMissions($)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'dev:session' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('sigils', () => {
  const sigilItem = (id: string, name: string, rarity: string, multiplier: number, glyph: string, color: string, lore: string | null = null) => ({
    id,
    name,
    rarity,
    category: 'sigil',
    slot: 'sigil',
    sprite: null,
    lore,
    effect: null,
    look: null,
    sigil: { multiplier, glyph, color },
  })
  const arcane = sigilItem('arcane-sigil', 'Arcane Sigil', 'epic', 2, '✹', '#c77dff', 'Hums when the done criteria are spelled out.')
  const chalk = sigilItem('chalk-sigil', 'Chalk Sigil', 'common', 1.2, '✧', '#bcbcbc')
  const sigilRules = {
    prompt: { sigilMultiplier: { common: [1.2, 1.3], uncommon: [1.4, 1.6], rare: [1.7, 1.9], epic: [2, 2.2], legendary: [2.3, 2.5] } },
  }
  /** The usual inventory with two sigils, the Arcane worn when `worn`. */
  const withSigils = (worn: boolean): Owned => {
    const owned = ownedOf()
    return {
      inventory: [
        ...owned.inventory,
        { id: '01K6ZQ8W3J0000000000009011', itemId: 'arcane-sigil' },
        { id: '01K6ZQ8W3J0000000000009012', itemId: 'chalk-sigil' },
        { id: '01K6ZQ8W3J0000000000009013', itemId: 'chalk-sigil' },
      ],
      items: [...owned.items, arcane, chalk],
      equipped: worn ? { sigil: '01K6ZQ8W3J0000000000009011' } : {},
    }
  }
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)

  test('the inventory lists them strongest first, with their multiplier, and marks the one worn', async ($, on) => {
    await streaming($, on, withSigils(true), false, { rules: sigilRules })
    const all = (await paneTexts($, 100)).texts.join('\n')
    expect(all).toContain('×2 on the XP your graded prompts earn · one worn at a time')
    expect(all).toMatch(/● ✹ Arcane Sigil ×2 prompt XP · epic/)
    expect(all).toMatch(/○ ✧ Chalk Sigil ×1\.2 prompt XP · common · 2 owned/)
    expect(all.indexOf('Arcane Sigil')).toBeLessThan(all.indexOf('Chalk Sigil'))
    expect(all.indexOf('Sigil')).toBeLessThan(all.indexOf('Band styles'))
    expect(all).toContain('Hums when the done criteria are spelled out.')
    // Not listed again among the other items.
    expect(all).not.toMatch(/Chalk Sigil common · sigil/)
  })

  test('Equip wears one through item.equip, and Unequip takes it off', async ($, on) => {
    const { sent } = await streaming($, on, withSigils(false), false, { rules: sigilRules })
    const before = (await paneTexts($, 100)).texts.join('\n')
    expect(before).toContain('none worn · one at a time multiplies the XP your graded prompts earn')
    const ui = await mountPane($)
    await ui.press({ key: 'equip:sigil:arcane-sigil' })
    await ui.unmount()
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'item.equip', data: { entryId: '01K6ZQ8W3J0000000000009011', slot: 'sigil' } })
    const after = await mountPane($)
    expect(await textsOf(after)).toMatch(/● ✹ Arcane Sigil/)
    await after.press({ key: 'unequip:sigil' })
    await after.unmount()
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'item.unequip', data: { slot: 'sigil' } })
  })

  test('a server older than sigils gets no Sigil section', async ($, on) => {
    await streaming($, on, withSigils(true))
    const old = (await paneTexts($, 100)).texts.join('\n')
    expect(old).not.toContain('one worn at a time')
    expect(old).not.toMatch(/^Sigil/m)
  })

  test('a new player on a new server reads how sigils come', async ($, on) => {
    await streaming($, on, ownedOf(), false, { rules: sigilRules })
    const all = (await paneTexts($, 100)).texts.join('\n')
    expect(all).toContain('none yet: they drop like any loot, and multiply the XP your graded prompts earn')
  })

  test("the gain line and the toast say the sigil's part in words; a sigil drop names its multiplier", async ($, on) => {
    const { clock, send, toasts } = await streaming($, on, undefined, false, { rules: sigilRules })
    await send(...causedBy('01K6ZQ8W3J0000000000000C01', grant(20, 'prompt.graded', { grade: 5, sigil: 2 })))
    expect(await gainLine($)).toBe('+20 XP · prompt graded 5 · ×2 sigil')
    expect(toasts.at(-1)).toBe('+20 XP (×2 sigil)')
    await send(...causedBy('01K6ZQ8W3J0000000000000C02', grant(10, 'prompt.graded', { grade: 5 })))
    expect(await gainLine($)).toBe('+10 XP · prompt graded 5')
    expect(toasts.at(-1)).toBe('+10 XP')
    // The day's first prompt brings the streak too, which the sigil didn't touch.
    await send(...causedBy('01K6ZQ8W3J0000000000000C04', grant(10, 'streak.day'), grant(20, 'prompt.graded', { grade: 5, sigil: 2 })))
    expect(toasts.at(-1)).toBe('+30 XP (×2 sigil on the prompt)')
    expect(await gainLine($)).toBe('+20 XP · prompt graded 5 · ×2 sigil')
    const sigilDrop = serverEvent('loot.dropped', {
      entry: { id: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T', itemId: 'arcane-sigil', acquiredAt: '2026-10-09T08:00:00Z', source: { kind: 'drop', ref: '1' }, dye: null },
      item: arcane,
      gold: 0,
      pity: { sinceRare: 0, sinceEpic: 0 },
      tier: 'epic',
    })
    await send(...causedBy('01K6ZQ8W3J0000000000000C03', sigilDrop))
    expect(toasts.at(-1)).toBe('Arcane Sigil ×2 (epic)')
    // Once its celebration has played, the line names it with its multiplier.
    await clock.advance(5_000)
    expect(await gainLine($)).toBe('Arcane Sigil ×2 · epic')
  })

  test('a sigil drop celebrates as any drop of its rarity: an epic takes the band up with a burst', async ($, on) => {
    const { clock, send } = await streaming($, on, undefined, false, { rules: sigilRules })
    const sigilDrop = serverEvent('loot.dropped', {
      entry: { id: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T', itemId: 'arcane-sigil', acquiredAt: '2026-10-09T08:00:00Z', source: { kind: 'drop', ref: '1' }, dye: null },
      item: arcane,
      gold: 0,
      pity: { sinceRare: 0, sinceEpic: 0 },
      tier: 'epic',
    })
    await send(sigilDrop)
    expect((await band($, 30)).grown).toBe(8)
    await clock.advance(700)
    expect((await band($)).all).toContain('Arcane Sigil')
    await clock.advance(2_600)
    expect((await band($)).grown).toBe(0)
  })

  test('the Stats tab names the sigil worn, in a row that fits a 40-column pane', async ($, on) => {
    await streaming($, on, withSigils(true), false, { counted: playing, rules: sigilRules })
    await openStats($)
    const wide = (await paneTexts($, 72)).texts.join('\n')
    expect(wide).toMatch(/^ {2}Sigil +✹ Arcane Sigil ×2$/m)
    for (const text of (await paneTexts($, 40)).texts) expect(cellsOf(text)).toBeLessThanOrEqual(38)
  })

  test('the Stats tab says when none is worn', async ($, on) => {
    await streaming($, on, withSigils(false), false, { counted: playing, rules: sigilRules })
    await openStats($)
    expect((await paneTexts($, 72)).texts.join('\n')).toMatch(/^ {2}Sigil +none worn$/m)
  })

  test('an older server has no Sigil row in the Stats tab', async ($, on) => {
    await streaming($, on, withSigils(true), false, { counted: playing })
    await openStats($)
    expect((await paneTexts($, 72)).texts.join('\n')).not.toMatch(/^ {2}Sigil/m)
  })

  test('a mission that grants an XP boost says so in the tab and the toast', async ($, on) => {
    const boosted = missionsNow().map((one) =>
      one.questId === 'clear-thinker' ? { ...one, rewards: { ...one.rewards, xpBoost: { pct: 10, minutes: 60 } } } : one,
    )
    const { send, toasts } = await streaming($, on, ownedOf(), false, { quests: boosted, rules: missionRules })
    await openMissions($)
    const ui = await mountPane($)
    expect(await textsOf(ui)).toContain('+10% XP for 1h')
    await ui.unmount()
    await send(
      ...causedBy(
        '01K6ZQ8W3J0000000000000C01',
        completed('clear-thinker', 'Clear Thinker', 'uncommon', { xp: 50, gold: 30, xpBoost: { pct: 10, minutes: 60 } }),
        grant(50, 'quest'),
        goldChanged(30, 'quest'),
      ),
    )
    expect(toasts.at(-1)).toBe('Mission complete: Clear Thinker · +50 XP · +30 gold · +10% XP for 1h')
    // A bigger mission's celebration lists it with the rest.
    const rewards = { xp: 300, gold: 150, xpBoost: { pct: 15, minutes: 120 }, loot: { rarity: 'epic' } } satisfies QuestRewards
    expect(rewardsText(rewards)).toBe('+300 XP · +150 gold · +15% XP for 2h · epic drop')
  })

  test('a worn sigil the catalogue lost reads the same in the header, the list and the Stats tab', async ($, on) => {
    const lost: Owned = { ...withSigils(false), equipped: { sigil: '01K6ZQ8W3J0000000000009099' } }
    const { sent } = await streaming($, on, lost, false, { counted: playing, rules: sigilRules })
    const all = (await paneTexts($, 100)).texts.join('\n')
    expect(all).toContain('the one worn is no longer in the catalogue, and adds nothing')
    expect(all).not.toContain('none worn')
    expect(all).toMatch(/● \? Unknown sigil no longer in the catalogue/)
    await openStats($)
    expect((await paneTexts($, 72)).texts.join('\n')).toMatch(/^ {2}Sigil +unknown sigil$/m)
    const stats = await mountPane($)
    await stats.press({ key: 'tab:inventory' })
    await stats.unmount()
    const ui = await mountPane($)
    await ui.press({ key: 'unequip:sigil' })
    await ui.unmount()
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'item.unequip', data: { slot: 'sigil' } })
  })

  test('dev mode grants a sigil by its id', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf(), true, { rules: sigilRules })
    const answer = await $.command.run({ command: 'pathofdev', args: 'dev item arcane-sigil', origin: composer, presentation })
    expect(answer.text).toBe('Done.')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'dev.grantItem', data: { itemId: 'arcane-sigil' } })
  })
})

describe('the shop', () => {
  const beadString = {
    ...styleItem('bead-string', 'Bead String', 'uncommon', 'xpBar', {
      glyphs: { full: '●', empty: '○' },
      colors: { full: '#5fd7ff', empty: '#585858' },
      frames: null,
      fps: null,
    }),
    lore: 'Strung one bead per green build.',
  }
  const copperPurse = styleItem('copper-purse', 'Copper Purse', 'common', 'goldDisplay', {
    glyphs: { icon: '●' },
    colors: { icon: '#d7875f' },
    frames: null,
    fps: null,
  })
  const food = (id: string, name: string, rarity: string, minutes: number) => ({
    id,
    name,
    rarity,
    category: 'food',
    slot: null,
    sprite: null,
    lore: id === 'trail-mix' ? 'Nuts, seeds and the odd chocolate chip.' : null,
    effect: { xpBoostPct: 10, minutes },
    look: null,
  })
  const trailMix = food('trail-mix', 'Trail Mix', 'common', 60)
  const berryTart = food('berry-tart', 'Berry Tart', 'uncommon', 120)
  /** A treat: food that only lifts the mood, which is all the shop sells. */
  const treat = (id: string, name: string, rarity: string, lore: string | null = null) => ({
    ...food(id, name, rarity, 0),
    lore,
    effect: null,
  })
  const honeyBiscuit = treat('honey-biscuit', 'Honey Biscuit', 'common', 'Baked in the shape of a tiny paw.')
  const sugarPlum = treat('sugar-plum', 'Sugar Plum', 'uncommon')
  const offer = (itemId: string, price: number, stock: number) => ({
    offerId: `2026-10-09/${itemId}`,
    itemId,
    price,
    stock,
    endsAt: '2026-10-10T00:00:00.000Z',
  })
  const shopRules = {
    shop: { offers: 3, rarities: ['common', 'uncommon'], categories: ['bandStyle'], stock: 1, prices: {}, food: {} },
    pet: { moodDecayPerDay: 10, happyAbove: 70, happyXpBonusPct: 5, evolveAt: [10], care: { fed: 30, petted: 5, pettedPerHour: 3 } },
    loot: { rerollGold: { common: 20, uncommon: 50 }, salvageShards: { common: 1, uncommon: 1 }, shardsToCraft: 10 },
  }
  const ember = (mood: number) => ({ species: 'fox', name: 'Ember', form: 0, mood, equipped: {} })
  /** Two Solid Bars (the first worn), a Honey Biscuit, and the shelf and the treats on offer. */
  const stocked: Owned = {
    inventory: [
      { id: '01K6ZQ8W3J0000000000009001', itemId: 'solid-bar' },
      { id: '01K6ZQ8W3J0000000000009002', itemId: 'solid-bar' },
      { id: '01K6ZQ8W3J0000000000009003', itemId: 'honey-biscuit' },
    ],
    items: [solidBar, beadString, copperPurse, honeyBiscuit, sugarPlum, trailMix, berryTart],
    equipped: { xpBar: '01K6ZQ8W3J0000000000009001' },
  }
  const shelf = [offer('copper-purse', 120, 0), offer('solid-bar', 120, 1), offer('bead-string', 250, 1)]
  const kept = (more: Kept = {}): Kept => ({
    shop: [...shelf, offer('honey-biscuit', 15, 3), offer('sugar-plum', 35, 2)],
    pet: ember(82),
    shards: { common: 3, uncommon: 10, rare: 0, epic: 0, legendary: 0 },
    gold: 200,
    ...more,
  })
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)
  const openShop = async ($: Parameters<TestBody>[0]) => {
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    const ui = await mountPane($)
    await ui.press({ key: 'tab:shop' })
    await ui.unmount()
  }
  const pressIn = async ($: Parameters<TestBody>[0], key: string) => {
    const ui = await mountPane($)
    await ui.press({ key })
    await ui.unmount()
  }

  test("lists today's shelf with live previews, the food for the pet, and what each costs", async ($, on) => {
    await streaming($, on, stocked, false, { rules: shopRules, kept: kept() })
    await openShop($)
    const all = (await paneTexts($, 72)).texts.join('\n')
    expect(all).toMatch(/^Shop {2}looks and treats for gold, a new shelf each day · ◈ 200 gold$/m)
    expect(all).toMatch(/^Today's shelf ─+ restocks in 16h 0m$/m)
    expect(all).toMatch(/^◆ Copper Purse {2}common · Gold$/m)
    expect(all).toContain('sold out today')
    expect(all).toMatch(/^◆ Solid Bar {2}common · XP bar · 2 owned$/m)
    // Not enough gold yet: the price, and how much more it takes, in place of the button.
    expect(all).toMatch(/^◆ Bead String {2}uncommon · XP bar$/m)
    expect(all).toContain('◈ 250 · 50 more to go')
    // Each band style's preview is the band's own drawing, in the player's real XP.
    expect(all).toMatch(/^●+○+ 30\/203 xp$/m)
    expect(all).toContain('Strung one bead per green build.')
    // Treats lift the mood and nothing else, and the tab says so.
    expect(all).toMatch(/^Treats ─+ for Ember$/m)
    expect(all).toContain('XP food comes from play')
    expect(all).toContain('+30 mood · no XP · 3 left today')
    expect(all).toContain('+30 mood · no XP · 2 left today')
    expect(all).toMatch(/^◆ Honey Biscuit {2}common · 1 owned$/m)
    expect(all).not.toContain('% XP for')
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/solid-bar' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/honey-biscuit' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/copper-purse' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/bead-string' })).toBeUndefined()
    await ui.unmount()
  })

  test('Buy sends shop.buy for the offer pressed', async ($, on) => {
    const { sent } = await streaming($, on, stocked, false, { rules: shopRules, kept: kept() })
    await openShop($)
    await pressIn($, 'buy:2026-10-09/honey-biscuit')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'shop.buy', data: { offerId: '2026-10-09/honey-biscuit' } })
  })

  test('trades a spare copy in, never the one worn, and crafts with enough shards', async ($, on) => {
    const { sent } = await streaming($, on, stocked, false, { rules: shopRules, kept: kept() })
    await openShop($)
    const all = (await paneTexts($, 72)).texts.join('\n')
    expect(all).toMatch(/^Duplicates ─+ a spare copy, traded in$/m)
    expect(all).toMatch(/^Shards ─+ 10 make an item of their rarity, never a sigil$/m)
    expect(all).toMatch(/^ {2}common +▰{6}▱{14} +3\/10$/m)
    expect(all).toMatch(/^ {2}uncommon +▰{20} 10\/10$/m)
    await pressIn($, 'reroll:solid-bar')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'item.reroll', data: { entryId: '01K6ZQ8W3J0000000000009002' } })
    await pressIn($, 'salvage:solid-bar')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'item.salvage', data: { entryId: '01K6ZQ8W3J0000000000009002' } })
    // Ten uncommon shards make any uncommon the snapshot names, a treat included, but never XP food.
    await pressIn($, 'craft:uncommon:bead-string')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'shards.craft', data: { rarity: 'uncommon', itemId: 'bead-string' } })
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'craft:uncommon:sugar-plum' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'craft:uncommon:berry-tart' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'craft:common:solid-bar' })).toBeUndefined()
    await ui.unmount()
  })

  test('fits a 40-column pane, every row inside it', async ($, on) => {
    await streaming($, on, stocked, false, { rules: shopRules, kept: kept() })
    await openShop($)
    // Lore wraps as prose does; every other row is cut to the pane.
    const lore = ['Baked in the shape of a tiny paw.', 'Strung one bead per green build.']
    const wide = (await paneTexts($, 40)).texts.filter((text) => cellsOf(text) > 38 && !lore.includes(text))
    expect(wide).toEqual([])
  })

  test('lists no food among the duplicates: food is eaten, never traded in', async ($, on) => {
    const meals: Owned = {
      ...stocked,
      inventory: [...stocked.inventory, { id: '01K6ZQ8W3J0000000000009004', itemId: 'honey-biscuit' }],
    }
    await streaming($, on, meals, false, { rules: shopRules, kept: kept() })
    await openShop($)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'reroll:solid-bar' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reroll:honey-biscuit' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'salvage:honey-biscuit' })).toBeUndefined()
    await ui.unmount()
  })

  test('never offers XP food to buy, even when a server lists it: gold never buys XP', async ($, on) => {
    const xpOffers = kept({ shop: [...shelf, offer('trail-mix', 25, 3), offer('honey-biscuit', 15, 3)] })
    await streaming($, on, stocked, false, { rules: shopRules, kept: xpOffers })
    await openShop($)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/trail-mix' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/honey-biscuit' })).toBeDefined()
    expect(await textsOf(ui)).not.toContain('Trail Mix')
    await ui.unmount()
  })

  test('a server older than the shop says to restart it, and offers nothing', async ($, on) => {
    await streaming($, on, stocked, false, { kept: kept() })
    await openShop($)
    const all = (await paneTexts($, 72)).texts.join('\n')
    expect(all).toContain('The server predates the shop: restart it.')
    expect(all).not.toContain("Today's shelf")
  })

  test('the restock comes by the clock: past midnight the shelf reads as restocking, with no Buy', async ($, on) => {
    const ending = shelf.map((one) => ({ ...one, endsAt: '2026-10-09T08:01:00.000Z' }))
    const more = { rules: shopRules, kept: kept({ gold: 5000, shop: ending }) }
    const { clock, sent } = await streaming($, on, stocked, false, more)
    await openShop($)
    expect((await paneTexts($, 72)).texts.join('\n')).toContain('restocks in 1m')
    const opens = () => sent.filter((one) => one.path === '/v1/sessions').length
    const before = opens()
    await clock.advance(90_000)
    // Past the restock, the tab fetches the new day's shelf itself, as no stream event may come to bring it.
    expect(opens()).toBeGreaterThan(before)
    const all = (await paneTexts($, 72)).texts.join('\n')
    expect(all).toContain('restocking now')
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'buy:2026-10-09/solid-bar' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('caring for the pet', () => {
  const trailMix = {
    id: 'trail-mix',
    name: 'Trail Mix',
    rarity: 'common',
    category: 'food',
    slot: null,
    sprite: null,
    lore: 'Nuts, seeds and the odd chocolate chip.',
    effect: { xpBoostPct: 10, minutes: 60 },
    look: null,
  }
  const careRules = {
    pet: { moodDecayPerDay: 10, happyAbove: 70, happyXpBonusPct: 5, evolveAt: [10], care: { fed: 30, petted: 5, pettedPerHour: 3 } },
  }
  const ember = (mood: number) => ({ species: 'fox', name: 'Ember', form: 0, mood, equipped: {} })
  const withFood: Owned = {
    inventory: [
      { id: '01K6ZQ8W3J0000000000009101', itemId: 'trail-mix' },
      { id: '01K6ZQ8W3J0000000000009102', itemId: 'trail-mix' },
      { id: '01K6ZQ8W3J0000000000009103', itemId: 'honey-biscuit' },
    ],
    items: [
      trailMix,
      { ...trailMix, id: 'honey-biscuit', name: 'Honey Biscuit', lore: null, effect: null },
    ],
    equipped: {},
  }
  const meal = { kind: 'food', source: 'trail-mix', xpBoostPct: 10, endsAt: '2026-10-09T08:42:00.000Z' }
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)
  // Wide enough that every meal's head keeps all its notes.
  const inventory = async ($: Parameters<TestBody>[0]) => {
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    return (await paneTexts($, 90)).texts.join('\n')
  }

  test('the card shows how it feels, takes a pat, and feeds it the food owned', async ($, on) => {
    const kept = { pet: ember(82), boosts: [meal] }
    const { sent } = await streaming($, on, withFood, false, { rules: careRules, kept })
    const all = await inventory($)
    expect(all).toMatch(/^Ember ─+ happy · \+5% XP$/m)
    expect(all).toMatch(/^ {2}ᓚᘏᗢ {2}Ember {2}♥♥♥$/m)
    expect(all).toMatch(/^ {2}Mood ▰+▱+ 82$/m)
    expect(all).toContain('a pat lifts the mood +5, 3 pats an hour')
    expect(all).toMatch(/^ {2}Fed {2}\+10% XP · 42m left$/m)
    expect(all).toMatch(/^Food {2}treats lift the mood; XP food boosts XP too$/m)
    expect(all).toMatch(/^◆ Trail Mix {2}common · \+30 mood · \+10% XP for 1h · 2 owned$/m)
    // A treat says it lifts the mood, and nothing about XP.
    expect(all).toMatch(/^◆ Honey Biscuit {2}common · \+30 mood$/m)
    // Food sits on the pet's card, not among the other items.
    expect(all).not.toMatch(/Trail Mix common · food/)
    expect(all.indexOf('Ember')).toBeLessThan(all.indexOf('Band styles'))
    const ui = await mountPane($)
    await ui.press({ key: 'pet:pat' })
    await ui.press({ key: 'feed:trail-mix' })
    await ui.unmount()
    expect(commandsOf(sent).slice(-2)).toMatchObject([
      { type: 'pet.pet', data: {} },
      { type: 'pet.feed', data: { entryId: '01K6ZQ8W3J0000000000009101' } },
    ])
  })

  test('a low mood reads as sleepy, never sad, and keeps a heart; nothing on the card nags', async ($, on) => {
    await streaming($, on, { ...withFood, inventory: [] }, false, { rules: careRules, kept: { pet: ember(20) } })
    const all = await inventory($)
    expect(all).toMatch(/^Ember ─+ sleepy$/m)
    expect(all).toMatch(/^ {2}ᓚᘏᗢ {2}Ember {2}♥$/m)
    expect(all).toContain('No food yet: the Shop tab sells treats, and XP food drops as loot.')
    expect(all).not.toMatch(/sad|hungry|lonely|neglect|miss/i)
  })

  test('before the hatch, the card shows the egg, and its Hatch button once it can', async ($, on) => {
    const { sent } = await streaming($, on, withFood, false, { rules: careRules })
    const all = await inventory($)
    expect(all).toContain('🥚 Your egg is ready to hatch.')
    const ui = await mountPane($)
    await ui.press({ key: 'pet:hatch' })
    await ui.unmount()
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'pet.hatch' })
  })

  test('a server older than pet care shows the mood, says to restart it, and keeps food with the other items', async ($, on) => {
    await streaming($, on, withFood, false, { kept: { pet: ember(82) } })
    const all = await inventory($)
    expect(all).toContain('The server predates pet care: restart it to feed Ember.')
    expect(all).toMatch(/Trail Mix common · food · ×2/)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'pet:pat' })).toBeUndefined()
    await ui.unmount()
  })

  test("the band's hearts follow the rules' happy line, and a click on the pet gives it a pat", async ($, on) => {
    const rules = { pet: { ...careRules.pet, happyAbove: 80 } }
    const { sent } = await streaming($, on, withFood, false, { rules, kept: { pet: ember(75) } })
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: bandOf() })
    const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
    expect(texts).toContain('♥♥')
    await ui.press({ key: 'band:pet' })
    await ui.unmount()
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'pet.pet' })
  })

  test('/pet pats from the prompt, and says why not before the hatch or on an older server', async ($, on) => {
    const { sent, registered } = await streaming($, on, withFood, false, { rules: careRules, kept: { pet: ember(50) } })
    expect(registered).toContain('pet')
    const answer = await $.command.run({ command: 'pet', args: '', origin: composer, presentation })
    expect(answer.text).toBe('You pet Ember.')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'pet.pet', data: {} })
  })

  test('/pet says the pat landed even when the snapshot after it cannot be fetched', async ($, on) => {
    const kept = { pet: ember(50) }
    const { sent } = await streaming($, on, withFood, false, { rules: careRules, kept, downAfterCommand: true })
    const answer = await $.command.run({ command: 'pet', args: '', origin: composer, presentation })
    expect(answer.text).toBe('You pet Ember.')
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'pet.pet' })
  })

  test('/pet on a server older than pet care says to restart it, and sends nothing', async ($, on) => {
    const { sent } = await streaming($, on, withFood, false, { kept: { pet: ember(50) } })
    const answer = await $.command.run({ command: 'pet', args: '', origin: composer, presentation })
    expect(answer.text).toMatch(/^The server predates pet care: restart it/)
    expect(commandsOf(sent)).toEqual([])
  })
})

describe('the words for the shop and the pet', () => {
  const entry = { id: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T', itemId: 'bead-string', acquiredAt: '2026-10-09T08:00:00Z', source: { kind: 'shop', ref: 'x' }, dye: null }
  const item = (id: string, name: string, rarity: string) => ({
    id,
    name,
    rarity,
    category: 'bandStyle',
    slot: 'xpBar',
    sprite: null,
    lore: null,
    effect: null,
    look: { glyphs: {}, colors: {}, frames: null, fps: null },
  })
  const ember = { species: 'fox', name: 'Ember', form: 0, mood: 60, equipped: {} }

  test('a purchase, a meal, a pat, a re-roll, a salvage and a craft each say what they did, in the band and a toast', async ($, on) => {
    const { send, toasts, clock } = await streaming($, on, undefined, false, { kept: { pet: ember } })
    const bead = item('bead-string', 'Bead String', 'uncommon')
    await send(
      ...causedBy(
        '01K6ZQ8W3J0000000000000D01',
        serverEvent('shop.bought', { offerId: '2026-10-09/bead-string', entry, item: bead, price: 250 }),
        goldChanged(-250, 'shop'),
      ),
    )
    expect(await gainLine($)).toBe('Bead String · bought for 250 gold')
    expect(toasts.at(-1)).toBe('Bought Bead String (uncommon) · −250 gold')
    const boost = { pct: 10, minutes: 60 }
    const fed = { entryId: entry.id, itemId: 'trail-mix', name: 'Trail Mix', mood: 90, gained: 30, xpBoost: boost }
    await send(...causedBy('01K6ZQ8W3J0000000000000D02', serverEvent('pet.fed', fed)))
    expect(await gainLine($)).toBe('Ember ate Trail Mix · mood +30 · +10% XP for 1h')
    expect(toasts.at(-1)).toBe('Ember ate Trail Mix · mood +30 · +10% XP for 1h')
    // A treat lifts the mood, and its words say nothing of XP.
    const treat = { entryId: entry.id, itemId: 'honey-biscuit', name: 'Honey Biscuit', mood: 100, gained: 10 }
    await send(...causedBy('01K6ZQ8W3J0000000000000D08', serverEvent('pet.fed', treat)))
    expect(await gainLine($)).toBe('Ember ate Honey Biscuit · mood +10')
    expect(toasts.at(-1)).toBe('Ember ate Honey Biscuit · mood +10')
    await send(...causedBy('01K6ZQ8W3J0000000000000D03', serverEvent('pet.petted', { mood: 95, gained: 5 })))
    expect(await gainLine($)).toBe('Ember enjoyed the pat · mood +5')
    await send(...causedBy('01K6ZQ8W3J0000000000000D04', serverEvent('pet.petted', { mood: 95, gained: 0 })))
    expect(toasts.at(-1)).toBe('Ember enjoyed the pat')
    const rerolled = {
      from: { entryId: entry.id, itemId: 'solid-bar', name: 'Solid Bar' },
      entry,
      item: item('double-rule', 'Double Rule', 'common'),
      price: 20,
      tier: 'common',
    }
    await send(...causedBy('01K6ZQ8W3J0000000000000D05', serverEvent('item.rerolled', rerolled), goldChanged(-20, 'reroll')))
    expect(toasts.at(-1)).toBe('Re-rolled Solid Bar into Double Rule (common) · −20 gold')
    // A re-roll is a roll: what it made is revealed as a drop, its coin spinning.
    expect((await band($)).all).toMatch(/[◐◓◑◒] Double Rule/)
    await clock.advance(5_000)
    expect(await gainLine($)).toBe('Solid Bar re-rolled into Double Rule · common')
    const salvaged = { entryId: entry.id, itemId: 'solid-bar', name: 'Solid Bar', rarity: 'common', shards: 1, totalAfter: 4 }
    await send(...causedBy('01K6ZQ8W3J0000000000000D06', serverEvent('item.salvaged', salvaged)))
    expect(await gainLine($)).toBe('Solid Bar salvaged · +1 common shard')
    expect(toasts.at(-1)).toBe('Salvaged Solid Bar · +1 common shard')
    const crafted = { rarity: 'uncommon', spent: 10, totalAfter: 0, entry, item: bead }
    await send(...causedBy('01K6ZQ8W3J0000000000000D07', serverEvent('shards.crafted', crafted)))
    expect(await gainLine($)).toBe('Crafted Bead String · uncommon')
    expect(toasts.at(-1)).toBe('Crafted Bead String (uncommon) · −10 uncommon shards')
  })
})

describe('dev mode: the shop and the pet', () => {
  const careRules = {
    shop: { offers: 3 },
    pet: { moodDecayPerDay: 10, happyAbove: 70, happyXpBonusPct: 5, evolveAt: [10], care: { fed: 30, petted: 5, pettedPerHour: 3 } },
  }
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)
  const ember = { species: 'fox', name: 'Ember', form: 0, mood: 60, equipped: {} }

  test('restocks, sets the mood and the shards, from /pathofdev dev and from the panes', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf(), true, { rules: careRules, kept: { pet: ember } })
    const run = (args: string) => $.command.run({ command: 'pathofdev', args, origin: composer, presentation })
    expect((await run('dev restock')).text).toBe('Done.')
    expect((await run('dev mood 20')).text).toBe('Done.')
    expect((await run('dev shards 10')).text).toBe('Done.')
    expect(commandsOf(sent).slice(-3)).toMatchObject([
      { type: 'dev.restockShop', data: {} },
      { type: 'dev.setMood', data: { mood: 20 } },
      { type: 'dev.setShards', data: { count: 10 } },
    ])
    for (const args of ['dev mood 101', 'dev mood', 'dev shards x', 'dev restock now']) {
      expect((await run(args)).text).toMatch(/^Dev mode: /)
    }
    const ui = await mountPane($)
    await ui.press({ key: 'dev:mood-100' })
    await ui.press({ key: 'tab:shop' })
    await ui.unmount()
    const shop = await mountPane($)
    await shop.press({ key: 'dev:restock' })
    await shop.press({ key: 'dev:shards' })
    await shop.unmount()
    expect(commandsOf(sent).slice(-3)).toMatchObject([
      { type: 'dev.setMood', data: { mood: 100 } },
      { type: 'dev.restockShop' },
      { type: 'dev.setShards', data: { count: 10 } },
    ])
  })

  test('says to restart a dev server older than the shop or pet care, and sends nothing', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf(), true, { kept: { pet: ember } })
    const run = (args: string) => $.command.run({ command: 'pathofdev', args, origin: composer, presentation })
    expect((await run('dev restock')).text).toMatch(/^The dev server predates the shop: restart it/)
    expect((await run('dev mood 20')).text).toMatch(/^The dev server predates pet care: restart it/)
    expect(commandsOf(sent)).toEqual([])
  })
})

describe('the welcome', () => {
  const commandsOf = (sent: ReadonlyArray<Sent>) =>
    sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)
  /** The rules of a server that runs the welcome: the species, and the numbers its grading step says. */
  const welcomeRules = {
    pet: {
      moodDecayPerDay: 10,
      happyAbove: 70,
      happyXpBonusPct: 5,
      evolveAt: [10, 25, 50],
      care: { fed: 30, petted: 5, pettedPerHour: 3 },
      species: [
        { id: 'fox', name: 'Fox', about: 'quick, curious' },
        { id: 'slime', name: 'Slime', about: 'soft, cheerful' },
        { id: 'robot', name: 'Robot', about: 'steady, precise' },
        { id: 'owl', name: 'Owl', about: 'calm, wise' },
      ],
      egg: { species: 'fox', name: 'Ember' },
    },
    prompt: {
      maxXp: 20,
      perDay: [
        { upTo: 20, pct: 100 },
        { upTo: 40, pct: 50 },
        { upTo: null, pct: 10 },
      ],
      weights: { clarity: 1, grammar: 1, specificity: 1, instructive: 1, context: 1, doneCriteria: 1, focus: 1 },
    },
    loot: { promptChanceAtTen: 0.24, promptGreatAt: 9, promptGreatRareFactor: 2 },
  }
  const fresh = (): Greeting => ({ done: false, egg: { species: 'fox', name: 'Ember' }, name: 'Player' })
  const welcoming = ($: Parameters<TestBody>[0], on: On, greeting: Greeting, kept: Kept = {}) =>
    streaming($, on, undefined, false, { rules: welcomeRules, kept: { ...kept, welcome: greeting } })
  /** The pane drawn afresh, its texts, and what it holds. */
  const look = async ($: Parameters<TestBody>[0]) => {
    const ui = await mountPane($)
    const all = await ui.findAll({ type: 'Text' })
    return { ui, texts: all.map((one) => one.text).join('\n'), all }
  }
  const run = ($: Parameters<TestBody>[0], command: string, args: string) =>
    $.command.run({ command, args, origin: composer, presentation })

  test('opens on its own the first time the mod meets a server that runs it, without the keys', async ($, on) => {
    const { opened } = await welcoming($, on, fresh())
    // Opened unasked, without the keyboard: a prompt being typed keeps its keys.
    expect(opened).toEqual(['questline'])
    const { ui, texts, all } = await look($)
    expect(texts).toContain('◆ Welcome')
    expect(texts).toContain('Welcome to Path of Dev')
    expect(texts).toContain('no account, no sign-in, and your save is yours')
    // The progress row: the step shown filled in the accent, the rest dim, and how far along.
    expect(texts).toMatch(/ 1 Welcome {2}── 2 Name ── 3 Pet ── 4 Grading ── 5 Ready +1 of 5/)
    expect(all.find((one) => one.props['backgroundColor'] === 'claude')?.text).toBe(' 1 Welcome ')
    expect(await ui.find({ type: 'Button', key: 'welcome:back' })).toBeUndefined()
    expect(texts).toContain('tab moves · enter presses')
    await ui.unmount()
  })

  test('stays shut on a server older than it, which /pathofdev welcome and the tab say to restart', async ($, on) => {
    const { opened, sent } = await streaming($, on, ownedOf())
    expect(opened).toEqual([])
    const answer = await run($, 'pathofdev', 'welcome')
    expect(answer.text).toBe('The server predates the welcome: restart it with pnpm --filter @pathofdev/server start')
    expect(opened).toEqual([])
    await run($, 'pathofdev', '')
    const pane = await mountPane($)
    await pane.press({ key: 'tab:welcome' })
    await pane.unmount()
    const { ui, texts } = await look($)
    expect(texts).toContain('The server predates the welcome: restart it with')
    expect(await ui.find({ type: 'Button', key: 'welcome:next' })).toBeUndefined()
    await ui.unmount()
    expect(commandsOf(sent)).toEqual([])
  })

  test('stays shut once done', async ($, on) => {
    const { opened } = await welcoming($, on, { ...fresh(), done: true })
    expect(opened).toEqual([])
  })

  test('leaves a pane already up, as after a reload, to the player: it waits on its tab', async ($, on) => {
    const { opened } = await streaming($, on, undefined, false, {
      rules: welcomeRules,
      kept: { welcome: fresh() },
      isPaneUp: true,
    })
    expect(opened).toEqual([])
    const { ui, texts } = await look($)
    expect(texts).toContain('◆ Inventory')
    await ui.unmount()
  })

  test("names the character, picks the egg, says the rules' grading, and lands on the pane", async ($, on) => {
    const greeting = fresh()
    const { sent } = await welcoming($, on, greeting)
    let shown = await look($)
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()

    shown = await look($)
    expect(shown.texts).toContain('Name your character')
    expect(shown.texts).toMatch(/✔ Welcome ── {2}2 Name {2}── 3 Pet/)
    expect((await shown.ui.find({ type: 'Input', key: 'welcome:name' }))?.props['value']).toBe('Player')
    // Enter in the field saves the name and moves on.
    await shown.ui.input({ key: 'welcome:name', text: '  Ada  ' })
    await shown.ui.unmount()
    expect(commandsOf(sent)).toMatchObject([{ type: 'character.rename', data: { name: '  Ada  ' } }])

    shown = await look($)
    expect(shown.texts).toContain('Pick your egg')
    for (const face of ['ᓚᘏᗢ', '(•ᴗ•)', '[o_o]', '{◉,◉}', 'calm, wise']) expect(shown.texts).toContain(face)
    expect(shown.texts).toContain('never gets sick, never leaves, and never nags')
    expect(shown.all.filter((one) => one.props['backgroundColor'] === 'claude').map((one) => one.text)).toEqual([
      ' 3 Pet ',
      ' Fox ',
    ])
    await shown.ui.press({ key: 'welcome:species:owl' })
    await shown.ui.input({ key: 'welcome:petName', text: 'Hoot', kind: 'change' })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.texts).toContain('Hoot the owl · ready to hatch from the band')
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    expect(commandsOf(sent).at(-1)).toMatchObject({ type: 'egg.choose', data: { species: 'owl', name: 'Hoot' } })

    shown = await look($)
    expect(shown.texts).toContain('How grading works')
    for (const said of [
      'Once you send a prompt of 6 words or more, Haiku grades it on your own Claude account',
      "never the prompt, and never Haiku's note",
      "A day's graded prompts earn full XP for the first 20, half for the next 20 and a tenth after that.",
      'A 10 earns 20 XP and a 7 earns 14',
      'a 24% chance at a 10, less as the grade falls, and from a 9 the odds of a rare, epic or legendary drop double',
      'A low grade only earns less. Nothing is ever taken away',
      'Done criteria',
    ]) {
      expect(shown.texts).toContain(said)
    }
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()

    shown = await look($)
    expect(shown.texts).toContain("You're all set, Ada")
    expect(shown.texts).toContain('your egg, Hoot, and the mission closest to done')
    // The player's own band, drawn by the band's own code: the bar and its label, the level, the gold, the egg.
    expect(shown.texts).toContain('Your band, as it stands:')
    expect(shown.texts).toMatch(/^▰+▱+ 30\/203 xp$/m)
    expect(shown.texts).toContain('🥚 Hoot')
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    expect(commandsOf(sent).map((one) => (isRecord(one) ? one['type'] : null))).toEqual([
      'character.rename',
      'egg.choose',
      'welcome.done',
    ])

    // The pane as it is, the egg on its card as picked.
    shown = await look($)
    expect(shown.texts).toContain('◆ Inventory')
    expect(shown.texts).toContain('Hoot the owl · ready to hatch')
    expect(shown.texts).toContain('Ada · Lv 4')
    await shown.ui.unmount()
  })

  test('skips from any step, keeping the defaults, and says it once', async ($, on) => {
    const greeting = fresh()
    const { sent } = await welcoming($, on, greeting)
    let shown = await look($)
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    await shown.ui.press({ key: 'welcome:skip' })
    await shown.ui.unmount()
    expect(commandsOf(sent)).toMatchObject([{ type: 'welcome.done', data: {} }])
    shown = await look($)
    expect(shown.texts).toContain('◆ Inventory')
    expect(shown.texts).toContain('Ember the fox · ready to hatch')
    expect(shown.texts).toContain('Player · Lv 4')
    await shown.ui.unmount()
    // Done once is done: opened again and skipped again, it sends nothing more.
    await run($, 'pathofdev', 'welcome')
    shown = await look($)
    await shown.ui.press({ key: 'welcome:skip' })
    await shown.ui.unmount()
    expect(commandsOf(sent)).toHaveLength(1)
  })

  test("keeps the step on a name the server refuses, saying why in place, and a new try clears it", async ($, on) => {
    const { sent } = await welcoming($, on, fresh())
    let shown = await look($)
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    await shown.ui.input({ key: 'welcome:name', text: 'x'.repeat(30) })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.texts).toContain('Name your character')
    expect(shown.texts).toContain('A name takes at most 20 characters, and that one has 30')
    await shown.ui.input({ key: 'welcome:name', text: 'Ada', kind: 'change' })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.texts).not.toContain('A name takes at most')
    await shown.ui.unmount()
    expect(commandsOf(sent)).toHaveLength(1)
  })

  test('review fix: a Back while a step saves leaves the wizard where the player put it', async ($, on) => {
    const { sent, clock } = await streaming($, on, undefined, false, {
      rules: welcomeRules,
      kept: { welcome: fresh() },
      commandTakes: 2_000,
    })
    let shown = await look($)
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    await shown.ui.input({ key: 'welcome:name', text: 'Ada', kind: 'change' })
    // Next sends the rename, which the server is slow to answer; Back lands before it does.
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    await shown.ui.press({ key: 'welcome:back' })
    await shown.ui.unmount()
    await clock.advance(2_500)
    await until(clock, () => commandsOf(sent).length === 1)
    await clock.settle()
    shown = await look($)
    expect(shown.texts).toContain('Welcome to Path of Dev')
    expect(shown.texts).not.toContain('Pick your egg')
    await shown.ui.unmount()
  })

  test('review fix: the keys hint names as many egg keys as there are eggs, and none once hatched', () => {
    const band: BandView = {
      name: 'Player',
      level: 0,
      title: 'Apprentice',
      glyph: '⚔',
      xp: { total: 0, intoLevel: 0, forNextLevel: 100 },
      gold: 0,
      isDev: false,
      pet: null,
    }
    const species = welcomeRules.pet.species.slice(0, 3)
    const view: WelcomeView = {
      isKnown: true,
      isDone: false,
      species,
      egg: { species: 'fox', name: 'Ember' },
      grading: { minWords: 6, maxXp: 20, perDay: null, counted: [], lootAtTen: null, greatAt: null, greatFactor: null },
    }
    const keys = (shown: WelcomeView, pet: BandView['pet'] = null) =>
      welcomeLayout({
        view: shown,
        band: { ...band, pet },
        wizard: { ...freshWizard, step: 'pet' },
        columns: 72,
        isFocused: true,
        hasInput: true,
      })
        .keys.map((run) => run.text)
        .join('')
    expect(keys(view)).toBe('tab moves · enter presses · 1-3 picks an egg · esc hands the keys back')
    expect(keys({ ...view, species: species.slice(0, 1) })).toContain(' · 1 picks the egg · ')
    expect(keys(view, { species: 'fox', name: 'Ember', form: 0, mood: 90 })).toBe(
      'tab moves · enter presses · esc hands the keys back',
    )
  })

  test('online, the welcome says where the game plays and that a GitHub sign-in holds it', () => {
    const band: BandView = {
      name: 'Player',
      level: 0,
      title: 'Apprentice',
      glyph: '⚔',
      xp: { total: 0, intoLevel: 0, forNextLevel: 100 },
      gold: 0,
      isDev: false,
      pet: null,
    }
    const view: WelcomeView = {
      isKnown: true,
      isDone: false,
      species: [],
      egg: null,
      grading: { minWords: 6, maxXp: 20, perDay: null, counted: [], lootAtTen: null, greatAt: null, greatFactor: null },
    }
    const words = (step: WelcomeStep, online?: string) => {
      const layout = welcomeLayout({
        view,
        band,
        wizard: { ...freshWizard, step },
        columns: 200,
        isFocused: true,
        hasInput: true,
        ...(online === undefined ? {} : { online }),
      })
      const points = layout.part.kind === 'points' ? layout.part.points.map((point) => point.text) : []
      return [...layout.paragraphs, ...points].map((row) => row.map((run) => run.text).join('')).join('\n')
    }
    expect(words('hello')).toContain('It all plays on this machine: no account, no sign-in')
    expect(words('grading')).toContain('The game server, here on your machine, gets its scores')
    const online = 'https://api.pathof.dev'
    expect(words('hello', online)).not.toContain('no sign-in')
    expect(words('hello', online)).toContain('You play on the online server at https://api.pathof.dev, signed in with GitHub')
    expect(words('grading', online)).toContain('The game server, at https://api.pathof.dev, gets its scores')
  })

  test('review fix: says what a 7 earns as the engine prices it, to the thousandth', () => {
    expect(xpText(25)).toBe('A 10 earns 25 XP and a 7 earns 17.5, before your sigil and boosts.')
    expect(xpText(20)).toBe('A 10 earns 20 XP and a 7 earns 14, before your sigil and boosts.')
  })

  test('shows a pet that has hatched as it is, with no egg to pick, and sends no pick', async ($, on) => {
    const goo = { species: 'slime', name: 'Goo', form: 0, mood: 90, equipped: {} }
    const { sent } = await welcoming($, on, { ...fresh(), egg: null }, { pet: goo })
    let shown = await look($)
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.texts).toContain('Your pet')
    expect(shown.texts).toContain('(•ᴗ•)  Goo the slime')
    expect(shown.texts).toContain('It has hatched, and a pet keeps its species and name for good.')
    expect(await shown.ui.find({ type: 'Button', key: 'welcome:species:fox' })).toBeUndefined()
    expect(await shown.ui.find({ type: 'Input', key: 'welcome:petName' })).toBeUndefined()
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    expect(commandsOf(sent)).toEqual([])
    shown = await look($)
    expect(shown.texts).toContain('How grading works')
    await shown.ui.unmount()
  })

  test('opens again from /pathofdev and /questline welcome with what the player has, sending none', async ($, on) => {
    const { opened, sent } = await welcoming($, on, { done: true, egg: { species: 'owl', name: 'Hoot' }, name: 'Ada' })
    expect(opened).toEqual([])
    expect((await run($, 'pathofdev', 'welcome')).text).toBe('The Path of Dev welcome is open.')
    expect((await run($, 'questline', ' welcome ')).text).toMatch(/^The Path of Dev welcome is open\./)
    // Asked for, so it asks for the keyboard.
    expect(opened).toEqual(['questline+focus', 'questline+focus'])
    let shown = await look($)
    expect(await shown.ui.find({ type: 'Button', key: 'welcome:skip', text: 'Close' })).toBeDefined()
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    expect((await shown.ui.find({ type: 'Input', key: 'welcome:name' }))?.props['value']).toBe('Ada')
    await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.all.filter((one) => one.props['backgroundColor'] === 'claude').map((one) => one.text)).toEqual([
      ' 3 Pet ',
      ' Owl ',
    ])
    expect((await shown.ui.find({ type: 'Input', key: 'welcome:petName' }))?.props['value']).toBe('Hoot')
    for (let i = 0; i < 3; i++) await shown.ui.press({ key: 'welcome:next' })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.texts).toContain('◆ Inventory')
    await shown.ui.unmount()
    expect(commandsOf(sent)).toEqual([])
  })

  test("the egg card's Change opens the welcome on the egg", async ($, on) => {
    await welcoming($, on, { ...fresh(), done: true })
    await run($, 'pathofdev', '')
    let shown = await look($)
    expect(shown.texts).toContain('Ember the fox · ready to hatch')
    await shown.ui.press({ key: 'pet:change' })
    await shown.ui.unmount()
    shown = await look($)
    expect(shown.texts).toContain('Pick your egg')
    await shown.ui.unmount()
  })

  test('a close by the player sets it aside, as Skip does; a reload, its own close or another tab does not', () => {
    expect(closeSetsAside('person', 'welcome')).toBe(true)
    expect(closeSetsAside('unload', 'welcome')).toBe(false)
    expect(closeSetsAside('plugin', 'welcome')).toBe(false)
    expect(closeSetsAside('person', 'inventory')).toBe(false)
  })

  test('leaving it for another tab sets it aside too', async ($, on) => {
    const { sent } = await welcoming($, on, fresh())
    const shown = await look($)
    await shown.ui.press({ key: 'tab:shop' })
    await shown.ui.unmount()
    expect(commandsOf(sent)).toMatchObject([{ type: 'welcome.done' }])
  })

  test('the band hatches the egg as picked; an older server hatches the fox Ember, as before', async ($, on) => {
    const { sent } = await welcoming($, on, { ...fresh(), done: true, egg: { species: 'robot', name: 'Bolt' } })
    const ui = await $.ui.mount({ plugin: 'questline', surface: 'terminal', component: 'AbovePrompt', props: bandOf() })
    await ui.press({ key: 'hatch' })
    await ui.unmount()
    expect(commandsOf(sent)).toMatchObject([{ type: 'pet.hatch', data: { species: 'robot', name: 'Bolt' } }])
  })

  test('says the grading in words from whatever bands the rules give, and fits its progress row at every width', () => {
    expect(taperText([{ upTo: null, pct: 100 }])).toBe("A day's graded prompts earn full XP for every one.")
    expect(
      taperText([
        { upTo: 10, pct: 100 },
        { upTo: 30, pct: 25 },
      ]),
    ).toBe("A day's graded prompts earn full XP for the first 10, a quarter for the next 20 and nothing after that.")
    expect(taperText(null)).toBeNull()
    expect(lootText({ lootAtTen: 0.3, greatAt: 8, greatFactor: 3 })).toBe(
      'It also rolls for loot: a 30% chance at a 10, less as the grade falls, and from a 8 the odds of a rare, ' +
        'epic or legendary drop triple.',
    )
    expect(lootText({ lootAtTen: null, greatAt: null, greatFactor: null })).toBe(
      'It also rolls for loot, likelier the better the grade.',
    )
    expect(xpText(null)).toBe('The better the grade, the more XP the prompt earns.')
    for (const step of ['hello', 'name', 'pet', 'grading', 'ready'] satisfies Array<WelcomeStep>) {
      for (let width = 16; width <= 80; width += 4) {
        expect(cellsOfRow(stepperRow(step, width))).toBeLessThanOrEqual(width)
      }
    }
    const narrow = stepperRow('grading', 30).map((run) => run.text).join('')
    expect(narrow).toMatch(/^● ● ● {2}Grading {2}○ +4 of 5$/)
    expect(cellsOf(narrow)).toBe(30)
  })
})

describe('switching servers', () => {
  const run = ($: Parameters<TestBody>[0], args: string, command = 'pathofdev') =>
    $.command.run({ command, args, origin: composer, presentation })
  const own = '/home/player/.pathofdev/server.sock'
  const sandbox = '/home/player/.pathofdev-dev/server.sock'
  const sessionOf = (body: unknown): string =>
    isRecord(body) && typeof body['sessionId'] === 'string' ? body['sessionId'] : ''
  const opensOn = (sent: ReadonlyArray<Sent>, socket: string) =>
    sent.filter((one) => one.path === '/v1/sessions' && one.socket === socket).map((one) => sessionOf(one.body))
  const closesOn = (sent: ReadonlyArray<Sent>, socket: string) =>
    sent.filter((one) => one.method === 'DELETE' && one.socket === socket).map((one) => one.path)
  const typesOn = (sent: ReadonlyArray<Sent>, socket: string) =>
    eventsOf(sent.filter((one) => one.socket === socket)).map((event) => event['type'])
  const messages: Array<SessionMessage> = [{ role: 'user', text: 'Fix the parser', toolUses: [] }]

  /** The /config rows beneath the mod, its Server option among them, and every value a plugin writes to one. */
  const settings = (on: On, isLocked = false) => {
    const written: Array<{ key: string; value: unknown }> = []
    const theme: ConfigRow = {
      key: 'theme',
      label: 'Theme',
      kind: 'choice',
      value: 'dark',
      options: ['dark', 'light'],
      provider: { plugin: 'engine', tier: 'core' },
      isLocked: false,
    }
    const server: ConfigRow = {
      key: 'questline.server',
      label: 'Server',
      kind: 'choice',
      value: 'default',
      options: ['default', 'dev', 'online'],
      provider: { plugin: 'questline', tier: 'user' },
      isLocked,
    }
    on('config.list', () => ({ value: [theme, server] }))
    on('config.set', ($, e) => {
      written.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    return written
  }

  test('/pathofdev server says where the mod plays and how to switch; a bad one gets the usage', async ($, on) => {
    const written = settings(on)
    await streaming($, on, ownedOf())
    const where = 'Playing on your own save (~/.pathofdev). Switch with /pathofdev server play, dev or online.'
    expect((await run($, 'server')).text).toBe(where)
    expect((await run($, 'server', 'questline')).text).toContain(where)
    for (const args of ['server mars', 'server toString', 'server __proto__', 'server dev now', 'server play please']) {
      expect((await run($, args)).text).toMatch(/^Servers: \/pathofdev server play/)
    }
    expect((await run($, 'server play')).text).toBe('Already playing on your own save (~/.pathofdev).')
    expect((await run($, 'server default')).text).toBe('Already playing on your own save (~/.pathofdev).')
    expect((await run($, 'dev off')).text).toBe('Already playing on your own save (~/.pathofdev).')
    expect((await run($, 'dev')).text).toContain('/pathofdev dev off back to your own save')
    expect(written).toEqual([])
  })

  test('server dev writes the option, flushes and closes the last server, and plays on the sandbox at once', async ($, on) => {
    const written = settings(on)
    const { sent, clock } = await streaming($, on, ownedOf())
    const [first] = opensOn(sent, own)
    // A compaction waits in the queue for the player's own save, till the next flush.
    await $.session.compact({ trigger: 'manual', messages })
    expect((await run($, 'server dev')).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    expect(written).toEqual([{ key: 'questline.server', value: 'dev' }])
    expect(typesOn(sent, own)).toContain('session.compacted')
    expect(closesOn(sent, own)).toEqual([`/v1/sessions/${first}`])
    const [opened] = opensOn(sent, sandbox)
    expect(opened).not.toBe(first)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream' && one.socket === sandbox))
    expect((await run($, 'server')).text).toMatch(/^Playing on the dev sandbox \(~\/\.pathofdev-dev\)\./)
    // What the mod sends from now on goes to the sandbox, even once the last server's stream has answered.
    await clock.advance(30_000)
    await $.session.compact({ trigger: 'auto', messages })
    await clock.advance(30_000)
    await clock.settle()
    expect(typesOn(sent, sandbox)).toContain('session.compacted')
    expect(typesOn(sent, own)).toHaveLength(1)
  })

  test("an event the last server's stream brings after a switch is not shown", async ($, on) => {
    settings(on)
    const { send, toasts } = await streaming($, on, ownedOf(), false, { streamsOn: own })
    expect((await run($, 'server dev')).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    // The stream the mod held on the player's own save answers now, with an XP gain from there.
    await send(xpGranted(40))
    expect(toasts).toEqual([])
    expect((await band($)).all).not.toContain('+40')
  })

  test("dev off takes the sandbox's controls down, and says how to start a save that isn't running", { options: { server: 'dev' } }, async ($, on) => {
    const written = settings(on)
    const listensOn = { at: sandbox }
    await streaming($, on, ownedOf(), true, { listensOn })
    expect((await paneTexts($, 72)).texts).toContain('Dev')
    expect((await paneTexts($, 72)).texts.join('\n')).toMatch(/PATH OF DEV ✦ dev/)
    expect((await run($, 'dev off')).text).toBe(
      "Now playing on your own save (~/.pathofdev). It isn't running: start it with " +
        'pnpm --filter @pathofdev/server start',
    )
    expect(written).toEqual([{ key: 'questline.server', value: 'default' }])
    const pane = (await paneTexts($, 72)).texts
    expect(pane).not.toContain('Dev')
    expect(pane.join('\n')).not.toMatch(/PATH OF DEV ✦ dev/)
    expect(pane.join('\n')).not.toContain('Lv 4')
    expect((await run($, 'server')).text).toBe(
      'Playing on your own save (~/.pathofdev). Switch with /pathofdev server play, dev or online. ' +
        "It isn't running: start it with pnpm --filter @pathofdev/server start",
    )
  })

  test("each server's queue waits for that server: the sandbox's goes to it when the mod comes back", { options: { server: 'dev' } }, async ($, on) => {
    settings(on)
    const listensOn = { at: sandbox }
    const { sent, clock } = await streaming($, on, ownedOf(), true, { listensOn })
    // The sandbox stops; a compaction there waits for it.
    listensOn.at = own
    await $.session.compact({ trigger: 'manual', messages })
    expect((await run($, 'dev off')).text).toBe('Now playing on your own save (~/.pathofdev).')
    await clock.advance(30_000)
    await clock.settle()
    expect(typesOn(sent, own)).toEqual([])
    listensOn.at = sandbox
    expect((await run($, 'server dev')).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    await until(clock, () => typesOn(sent, sandbox).includes('session.compacted'))
    expect(typesOn(sent, own)).toEqual([])
  })

  test('server online with no token says so, sends nothing there, and keeps the token off the local socket', async ($, on) => {
    const written = settings(on)
    const { sent } = await streaming($, on, ownedOf())
    const before = sent.length
    expect((await run($, 'server online')).text).toBe(
      "Now playing on the online server at https://api.pathof.dev. You're not signed in to https://api.pathof.dev, " +
        'so the mod waits offline and keeps what you do queued for it: /pathofdev login signs you in.',
    )
    expect(written).toEqual([{ key: 'questline.server', value: 'online' }])
    expect(sent.slice(before).every((one) => one.socket === own && one.method === 'DELETE')).toBe(true)
    expect((await paneTexts($, 72)).texts.join('\n')).toMatch(/PATH OF DEV ✦ online/)
  })

  test("the last server's stream answering late leaves the new server first in line", async ($, on) => {
    settings(on)
    const { sent, clock, send } = await streaming($, on, ownedOf(), false, { streamsOn: sandbox })
    expect((await run($, 'server dev')).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    // The sandbox's stream answers ten seconds in and is held again, till well after the one on the player's own save
    // answers at 25 seconds; the flush at 30 seconds comes between them.
    await clock.advance(10_000)
    await send(xpGranted(5))
    await clock.advance(16_000)
    await clock.settle()
    const before = sent.length
    await $.session.compact({ trigger: 'manual', messages })
    await clock.advance(5_000)
    await clock.settle()
    expect(typesOn(sent.slice(before), own)).toEqual([])
    expect(typesOn(sent.slice(before), sandbox)).toContain('session.compacted')
  })

  test('a flush under way at a switch sends nothing more of the last queue, and none of it to the new server', async ($, on) => {
    settings(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    const waiting = Array.from({ length: 150 }, (_, i) => ({
      id: `waiting-${i}`,
      occurredAt: '2026-10-09T07:00:00.000Z',
      sessionId: 'earlier',
      type: 'session.cleared',
      data: {},
    }))
    mock.store(on, { explored: ['acme/widgets'], queue: waiting })
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock, { eventsTake: 2_000 })
    await $.session.start(start)
    // The first batch of 100 is out to the player's own save, which takes its time.
    await until(clock, () => sent.some((one) => one.path === '/v1/events'))
    const answer = run($, 'server dev')
    await clock.advance(1_000)
    expect((await answer).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    await clock.advance(5_000)
    await clock.settle()
    const waitingOn = (socket: string) =>
      eventsOf(sent.filter((one) => one.socket === socket)).filter((event) =>
        String(event['id']).startsWith('waiting-'),
      )
    expect(waitingOn(sandbox)).toEqual([])
    expect(waitingOn(own)).toHaveLength(100)
  })

  /** A store the test reads straight, which can hold one key's read a second, as a slow host would. */
  const storeOf = (on: On, clock: Clock, entries: Record<string, unknown> = {}) => {
    const kept = new Map<string, unknown>(Object.entries({ explored: ['acme/widgets'], ...entries }))
    const slow = { key: '' }
    on('store.get', async ($, e) => {
      if (e.key === slow.key) await clock.sleep(1_000)
      return { value: kept.get(e.key) }
    })
    on('store.set', ($, e) => {
      kept.set(e.key, e.value)
      return { value: undefined }
    })
    return { kept, slow }
  }
  const origin = 'https://api.pathof.dev'

  test('review fix: a commit right after a switch to online names no repo there', async ($, on) => {
    settings(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    const { kept } = storeOf(on, clock)
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock)
    on('tool.call', { tool: 'Bash' }, () => ({
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        gitOperation: { commit: { sha: 'a'.repeat(40), kind: 'committed', branch: 'main' } },
      },
    }))
    await $.session.start(start)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    expect((await run($, 'server online')).text).toMatch(/^Now playing on the online server at https:\/\/api\.pathof\.dev\./)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add widgets"' })
    await clock.settle()
    const online = JSON.stringify(kept.get(`queue@${origin}`))
    expect(online).toContain('commit.made')
    expect(online).not.toContain('acme')
  })

  test('review fix: a batch that set out for the online server goes there, even as a switch lands', { options: { server: 'online' } }, async ($, on) => {
    settings(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    const { slow } = storeOf(on, clock, { [`token@${origin}`]: 'pod_test', [`explored@${origin}`]: ['acme/widgets'] })
    mock.env(on, { HOME: '/home/player' })
    const { sent } = fakeServer(on, clock)
    await $.session.start(start)
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    await $.session.compact({ trigger: 'manual', messages })
    // The flush at 30 seconds reads the token slowly; the switch to the sandbox lands while it waits.
    slow.key = `token@${origin}`
    await clock.advance(30_000)
    const answer = run($, 'server dev')
    await clock.advance(3_000)
    expect((await answer).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    await clock.advance(3_000)
    await clock.settle()
    expect(typesOn(sent, sandbox)).toEqual([])
    expect(typesOn(sent, '')).toContain('session.compacted')
  })

  test('review fix: the reload the option sets off as it is written opens a new session, not the closed one', async ($, on) => {
    on('config.list', () => ({
      value: [
        {
          key: 'questline.server',
          label: 'Server',
          kind: 'choice',
          value: 'default',
          options: ['default', 'dev', 'online'],
          provider: { plugin: 'questline', tier: 'user' },
          isLocked: false,
        } satisfies ConfigRow,
      ],
    }))
    // The engine reloads the mod as it writes the option: the reload's session.start, and the connect it sets off,
    // run before the write returns.
    const clocked: { clock: Clock | null } = { clock: null }
    on('config.set', async ($$, e) => {
      await $.session.start(start)
      await clocked.clock?.advance(100)
      return { value: e.value }
    })
    const { sent, clock } = await streaming($, on, ownedOf())
    clocked.clock = clock
    const [first] = opensOn(sent, own)
    expect((await run($, 'server dev')).text).toBe('Now on the dev sandbox (~/.pathofdev-dev).')
    expect(closesOn(sent, own)).toEqual([`/v1/sessions/${first}`])
    expect(opensOn(sent, own).filter((id) => id === first)).toHaveLength(1)
  })

  test('a Server option the settings pin stays, and the mod plays where it did', async ($, on) => {
    const written = settings(on, true)
    const { sent } = await streaming($, on, ownedOf())
    expect((await run($, 'server dev')).text).toBe(
      'Your managed settings pin the Server option, so the mod stays where it plays.',
    )
    expect(written).toEqual([])
    expect(closesOn(sent, own)).toEqual([])
    expect(opensOn(sent, sandbox)).toEqual([])
  })
})

describe('signing in', () => {
  const run = ($: Parameters<TestBody>[0], args: string) =>
    $.command.run({ command: 'pathofdev', args, origin: composer, presentation })
  const origin = 'https://api.pathof.dev'
  const tokenKey = `token@${origin}`
  const queueKey = `queue@${origin}`
  const githubToken = 'gho_16C7e42F292c6912E7710c838347Ae178B4a'
  const messages: Array<SessionMessage> = [{ role: 'user', text: 'Fix the parser', toolUses: [] }]
  const t0 = Date.parse('2026-10-09T08:00:00Z')

  /** A store the test reads straight. */
  const storeOf = (on: On, entries: Record<string, unknown>) => {
    const kept = new Map<string, unknown>(Object.entries({ [`explored@${origin}`]: ['acme/widgets'], ...entries }))
    on('store.get', ($, e) => ({ value: kept.get(e.key) }))
    on('store.set', ($, e) => {
      kept.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      kept.delete(e.key)
      return { value: undefined }
    })
    return kept
  }

  const accountsOf = (...tokens: Array<string>): Accounts => ({
    tokens: new Set(tokens),
    githubToken,
    issue: 'pod_issued',
    login: 'octocat',
  })
  const githubOf = (polls: Array<string | number>, device: string | number = recorded.deviceCode): GitHubFake => ({
    device,
    polls,
    seen: [],
  })
  /** The polls GitHub got, as ms after the session started. */
  const pollsOf = (github: GitHubFake) =>
    github.seen.filter((one) => one.url.endsWith('/access_token')).map((one) => one.at - t0)

  /** A session on the online server, with the store, GitHub and the server's accounts as given. */
  const online = async (
    $: Parameters<TestBody>[0],
    on: On,
    entries: Record<string, unknown>,
    more: { github?: GitHubFake; accounts: Accounts },
  ) => {
    const clock = mock.clock(on, { now: t0 })
    const kept = storeOf(on, entries)
    mock.env(on, { HOME: '/home/player' })
    const server = fakeServer(on, clock, { level: 4, ...more })
    await $.session.start(start)
    // Connected, or offline: signed out, or turned away.
    await until(clock, async () => /offline|Lv 4/.test((await band($).catch(() => ({ all: "" }))).all))
    return { clock, kept, ...server }
  }

  test(
    'login runs the device flow as GitHub asks, trades the token at its origin, and plays on at once',
    { options: { server: 'online' } },
    async ($, on) => {
      const github = githubOf([recorded.pending, recorded.slowDown, recorded.success])
      const accounts = accountsOf()
      const { clock, kept, sent, toasts } = await online($, on, {}, { github, accounts })
      expect((await band($)).all).toContain('offline · sign in with /pathofdev login')
      // Signed out, what the player does waits in the queue.
      await $.session.compact({ trigger: 'manual', messages })
      expect(JSON.stringify(kept.get(queueKey))).toContain('session.compacted')
      expect((await run($, 'login')).text).toBe(
        'To sign in to https://api.pathof.dev, open https://github.com/login/device and enter WDJB-MJHT (it works ' +
          "for 15 minutes). GitHub tells the server only who you are; the mod says when you're in, and what you do " +
          'meanwhile waits in the queue.',
      )
      expect((await run($, 'login')).text).toBe(
        'A sign-in is under way: open https://github.com/login/device and enter WDJB-MJHT.',
      )
      // Pending at 5 s, slow_down at 10 s (the interval goes to 10 s), the token at 20 s.
      await clock.advance(5_000)
      await clock.advance(5_000)
      await clock.advance(9_000)
      await clock.settle()
      expect(kept.get(tokenKey)).toBeUndefined()
      await clock.advance(1_000)
      await until(clock, () => kept.get(tokenKey) === 'pod_issued')
      expect(pollsOf(github)).toEqual([5_000, 10_000, 20_000])
      // GitHub hears the client id and the device code alone, with no Authorization.
      for (const seen of github.seen) {
        const init = seen.init as { headers?: Record<string, string>; body?: string }
        expect(init.headers?.['authorization']).toBeUndefined()
        expect(init.body).toContain('client_id=Ov23liaxznq5Qln0tRis')
        expect(init.body).not.toContain('scope')
      }
      const [signIn, ...again] = sent.filter((one) => one.path === '/v1/auth/github')
      expect(again).toEqual([])
      expect(signIn?.authorization).toBeUndefined()
      expect(signIn?.body).toMatchObject({ githubToken })
      const zone = isRecord(signIn?.body) ? signIn.body['timezone'] : undefined
      expect(typeof zone === 'string' && zone !== '').toBe(true)
      // The GitHub token is kept nowhere.
      expect(JSON.stringify([...kept.values()])).not.toContain('gho_')
      expect(toasts).toContain('Signed in to https://api.pathof.dev as octocat.')
      // The mod plays on at once: a session opens with the game token, and what waited goes.
      await until(clock, () => eventsOf(sent).some((event) => event['type'] === 'session.compacted'))
      expect(sent.some((one) => one.path === '/v1/sessions' && one.authorization === 'Bearer pod_issued')).toBe(true)
      const batches = sent.filter((one) => one.path === '/v1/events')
      expect(batches.every((one) => one.authorization === 'Bearer pod_issued')).toBe(true)
      expect(kept.get(queueKey)).toEqual([])
      expect((await band($)).all).toContain('Lv 4')
      expect((await run($, 'login')).text).toBe(
        "You're signed in to https://api.pathof.dev. /pathofdev logout signs you out.",
      )
    },
  )

  test('a code that expires ends the sign-in before it does: no poll after', { options: { server: 'online' } }, async ($, on) => {
    const device = JSON.stringify({ ...JSON.parse(recorded.deviceCode), expires_in: 12 })
    const github = githubOf([recorded.pending], device)
    const { clock, kept, toasts } = await online($, on, {}, { github, accounts: accountsOf() })
    expect((await run($, 'login')).text).toMatch(/enter WDJB-MJHT \(it works for 1 minute\)/)
    await clock.advance(60_000)
    await clock.settle()
    // Polls at 5 and 10 seconds; the next would come at 15, after the code expired at 12.
    expect(pollsOf(github)).toEqual([5_000, 10_000])
    expect(toasts).toContain('The GitHub sign-in code expired: /pathofdev login gives you a new one.')
    expect(kept.get(tokenKey)).toBeUndefined()
  })

  test("GitHub's access_denied or expired_token ends the sign-in, and a toast says so", { options: { server: 'online' } }, async ($, on) => {
    const github = githubOf([recorded.denied])
    const { clock, toasts } = await online($, on, {}, { github, accounts: accountsOf() })
    await run($, 'login')
    await clock.advance(60_000)
    await clock.settle()
    expect(pollsOf(github)).toEqual([5_000])
    expect(toasts).toContain('The GitHub sign-in was cancelled: /pathofdev login starts another.')
    github.polls = [recorded.pending, recorded.expired]
    github.seen.length = 0
    await run($, 'login')
    await clock.advance(60_000)
    await clock.settle()
    expect(pollsOf(github)).toEqual([65_000, 70_000])
    expect(toasts).toContain('The GitHub sign-in code expired: /pathofdev login gives you a new one.')
  })

  test('GitHub down or limiting while it polls keeps the sign-in waiting', { options: { server: 'online' } }, async ($, on) => {
    const github = githubOf([502, 429, recorded.success])
    const { clock, kept } = await online($, on, {}, { github, accounts: accountsOf() })
    await run($, 'login')
    await clock.advance(5_000)
    await clock.advance(5_000)
    await clock.advance(5_000)
    await until(clock, () => kept.get(tokenKey) === 'pod_issued')
    expect(pollsOf(github)).toEqual([5_000, 10_000, 15_000])
  })

  test(
    'a sign-in the server turns down, or GitHub cannot check, leaves the sign-in as it was',
    { options: { server: 'online' } },
    async ($, on) => {
      const github = githubOf([recorded.success])
      const accounts = accountsOf()
      accounts.signIn = { status: 401, body: { _tag: 'Unauthorized', message: 'not in the beta' } }
      const { clock, kept, toasts } = await online($, on, { [tokenKey]: 'pod_old' }, { github, accounts })
      // The token it held is one the server no longer takes: signed out, said once.
      expect(toasts).toEqual([
        'The Path of Dev server at https://api.pathof.dev signed you out: /pathofdev login signs you in again.',
      ])
      expect((await run($, 'login')).text).toMatch(/^To sign in to https:\/\/api\.pathof\.dev, open/)
      await clock.advance(5_000)
      await until(clock, () => toasts.length === 2)
      expect(toasts[1]).toBe('The Path of Dev server at https://api.pathof.dev turned the sign-in down: not in the beta.')
      expect(kept.get(tokenKey)).toBe('pod_old')
      accounts.signIn = { status: 503, body: { _tag: 'GitHubUnavailable', message: 'GitHub is down' } }
      await run($, 'login')
      await clock.advance(5_000)
      await until(clock, () => toasts.length === 3)
      expect(toasts[2]).toBe("The sign-in can't be checked right now (GitHub or the server is busy): try /pathofdev login again in a minute.")
      expect(kept.get(tokenKey)).toBe('pod_old')
    },
  )

  test('a new sign-in revokes the token it replaces', { options: { server: 'online' } }, async ($, on) => {
    const github = githubOf([recorded.success])
    const { clock, kept, sent } = await online($, on, { [tokenKey]: 'pod_old' }, { github, accounts: accountsOf() })
    await run($, 'login')
    await clock.advance(5_000)
    await until(clock, () => sent.some((one) => one.path === '/v1/auth/logout'))
    expect(kept.get(tokenKey)).toBe('pod_issued')
    const revoked = sent.filter((one) => one.path === '/v1/auth/logout')
    expect(revoked.map((one) => [one.method, one.authorization])).toEqual([['POST', 'Bearer pod_old']])
  })

  test('a 401 keeps every event queued, says to sign in, and knocks only once a minute', { options: { server: 'online' } }, async ($, on) => {
    const waiting = futureEvents(3).map((event) => ({ ...event, type: 'session.cleared' }))
    const entries = { [tokenKey]: 'pod_revoked', [queueKey]: waiting }
    const { clock, kept, sent, toasts } = await online($, on, entries, { accounts: accountsOf() })
    await $.session.compact({ trigger: 'manual', messages })
    await clock.advance(120_000)
    await clock.settle()
    // Each flush was answered 401, and settled nothing.
    expect(sent.some((one) => one.path === '/v1/events' && one.authorization === 'Bearer pod_revoked')).toBe(true)
    const queued = kept.get(queueKey) as Array<{ id: string; type: string }>
    expect(queued.slice(0, 3)).toEqual(waiting)
    expect(queued.map((event) => event.type)).toContain('session.compacted')
    expect(toasts.filter((text) => text.includes('signed you out'))).toHaveLength(1)
    expect((await band($)).all).toContain('offline · sign in with /pathofdev login')
    expect((await run($, 'server')).text).toBe(
      'Playing on the online server at https://api.pathof.dev. Switch with /pathofdev server play, dev or online. ' +
        "You're not signed in to https://api.pathof.dev, so the mod waits offline and keeps what you do queued for " +
        'it: /pathofdev login signs you in.',
    )
    // Signed out, it opens a session once a minute, not every five seconds.
    expect(sent.filter((one) => one.path === '/v1/sessions').length).toBeLessThanOrEqual(3)
  })

  test('logout revokes the token, forgets it, and keeps the queue', { options: { server: 'online' } }, async ($, on) => {
    const accounts = accountsOf('pod_live')
    const { clock, kept, sent } = await online($, on, { [tokenKey]: 'pod_live' }, { accounts })
    await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
    await $.session.compact({ trigger: 'manual', messages })
    expect((await run($, 'logout')).text).toBe(
      'Signed out of https://api.pathof.dev. What you do waits in the queue until you sign in again.',
    )
    const revoked = sent.filter((one) => one.path === '/v1/auth/logout')
    expect(revoked.map((one) => [one.method, one.authorization])).toEqual([['POST', 'Bearer pod_live']])
    expect(accounts.tokens.size).toBe(0)
    expect(kept.has(tokenKey)).toBe(false)
    expect(JSON.stringify(kept.get(queueKey))).toContain('session.compacted')
    expect((await band($)).all).toContain('offline · sign in with /pathofdev login')
    expect((await run($, 'logout')).text).toBe("You're not signed in to https://api.pathof.dev.")
  })

  test('logout forgets a token the server answers 401, and keeps one it could not revoke', { options: { server: 'online' } }, async ($, on) => {
    const accounts = accountsOf('pod_live')
    accounts.logout = 503
    const { kept } = await online($, on, { [tokenKey]: 'pod_live' }, { accounts })
    expect((await run($, 'logout')).text).toBe(
      "The Path of Dev server at https://api.pathof.dev answered 503, so you're still signed in: try /pathofdev " +
        'logout again later.',
    )
    expect(kept.get(tokenKey)).toBe('pod_live')
    accounts.logout = 401
    expect((await run($, 'logout')).text).toMatch(/^Signed out of https:\/\/api\.pathof\.dev\./)
    expect(kept.has(tokenKey)).toBe(false)
  })

  test('logout stops a sign-in under way: no poll after it', { options: { server: 'online' } }, async ($, on) => {
    const github = githubOf([recorded.pending])
    const { clock } = await online($, on, {}, { github, accounts: accountsOf() })
    await run($, 'login')
    await clock.advance(5_000)
    await clock.settle()
    expect((await run($, 'logout')).text).toBe(
      "The sign-in under way is stopped. You're not signed in to https://api.pathof.dev.",
    )
    await clock.advance(60_000)
    await clock.settle()
    expect(pollsOf(github)).toEqual([5_000])
  })

  test('on a local server, login and logout say sign-in is for the online server, and ask GitHub nothing', async ($, on) => {
    const github = githubOf([recorded.success])
    await streaming($, on, ownedOf(), false, { github })
    const local =
      'You play on your own save (~/.pathofdev), which needs no sign-in. /pathofdev server online switches to the ' +
      'online server.'
    expect((await run($, 'login')).text).toBe(local)
    expect((await run($, 'logout')).text).toBe(local)
    expect((await run($, 'login now')).text).toMatch(/^Sign-in: \/pathofdev login/)
    expect(github.seen).toEqual([])
  })
})

describe('the beta list', () => {
  const run = ($: Parameters<TestBody>[0], args: string) =>
    $.command.run({ command: 'pathofdev', args, origin: composer, presentation })
  const origin = 'https://api.pathof.dev'
  const t0 = Date.parse('2026-10-09T08:00:00Z')

  /** A session on the online server, holding `token` (none when null), whose admins hold `admins`. */
  const online = async ($: Parameters<TestBody>[0], on: On, token: string | null, admins: Array<string>) => {
    const clock = mock.clock(on, { now: t0 })
    const kept = new Map<string, unknown>([[`explored@${origin}`, ['acme/widgets']]])
    if (token !== null) kept.set(`token@${origin}`, token)
    on('store.get', ($, e) => ({ value: kept.get(e.key) }))
    on('store.set', ($, e) => {
      kept.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      kept.delete(e.key)
      return { value: undefined }
    })
    mock.env(on, { HOME: '/home/player' })
    const accounts: Accounts = {
      tokens: new Set(['pod_admin', 'pod_player']),
      githubToken: 'gho_unused',
      issue: 'pod_issued',
      login: 'octocat',
      beta: { admins: new Set(admins), logins: new Map() },
    }
    const server = fakeServer(on, clock, { level: 4, accounts })
    await $.session.start(start)
    await until(clock, async () => /offline|Lv 4/.test((await band($).catch(() => ({ all: '' }))).all))
    const asked = () => server.sent.filter((one) => one.path.startsWith('/v1/beta'))
    return { clock, accounts, asked, ...server }
  }

  test("an admin adds, lists and removes logins, and sees the server's answer", { options: { server: 'online' } }, async ($, on) => {
    const { accounts, asked } = await online($, on, 'pod_admin', ['pod_admin'])
    expect((await run($, 'beta add Octo-Cat')).text).toBe('Octo-Cat is on the beta list now: they can sign in.')
    expect((await run($, 'beta add octo-cat')).text).toBe('octo-cat was on the beta list already: nothing changed.')
    expect((await run($, 'beta list')).text).toBe(
      [
        'The beta list on https://api.pathof.dev:',
        '- added from the mod: Octo-Cat (2026-10-09)',
        '- ALLOWED_LOGINS (a redeploy changes these): bob',
        '- admins, always in (ADMIN_GITHUB_IDS): root (id 7)',
      ].join('\n'),
    )
    expect((await run($, 'beta remove OCTO-cat')).text).toBe(
      'OCTO-cat is off the beta list: their next request is turned away.',
    )
    expect(accounts.beta?.logins.size).toBe(0)
    // Each ask went to the online origin with the game token, on its own route.
    expect(asked().map((one) => [one.method, one.path, one.body, one.authorization])).toEqual([
      ['POST', '/v1/beta', { login: 'Octo-Cat' }, 'Bearer pod_admin'],
      ['POST', '/v1/beta', { login: 'octo-cat' }, 'Bearer pod_admin'],
      ['GET', '/v1/beta', undefined, 'Bearer pod_admin'],
      ['DELETE', '/v1/beta/OCTO-cat', undefined, 'Bearer pod_admin'],
    ])
  })

  test('a player who is no admin hears that only admins change the list', { options: { server: 'online' } }, async ($, on) => {
    const { accounts, asked } = await online($, on, 'pod_player', ['pod_admin'])
    for (const args of ['beta list', 'beta add mona', 'beta remove bob'])
      expect((await run($, args)).text).toBe("Only the server's admins can change the beta list.")
    expect(asked()).toHaveLength(3)
    expect(accounts.beta?.logins.size).toBe(0)
  })

  test('signed out, it says to sign in, and asks the server nothing', { options: { server: 'online' } }, async ($, on) => {
    const { asked } = await online($, on, null, ['pod_admin'])
    expect((await run($, 'beta list')).text).toBe(
      "You're not signed in to https://api.pathof.dev: /pathofdev login signs you in.",
    )
    expect(asked()).toEqual([])
  })

  test('a token the server turned away is a sign-out, said as one', { options: { server: 'online' } }, async ($, on) => {
    const { asked } = await online($, on, 'pod_revoked', ['pod_admin'])
    expect((await run($, 'beta add mona')).text).toBe(
      "You're not signed in to https://api.pathof.dev: /pathofdev login signs you in.",
    )
    expect(asked()).toHaveLength(1)
  })

  test('a login that is none, or args that do not parse, are answered here, and nothing is sent', { options: { server: 'online' } }, async ($, on) => {
    const { asked } = await online($, on, 'pod_admin', ['pod_admin'])
    const usage = "Beta list, for the online server's admins: /pathofdev beta list | add <github-login> | remove <github-login>."
    expect((await run($, 'beta')).text).toBe(usage)
    expect((await run($, 'beta list all')).text).toBe(usage)
    expect((await run($, 'beta add')).text).toBe(usage)
    expect((await run($, 'beta add mona lisa')).text).toBe(usage)
    expect((await run($, 'beta add -mona')).text).toBe(`-mona is not a GitHub login. ${usage}`)
    expect((await run($, 'beta remove ../sessions')).text).toBe(`../sessions is not a GitHub login. ${usage}`)
    expect(asked()).toEqual([])
  })

  test('on a local server, there is no beta list to keep', async ($, on) => {
    await streaming($, on, ownedOf())
    expect((await run($, 'beta list')).text).toBe(
      'You play on your own save (~/.pathofdev), which has no beta list. /pathofdev server online switches to the ' +
        'online server.',
    )
  })
})
