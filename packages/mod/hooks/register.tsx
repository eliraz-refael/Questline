import type { ClientEvent, Command, ServerEvent } from '@questline/schema'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { BandView, Gain, Link } from '../types'
import { isSecret, newSecret, ulid } from './ids'
import { checkoutRef, commitRef, exitIsTheRuns, repoOf, repoRef, testRunner, workRef } from './observe'
import type { Repo } from './observe'
import { answerOf, initOf, isCommand, isEvents, isSession, isStream, ServerDown, socketPathOf, urlOf } from './server'
import { announce, bar, canHatch, hearts, ruleOf, sprite, viewOf } from './view'

// Questline's mod: it reports what happens in the session to the local game server, keeps one long-poll open for
// what the server decides, and draws the character in a band above the prompt. The server computes every number.

const view = atom({ plugin: 'questline', key: 'view' }, null)
const link = atom({ plugin: 'questline', key: 'link' }, 'connecting')
const gain = atom({ plugin: 'questline', key: 'gain' }, null)

const toneColor: Record<Gain['tone'], 'text' | 'suggestion' | 'claude'> = {
  xp: 'text',
  level: 'claude',
  loot: 'suggestion',
  quiet: 'text',
}

/** Events wait here, across sessions, until the server answers them. The oldest go first past this many. */
const maxQueued = 5000
const batchSize = 100
const flushEveryMs = 30_000
const retryMs = 5_000

// Module memory: a reload runs session.start again, which sets it all anew.
let sessionId = ''
let socket = ''
let secret = ''
let repo: Repo | null = null
let branch: string | null = null
let cursor = 0
let toolCalls = 0
let isFlushing = false
let isPolling = false
let reconnect: Timer | null = null
let flushTimer: Timer | null = null

/** One request to the local server. A failure to reach it at all is `ServerDown`. */
async function call<A>(
  $: EngineInterface,
  path: string,
  is: (value: unknown) => value is A,
  body?: unknown,
): Promise<A> {
  let response
  try {
    response = await $.http.fetch(urlOf(path), initOf(socket, body))
  } catch (cause) {
    throw new ServerDown(`The Questline server does not answer on ${socket}`, {
      cause,
    })
  }
  return answerOf(path, response, is)
}

const openSession = ($: EngineInterface) => call($, '/v1/sessions', isSession, { sessionId })
const sendEvents = ($: EngineInterface, events: ReadonlyArray<unknown>) => call($, '/v1/events', isEvents, { events })
const runCommand = ($: EngineInterface, command: Command) => call($, '/v1/commands', isCommand, command)
/** Answers as soon as the stream moves past `after`, or after 25 seconds with nothing. */
const stream = ($: EngineInterface, after: number) => call($, `/v1/stream?after=${after}`, isStream)

const idOf = (event: unknown): string | null =>
  typeof event === 'object' && event !== null && 'id' in event && typeof event.id === 'string' ? event.id : null

const queued = async ($: EngineInterface): Promise<Array<unknown>> => {
  const stored = await $.store.get('queue')
  return Array.isArray(stored) ? stored : []
}

// Every change to the queue reads it and writes it back, so changes run one at a time: two at once would drop or
// reorder events.
let queueTail: Promise<unknown> = Promise.resolve()
const changeQueue = <A,>(change: () => Promise<A>): Promise<A> => {
  const run = queueTail.then(change, change)
  queueTail = run.catch(() => undefined)
  return run
}

const enqueue = ($: EngineInterface, event: ClientEvent) =>
  changeQueue(async () => {
    await $.store.set('queue', [...(await queued($)), event].slice(-maxQueued))
  })

const stamp = async ($: EngineInterface) => {
  const now = await $.clock.now()
  return { id: ulid(now), occurredAt: new Date(now).toISOString(), sessionId }
}

