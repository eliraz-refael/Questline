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
import type { Celebration } from '../types'
import { joinQueue, queueOf } from './celebrate'
import { cellsOf, glyphSlot } from './cells'
import { hmac } from './ids'
import { exitIsTheRuns, githubName, testRunner } from './observe'

// A fake local server beneath the mod: it answers the four routes, records what the mod sends, and holds the
// stream until the test's clock passes 25 seconds, as the real one does.

type Sent = { path: string; body: unknown }

/** What the player owns in the fake server: entries, their definitions, and what is equipped where. */
type Owned = { inventory: Array<{ id: string; itemId: string }>; items: Array<unknown>; equipped: Record<string, string> }

const snapshot = (level: number, pet: unknown = null, cursor = 0, glyph = '⚔', owned?: Owned) => ({
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
    streak: { days: 2, restDaysLeftThisWeek: 1, lastDay: '2026-10-09' },
    equipped: { ...owned?.equipped },
  },
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
  return { registered, opened }
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

type ServerOptions = { level?: number; glyph?: string; isDown?: boolean; stream?: Array<{ seq: number }>; owned?: Owned }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** What the fake server answers a command: an equip or unequip changes what it owns, anything else is refused. */
const commandAnswer = (body: unknown, owned: Owned | undefined) => {
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
  return { status: 'refused', code: 'not_allowed', message: 'The egg hatches at level 1' }
}

const fakeServer = (on: On, clock: Clock, options: ServerOptions = {}) => {
  const sent: Array<Sent> = []
  const tried: Array<string> = []
  const { registered, opened } = engineBeneath(on)
  on('http.fetch', async ($, e) => {
    tried.push(new URL(e.url).pathname)
    if (options.isDown === true) throw new Error('connect ENOENT /home/player/.questline/server.sock')
    const path = new URL(e.url).pathname
    const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    sent.push({ path, body })
    if (path === '/v1/sessions')
      return reply(200, {
        snapshot: snapshot(options.level ?? 0, null, 0, options.glyph, options.owned),
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
    if (path === '/v1/commands') return reply(200, commandAnswer(body, options.owned))
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
  return { sent, tried, registered, opened }
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
const serverEvent = (type: string, data: Record<string, unknown>) => ({
  seq: ++seq,
  at: '2026-10-09T08:00:00.000Z',
  cause: null,
  type,
  data,
})
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
    .filter((text) => !/^(Common|Uncommon|Rare|Epic|Legendary) drop: /.test(text))
  const grown = (await ui.find({ type: 'Box', key: 'stage' }))?.children.length ?? 0
  await ui.unmount()
  return { all: texts.join('\n'), grown }
}

/** A session with the server up and its stream open, which hands the mod `events` when `send` is called. */
const streaming = async ($: Parameters<TestBody>[0], on: On, owned?: Owned) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
  mock.store(on, { explored: ['acme/widgets'] })
  mock.env(on, { HOME: '/home/player' })
  const stream: Array<{ seq: number }> = []
  const { sent, registered, opened } = fakeServer(on, clock, { level: 4, stream, ...(owned === undefined ? {} : { owned }) })
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
  return { clock, send, played, sent, registered, opened }
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
      for (const shown of ['◆ Inventory', 'Stats', 'soon', 'XP bar', 'Top edge', 'Solid Bar', 'Starlit Edge', 'Plain Cap']) {
        expect(texts).toContain(shown)
      }
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
