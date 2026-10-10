import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type {
  CommandInfo,
  ModelCompleteInput,
  ModelCompleteResult,
  On,
  PromptOrigin,
  RenderPropsOf,
  SessionMessage,
  SessionStartInput,
} from 'claude-code'
import type { BandLook, BandView, Celebration } from '../types'
import { barCells } from './band'
import { joinQueue, queueOf } from './celebrate'
import { cellsOf, glyphSlot } from './cells'
import { hmac } from './ids'
import { barRow } from './frames'
import { sheenHead } from './looks'
import { exitIsTheRuns, githubName, testRunner } from './observe'
import { headerOf, tabBarOf } from './pane'
import { socketPathOf } from './server'
import { statsLayout, twoColumnsFrom } from './stats'
import { statsViewOf } from './view'

// A fake local server beneath the mod: it answers the four routes, records what the mod sends, and holds the
// stream until the test's clock passes 25 seconds, as the real one does.

type Sent = { path: string; body: unknown }

/** What the player owns in the fake server: entries, their definitions, and what is equipped where. */
type Owned = { inventory: Array<{ id: string; itemId: string }>; items: Array<unknown>; equipped: Record<string, string> }

/** What the stats tab reads: the player stats, and the streak the character carries. */
type Counted = { stats: unknown; streak: unknown }