/** Sends what waits, a batch at a time. Whatever the server answered leaves the queue; the rest waits. */
const flush = async ($: EngineInterface): Promise<void> => {
  if (isFlushing) return
  isFlushing = true
  // What this flush has sent and must leave queued (an unknown type waits for a newer server): the next batch
  // reads past it, so a run of such events never holds back the ones behind it.
  const waiting = new Set<string>()
  try {
    for (;;) {
      const batch = (await queued($)).filter((event) => !waiting.has(idOf(event) ?? '')).slice(0, batchSize)
      if (batch.length === 0) return
      const answer = await sendEvents($, batch)
      const done = new Set(
        answer.results.filter((result) => result.reason !== 'unknown_type').map((result) => result.id),
      )
      for (const event of batch) if (!done.has(idOf(event) ?? '')) waiting.add(idOf(event) ?? '')
      if (done.size > 0)
        await changeQueue(async () => {
          await $.store.set('queue', (await queued($)).filter((event) => !done.has(idOf(event) ?? '')))
        })
    }
  } catch (error) {
    if (error instanceof ServerDown) await update($, link, () => 'offline')
  } finally {
    isFlushing = false
  }
}

const show = async ($: EngineInterface, event: ServerEvent) => {
  const said = announce(event)
  if (said.gain !== undefined) {
    const next = said.gain
    await update($, gain, () => next)
  }
  if (said.toast !== undefined) $.ui.toast(said.toast)
}

/** Reloads the character from the server; `fromScratch` also moves the cursor to the snapshot's. */
const refresh = async ($: EngineInterface, fromScratch: boolean) => {
  const opened = await openSession($)
  if (fromScratch) cursor = opened.snapshot.cursor
  const next = viewOf(opened.snapshot)
  await update($, view, () => next)
  await update($, link, () => 'online')
}

/** One long-poll, then the next. A failure waits a little and reconnects from a fresh snapshot. */
const poll = async ($: EngineInterface): Promise<void> => {
  if (isPolling) return
  isPolling = true
  try {
    const answer = await stream($, cursor)
    if (answer.resync === true) {
      await refresh($, true)
    } else if (answer.events.length > 0) {
      for (const event of answer.events) if (event.seq > cursor) await show($, event)
      cursor = answer.cursor
      await refresh($, false)
    }
    isPolling = false
    $.clock.after(0, () => void poll($))
  } catch {
    isPolling = false
    await update($, link, () => 'offline')
    retryLater($)
  }
}

/** One reconnect waits at a time: a /clear that connects again while one waits replaces it, not adds to it. */
const retryLater = ($: EngineInterface) => {
  reconnect?.cancel()
  reconnect = $.clock.after(retryMs, () => void connect($))
}

const connect = async ($: EngineInterface): Promise<void> => {
  reconnect?.cancel()
  reconnect = null
  try {
    await refresh($, true)
  } catch {
    await update($, link, () => 'offline')
    retryLater($)
    return
  }
  await flush($)
  await poll($)
}

const git = async ($: EngineInterface, cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: 5_000 })
  return ran.exitCode === 0 ? ran.stdout.trim() : null
}

/** The repo the session runs in, if any, and its branch. */
const findRepo = async ($: EngineInterface, cwd: string) => {
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top === null) return
  repo = repoOf(await git($, cwd, ['remote', 'get-url', 'origin']), top)
  const head = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  branch = head === null || head === 'HEAD' ? null : head
}

/** The first session in a repo explores it. */
const explore = async ($: EngineInterface) => {
  if (repo === null) return
  const id = repo.kind === 'github' ? repo.name : repo.id
  const stored = await $.store.get('explored')
  const explored = Array.isArray(stored) ? stored : []
  if (explored.includes(id)) return
  await enqueue($, {
    ...(await stamp($)),
    type: 'repo.explored',
    data: { repo: await repoRef(secret, repo) },
  })
  await $.store.set('explored', [...explored, id])
}

const machineSecret = async ($: EngineInterface): Promise<string> => {
  const stored = await $.store.get('secret')
  if (isSecret(stored)) return stored
  const made = newSecret()
  await $.store.set('secret', made)
  return made
}

/** A test run that finished: a failing one arms the next green, which earns XP. */
const observeTests = async ($: EngineInterface, command: string, failed: boolean, unfinished: boolean) => {
  const runner = testRunner(command)
  if (runner === null || unfinished || !exitIsTheRuns(command)) return
  const checkout = repo === null ? null : await checkoutRef(secret, repo, branch)
  await enqueue($, {
    ...(await stamp($)),
    type: failed ? 'tests.failed' : 'tests.passed',
    data: { checkout, runner },
  })
}

const hatch = async ($: EngineInterface) => {
  try {
    const answer = await runCommand($, {
      ...(await stamp($)),
      type: 'pet.hatch',
      data: { species: 'fox', name: 'Ember' },
    })
    if (answer.status === 'refused') $.ui.toast(answer.message)
    // The hatch arrives on the stream too, with its toast.
  } catch {
    await update($, link, () => 'offline')
  }
}

