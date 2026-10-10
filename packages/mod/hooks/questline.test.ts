import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionStartInput } from 'claude-code'
import { hmac } from './ids'
import { exitIsTheRuns, githubName, testRunner } from './observe'

// A fake local server beneath the mod: it answers the four routes, records what the mod sends, and holds the
// stream until the test's clock passes 25 seconds, as the real one does.

type Sent = { path: string; body: unknown }

const snapshot = (level: number, pet: unknown = null, cursor = 0) => ({
  serverId: 'local-test',
  streamEpoch: 1,
  cursor,
  pet,
  character: {
    name: 'Player',
    level,
    title: 'Apprentice',
    xp: { total: 130, verified: 0, reported: 130, intoLevel: 30, forNextLevel: 203 },
    gold: 25,
    streak: { days: 2, restDaysLeftThisWeek: 1, lastDay: '2026-10-09' },
  },
})

const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** A session's bottom: what the engine itself answers beneath every plugin. */
const engineBeneath = (on: On) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/work/widgets' }))
}

type Clock = ReturnType<typeof mock.clock>

/** Lets the mod's work run until `check` holds: its start-up chains several calls, more than one settle may cover. */
const until = async (clock: Clock, check: () => boolean | Promise<boolean>) => {
  for (let round = 0; round < 100; round++) {
    if (await check()) return
    await clock.settle()
  }
  throw new Error('the mod never got there')
}

const fakeServer = (on: On, clock: Clock, options: { level?: number; isDown?: boolean } = {}) => {
  const sent: Array<Sent> = []
  const tried: Array<string> = []
  engineBeneath(on)
  on('http.fetch', async ($, e) => {
    tried.push(new URL(e.url).pathname)
    if (options.isDown === true) throw new Error('connect ENOENT /home/player/.questline/server.sock')
    const path = new URL(e.url).pathname
    const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    sent.push({ path, body })
    if (path === '/v1/sessions') return reply(200, { snapshot: snapshot(options.level ?? 0), rules: {}, minClientVersion: '0.0.0', acceptedEventTypes: [] })
    if (path === '/v1/events') {
      const events = typeof body === 'object' && body !== null && 'events' in body && Array.isArray(body.events) ? body.events : []
      // A type from a newer mod than this server knows, as `future.*` stands for here.
      const resultOf = (event: { id: string; type: string }) =>
        event.type.startsWith('future.')
          ? { id: event.id, status: 'rejected', reason: 'unknown_type' }
          : { id: event.id, status: 'accepted' }
      return reply(200, { results: events.map(resultOf), events: [] })
    }
    if (path === '/v1/commands') return reply(200, { status: 'refused', code: 'not_allowed', message: 'The egg hatches at level 1' })
    await clock.sleep(25_000)
    return reply(200, { events: [], cursor: 0, rulesVersion: 1, minClientVersion: '0.0.0' })
  })
  on('process.run', ($, e) => {
    const args = e.argv.join(' ')
    if (args === 'git rev-parse --show-toplevel') return ran(0, '/work/widgets\n')
    if (args === 'git remote get-url origin') return ran(0, 'git@github.com:acme/widgets.git\n')
    if (args === 'git rev-parse --abbrev-ref HEAD') return ran(0, 'main\n')
    return ran(1, '')
  })
  return { sent, tried }
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