const snapshot = (level: number, pet: unknown = null, cursor = 0, glyph = '⚔', owned?: Owned, isDev = false, counted?: Counted) => ({
  ...(isDev ? { dev: true } : {}),
  serverId: 'local-test',
  streamEpoch: 1,
  cursor,
  pet,
  character: {
    name: 'Player',
    level,
    title: 'Apprentice',
    glyph,
    xp: { total: 130, verified: 0, reported: 130, intoLevel: 30, forNextLevel: 203 },
    gold: 25,
    streak: counted?.streak ?? { days: 2, restDaysLeftThisWeek: 1, lastDay: '2026-10-09' },
    equipped: { ...owned?.equipped },
  },
  ...(counted === undefined ? {} : { stats: counted.stats }),
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
const engineBeneath = (on: On) => {
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
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
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
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** What the fake server answers a command: an equip or unequip changes what it owns, anything else is refused. */
const commandAnswer = (body: unknown, owned: Owned | undefined, isDev: boolean) => {
  const data = isRecord(body) && isRecord(body['data']) ? body['data'] : {}
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
  // What the dev commands make arrives on the stream; the answer needn't repeat it.
  if (isDev && isRecord(body) && typeof body['type'] === 'string' && body['type'].startsWith('dev.')) return { status: 'ok', events: [] }
  return { status: 'refused', code: 'not_allowed', message: 'The egg hatches at level 1' }
}

const fakeServer = (on: On, clock: Clock, options: ServerOptions = {}) => {
  const sent: Array<Sent> = []
  const tried: Array<string> = []
  const sockets = new Set<string>()
  const { registered, opened, toasts } = engineBeneath(on)
  on('http.fetch', async ($, e) => {
    tried.push(new URL(e.url).pathname)
    sockets.add(e.init?.socketPath ?? '')
    if (options.isDown === true) throw new Error('connect ENOENT /home/player/.questline/server.sock')
    const path = new URL(e.url).pathname
    const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    sent.push({ path, body })
    if (path === '/v1/sessions')
      return reply(200, {
        snapshot: snapshot(options.level ?? 0, null, 0, options.glyph, options.owned, options.isDev === true, options.counted),
        rules: {},
        minClientVersion: '0.0.0',
        acceptedEventTypes: [],
      })
    if (path === '/v1/events') {
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
      return reply(200, commandAnswer(body, options.owned, options.isDev === true))
    }
    // The stream answers as soon as the test hands it events, or after 25 seconds with none.
    const stream = options.stream ?? []
    if (options.stream === undefined) await clock.sleep(25_000)
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
  return { sent, tried, registered, opened, toasts, sockets }
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
      const hint = await ui.find({ type: 'Text', text: /pnpm --filter @questline\/server start/ })
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
    expect(opened).toEqual({ sessionId: cleared[0]?.['sessionId'] })
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
    const { tried } = fakeServer(on, clock, { isDown: true })
    const opens = () => tried.filter((path) => path === '/v1/sessions').length
    await $.session.start(start)
    await until(clock, () => opens() === 1)
    for (const id of ['first', 'second', 'third']) {
      await $.session.end({ reason: 'clear', sessionId: id, resume: { id } })
    }
    await until(clock, () => opens() === 4)
    await clock.advance(5_000)
    expect(opens()).toBe(5)
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
  const { sent, registered, opened, toasts, sockets } = fakeServer(on, clock, options)
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
  return { clock, send, played, sent, registered, opened, toasts, sockets }
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
    await $.command.run({ command: 'questline', args: '', origin: composer, presentation })
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
      expect(seen[0]).toContain('✧ QUESTLINE ✧')
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
      const edge = (await band($)).all.split('\n').find((text) => text.includes('QUESTLINE')) ?? ''
      expect(cellsOf(edge)).toBe(bandOf().bodyColumns)
      await clock.advance(200)
    }
  })
})

const paneProps = (): RenderPropsOf['Pane'] => ({
  title: 'Questline',
  isFocused: true,
  bodyColumns: 72,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

describe('the /questline pane', () => {
  test('registers /questline, which opens the pane on its inventory', async ($, on) => {
    const { registered, opened } = await streaming($, on, ownedOf(wearing))
    expect(registered).toEqual(['questline'])
    const answer = await $.command.run({ command: 'questline', args: '', origin: composer, presentation })
    expect(answer.text).toBe('Questline pane opened.')
    expect(opened).toEqual(['questline'])
    for (const surface of surfaces) {
      const ui = await $.ui.mount({ plugin: 'questline', surface, component: 'Pane', requestId: 'questline', props: paneProps() })
      const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text).join('\n')
      for (const shown of ['◆ Inventory', '◇ Missions', 'soon', 'XP bar', 'Top edge', 'Solid Bar', 'Starlit Edge', 'Plain Cap']) {
        expect(texts).toContain(shown)
      }
      // Stats is built: a tab to switch to, not one still to come.
      expect(await ui.find({ type: 'Button', key: 'tab:stats' })).toBeDefined()
      // Each look's preview is drawn by the band's own code, the still one exactly as the band would.
      expect(texts).toMatch(/^█+░+ 30\/203 xp$/m)
      expect(await ui.find({ type: 'Button', key: 'equip:topEdge:starlit-edge' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'unequip:xpBar' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Equip sends the command and the band wears it at once; Unequip puts the band back', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf())
    await $.command.run({ command: 'questline', args: '', origin: composer, presentation })
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
    await $.command.run({ command: 'questline', args: '', origin: composer, presentation })
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
  return texts.find((text) => / · |!$/.test(text) && !text.includes('QUESTLINE')) ?? null
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
      grant(5, 'future.side_quest'),
      serverEvent('xp.capped', { eventType: 'commit.made', cap: 20 }),
      goldChanged(10),
      goldChanged(-5, 'dev'),
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
      '+5 XP · future side quest',
      'commit · daily XP cap reached',
      '+10 gold · loot',
      '−5 gold · dev grant',
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
  test('a narrow pane drops the name, then the "soon" labels, so neither row wraps', async ($, on) => {
    await streaming($, on, ownedOf())
    await $.command.run({ command: 'questline', args: '', origin: composer, presentation })
    const narrow = await paneTexts($, 40)
    const header = narrow.texts.find((text) => text.startsWith('✦ QUESTLINE ✦')) ?? ''
    expect(header).toBe('✦ QUESTLINE ✦  Lv 4 Apprentice · ◈ 25')
    expect(cellsOf(header)).toBeLessThanOrEqual(38)
    // With Stats built, only Missions is still to come: its label still fits at 40, with the gaps closed to 2.
    expect(narrow.texts.join('\n')).toContain('◇ Missions soon')
    expect(narrow.tabs?.props['columnGap']).toBe(2)
    expect(narrow.tabs?.props['flexWrap']).toBeUndefined()
    const narrower = await paneTexts($, 36)
    expect(narrower.texts.join('\n')).not.toContain('soon')

    const wide = await paneTexts($, 120)
    expect(wide.texts).toContain('✦ QUESTLINE ✦  Player · Lv 4 Apprentice · ◈ 25')
    expect(wide.texts.join('\n')).toContain('◇ Missions soon')
    expect(wide.tabs?.props['columnGap']).toBe(3)
  })

  test('the tab bar and the header give way in steps, and always fit', () => {
    const widthOf = (bar: ReturnType<typeof tabBarOf>) =>
      bar.chips.reduce((sum, chip) => sum + cellsOf(chip.text) + (chip.soon ? 5 : 0), 0) + bar.gap * (bar.chips.length - 1)
    for (const columns of [20, 28, 32, 38, 44, 60]) expect(widthOf(tabBarOf('inventory', columns))).toBeLessThanOrEqual(Math.max(columns, 11))
    expect(tabBarOf('inventory', 60)).toMatchObject({ gap: 3, chips: [{ kind: 'shown' }, { kind: 'ready', soon: false }, { soon: true }] })
    expect(tabBarOf('stats', 60).chips.map((chip) => chip.kind)).toEqual(['ready', 'shown', 'later'])
    expect(tabBarOf('inventory', 20).chips.map((chip) => chip.text)).toEqual(['◆ Inventory', '◇ Stats'])
    const view = { name: 'Player', level: 12, title: 'Adept', gold: 1500 }
    expect(headerOf(view, 80)).toBe('Player · Lv 12 Adept · ◈ 1500')
    expect(headerOf(view, 30)).toBe('Lv 12 · ◈ 1500')
    expect(headerOf(view, 10)).toBe('')
  })
})

describe('dev mode', () => {
  const run = ($: Parameters<TestBody>[0], args: string) => $.command.run({ command: 'questline', args, origin: composer, presentation })
  const commandsOf = (sent: ReadonlyArray<Sent>) => sent.filter((one) => one.path === '/v1/commands').map((one) => one.body)

  test('needs a dev server: on the real one it sends nothing and shows no dev controls', async ($, on) => {
    const { sent } = await streaming($, on, ownedOf())
    expect((await run($, 'dev xp 50')).text).toContain('QUESTLINE_DEV=1 pnpm --filter @questline/server start')
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
      expect((await run($, args)).text).toMatch(/^Dev mode: \/questline dev styles/)
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
    expect([...sockets]).toEqual(['/home/player/.questline-dev/server.sock'])
    expect(socketPathOf(undefined, '/home/player')).toBe('/home/player/.questline/server.sock')
    expect(socketPathOf('/tmp/ql', '/home/player', true)).toBe('/tmp/ql/server.sock')
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
  await $.command.run({ command: 'questline', args: '', origin: composer, presentation })
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