/** A new session: a fresh id, then the repo, its first exploration and the server, after the hook returns. */
const begin = async ($: EngineInterface, cwd: string) => {
  $.ui.status(undefined)
  sessionId = ulid(await $.clock.now())
  socket = socketPathOf(await $.env.get('QUESTLINE_HOME'), await $.env.get('HOME'))
  secret = await machineSecret($)
  $.clock.after(0, async () => {
    await findRepo($, cwd)
    await explore($)
    await connect($)
  })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await begin($, e.cwd)
    flushTimer?.cancel()
    flushTimer = $.clock.every(flushEveryMs, () => void flush($))
    return result
  })

  // A /clear ends the conversation without a new session.start, and the band's state goes with it: start again.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') await begin($, await $.session.cwd())
    return result
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) toolCalls += 1
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) {
      // A failing command can still be a failing test run.
      if (result.deny === undefined) await observeTests($, e.command, true, false)
      return result
    }
    const record = result.result
    const operation = record?.gitOperation
    if (operation?.commit !== undefined && operation.commit.kind === 'committed' && repo !== null) {
      branch = operation.commit.branch ?? branch
      const commit = await commitRef(secret, repo, operation.commit.sha)
      await enqueue($, {
        ...(await stamp($)),
        type: 'commit.made',
        data: { commit },
      })
    }
    if (operation?.pr !== undefined && repo !== null) {
      const type =
        operation.pr.action === 'created' ? 'change.opened' : operation.pr.action === 'merged' ? 'change.merged' : null
      if (type !== null)
        await enqueue($, {
          ...(await stamp($)),
          type,
          data: { change: await workRef(secret, repo, operation.pr.number) },
        })
    }
    const finished = !record.interrupted && record.backgroundTaskId === undefined
    await observeTests($, e.command, false, !finished)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A turn the person interrupted, or one an error ended, is no finished piece of work.
      if (e.reason === 'answer') {
        const data = {
          durationMs: Math.max(0, Math.round(e.durationMs)),
          toolCalls,
        }
        await enqueue($, { ...(await stamp($)), type: 'turn.completed', data })
      }
      toolCalls = 0
      $.clock.after(0, () => void flush($))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const status = await read($, link)
    const current = await read($, view)
    const last = await read($, gain)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The band's top edge, so it reads apart from the transcript above it.
    const edge = ruleOf(e.props.bodyColumns)
    const rule = (
      <Text color="claude" dimColor>
        {edge.lead}
        <Text bold dimColor={false}>
          {edge.title}
        </Text>
        {edge.trail}
      </Text>
    )

    if (status === 'offline') {
      return (
        <Box flexDirection="column">
          {rule}
          <Box flexWrap="wrap">
            <Text color="claude" bold>
              ⚔ Questline{' '}
            </Text>
            <Text dimColor>offline · start the server: pnpm --filter @questline/server start</Text>
          </Box>
        </Box>
      )
    }
    if (current === null) return next(e)

    const cells = bar(current, 12)
    const pet = current.pet
    return (
      <Box flexDirection="column">
        {rule}
        <Box flexWrap="wrap" columnGap={2}>
          <Text>
            <Text color="claude" bold>
              ⚔ Lv {current.level}
            </Text>{' '}
            {current.title}
          </Text>
          <Text>
            <Text color="success">{'▰'.repeat(cells.filled)}</Text>
            <Text dimColor>{'▱'.repeat(cells.empty)}</Text> {current.xp.intoLevel}/{current.xp.forNextLevel} xp
          </Text>
          <Text color="warning">🔥 {current.streakDays}</Text>
          <Text color="suggestion">◈ {current.gold}</Text>
          {pet !== null ? (
            <Text>
              {sprite(pet)} {pet.name} <Text color="error">{hearts(pet.mood)}</Text>
            </Text>
          ) : canHatch(current) ? (
            <Button key="hatch" label="🥚 Hatch your egg" variant="primary" onPress={() => void hatch($)} />
          ) : (
            <Text dimColor>🥚 hatches at Lv 1</Text>
          )}
          {last === null ? null : (
            <Text color={toneColor[last.tone]} dimColor={last.tone === 'quiet'}>
              {last.text}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
