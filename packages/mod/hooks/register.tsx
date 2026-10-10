import type { ClientEvent, Command, ServerEvent } from '@questline/schema'
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, TextProps, Timer } from 'claude-code'
import type { BandSlot, BandView, Celebration, Gain, Link, Motion, PaneTab, Stage } from '../types'
import { goldRow, labelRun, edgeRow, levelRow } from './band'
import { celebrationOf, chimeOf, chimeWav, gapMs, idleMs, joinQueue, motionOf, queueOf, scriptOf } from './celebrate'
import type { Row } from './cells'
import { barRow, rarityColors, slotRow, stageRows } from './frames'
import {
  answerTail,
  askFor,
  isGradable,
  isSlashCommand,
  minWordsOf,
  RUBRIC,
  rubricVersion,
  scoresOf,
  wordsOf,
} from './grade'
import { isSecret, newSecret, ulid } from './ids'
import {
  checkoutRef,
  commandNameOf,
  commitRef,
  compactionOf,
  exitIsTheRuns,
  repoOf,
  repoRef,
  testRunner,
  workRef,
} from './observe'
import type { Repo } from './observe'
import { answerOf, initOf, isCommand, isEvents, isSession, isStream, ServerDown, socketPathOf, urlOf } from './server'
import { ownedLooks, rateOf, wornLooks } from './looks'
import type { Choice } from './pane'
import { lookSections, otherItems, paneId, tabOf, tabs } from './pane'
import { announce, canHatch, hearts, sprite, viewOf, wardrobeOf } from './view'

// Questline's mod: it reports what happens in the session to the local game server, keeps one long-poll open for
// what the server decides, draws the character in a band above the prompt in the looks the player equipped, and
// opens the `/questline` pane. The server computes every number and sends every look but the band's own.

const view = atom({ plugin: 'questline', key: 'view' }, null)
const link = atom({ plugin: 'questline', key: 'link' }, 'connecting')
const gain = atom({ plugin: 'questline', key: 'gain' }, null)
const stage = atom({ plugin: 'questline', key: 'stage' }, null)
const queue = atom({ plugin: 'questline', key: 'queue' }, [])
const wardrobe = atom({ plugin: 'questline', key: 'wardrobe' }, null)
const loop = atom({ plugin: 'questline', key: 'loop' }, null)
const tab = atom({ plugin: 'questline', key: 'tab' }, 'inventory')

/** This copy of the mod: a reload makes a new one, and a frame the old one left behind is never drawn. */
const load = Math.random()

/** Cells the band's rows are set in from each side, and the rows it takes of its own: the edge, a gap, two rows. */
const inset = 2
const ownRows = 4

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
// What the grader reads beside a prompt: the player's last one, graded or not, and the end of the main loop's last
// answer.
let lastPrompt = ''
let lastAnswer = ''
/** The fullest the context got since the last turn ended, or null when nothing measured it. */
let turnPeak: number | null = null
// Celebrations: the `animations` option, the queue, the one playing (its frames in the `stage` atom), the timer of
// its next frame or of the next celebration, and whether a main-loop turn is running, which holds them all.
let motion: Motion = 'full'
let lineup: Array<Celebration> = []
let playing: Celebration | null = null
let frame: Timer | null = null
let isTurnRunning = false
let seed = 0
// The looks' loops: one clock for all of them, at the fastest rate a looping look asks for, running only while the
// prompt is idle, nothing celebrates and the player wants full motion. The pane's previews loop while it is open.
let loopTimer: Timer | null = null
let loopRate = 0
let loopTick = 0
let isPaneOpen = false

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
  const celebration = motion === 'off' ? null : celebrationOf(event, (await read($, view))?.glyph ?? '')
  if (celebration !== null) {
    lineup = joinQueue(lineup, celebration)
    await saveQueue($)
    playSoon($, 0)
  }
}

/** Keeps what waits to play, the one playing first, in the session's state, where a reload of the mod finds it. */
const saveQueue = async ($: EngineInterface) => {
  const waiting = playing === null ? lineup : [playing, ...lineup]
  await update($, queue, () => waiting)
}

/** Starts the next celebration after `ms`, unless one plays, a turn holds them, or a start is already set. */
const playSoon = ($: EngineInterface, ms: number) => {
  if (playing !== null || isTurnRunning || frame !== null) return
  frame = $.clock.after(ms, () => void playNext($).catch(() => abandon($)))
}

/** A celebration whose frame could not be drawn gives way to the next, so no frame is left standing. */
const abandon = async ($: EngineInterface) => {
  frame?.cancel()
  frame = null
  playing = null
  await update($, stage, () => null).catch(() => undefined)
  await saveQueue($).catch(() => undefined)
  await syncLoop($).catch(() => undefined)
  playSoon($, gapMs)
}

const playNext = async ($: EngineInterface) => {
  frame = null
  const next = lineup[0]
  if (playing !== null || isTurnRunning || next === undefined || motion === 'off') return
  lineup = lineup.slice(1)
  playing = next
  seed += 1
  const first: Stage = { celebration: next, tick: 0, seed, motion, load }
  await syncLoop($)
  await update($, stage, () => first)
  // A turn that began while the first frame was being set has held this one: take back the frame it left.
  if (playing !== next) {
    await update($, stage, (shown) => (shown?.celebration === next ? null : shown))
    return
  }
  await frameAt($, next, 0)
}

/** Draws frame `tick` of the celebration playing, and sets the timer for the next one, or for the end. */
const frameAt = async ($: EngineInterface, celebration: Celebration, tick: number) => {
  // The timer that called this one has fired: a start set from here on must not take it for one still waiting.
  frame = null
  if (playing !== celebration || motion === 'off') return
  const script = scriptOf(celebration, motion)
  if (tick >= script.ticks) {
    playing = null
    await update($, stage, () => null)
    await saveQueue($)
    await syncLoop($)
    playSoon($, gapMs)
    return
  }
  if (tick > 0) await update($, stage, (shown) => (shown === null ? null : { ...shown, tick }))
  // A turn that began during the redraw has held this one: it must leave no timer behind to block the next start.
  if (playing !== celebration) return
  const chime = chimeOf(celebration, motion)
  // A sound is a flourish: a terminal with no player, or a refused clip, changes nothing else.
  if (chime !== null && tick === chime.tick)
    $.audio.play({ base64: chimeWav(chime.tier), mime: 'audio/wav' }, { gain: 0.6 }).catch(() => undefined)
  frame = $.clock.after(script.frameMs, () => void frameAt($, celebration, tick + 1).catch(() => abandon($)))
}

/** A main-loop turn began: what plays stops and waits, to play whole once the prompt is idle again; loops rest. */
const holdCelebrations = async ($: EngineInterface) => {
  isTurnRunning = true
  frame?.cancel()
  frame = null
  await syncLoop($)
  if (playing === null) return
  lineup = queueOf([playing, ...lineup])
  playing = null
  await update($, stage, () => null)
}

/**
 * A fresh copy of the mod (a reload, or the session's start) takes the celebrations the last copy left in the
 * session's state and plays them again, the one that was playing from its first frame: its frame on the band is
 * taken down at once, since nothing would move it on.
 */
const resumeCelebrations = async ($: EngineInterface) => {
  frame?.cancel()
  frame = null
  playing = null
  isTurnRunning = false
  const saved = await read($, queue)
  lineup = motion === 'off' || !Array.isArray(saved) ? [] : queueOf(saved)
  await update($, stage, () => null)
  await saveQueue($)
  if (lineup.length > 0) playSoon($, idleMs)
}

/** Starts, re-rates or stops the looks' loops, as what is drawn and the moment ask. */
const syncLoop = async ($: EngineInterface) => {
  const owned = await read($, wardrobe)
  const looks = [...Object.values(wornLooks(owned)), ...(isPaneOpen ? ownedLooks(owned) : [])]
  const rate = motion === 'full' && !isTurnRunning && playing === null ? rateOf(looks) : 0
  if (rate === loopRate && (rate === 0) === (loopTimer === null)) return
  // The timer is swapped before any await, so two syncs that overlap never leave two clocks running; the atom is
  // written from the rate in force when the write lands, so the last sync wins there too.
  loopTimer?.cancel()
  loopRate = rate
  loopTimer =
    rate === 0 ? null : $.clock.every(Math.round(1000 / rate), () => void tickLoop($).catch(() => undefined))
  await update($, loop, () => (loopRate === 0 ? null : { tick: loopTick, rate: loopRate }))
}

const tickLoop = async ($: EngineInterface) => {
  if (loopRate === 0) return
  loopTick += 1
  // A stop that came in while this tick was being written wins: the still looks stay. An atom a /clear emptied is
  // written again, so the loops pick up where they were.
  await update($, loop, () => (loopRate === 0 ? null : { tick: loopTick, rate: loopRate }))
}

/** Reloads the character from the server; `fromScratch` also moves the cursor to the snapshot's. */
const refresh = async ($: EngineInterface, fromScratch: boolean) => {
  const opened = await openSession($)
  if (fromScratch) cursor = opened.snapshot.cursor
  const next = viewOf(opened.snapshot)
  const owned = wardrobeOf(opened.snapshot)
  await update($, view, () => next)
  await update($, wardrobe, () => owned)
  await update($, link, () => 'online')
  await syncLoop($)
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
    await update($, link, () => 'offline').catch(() => undefined)
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

/** Puts an owned band style in its slot, or with no entry the band's own look back; the band redraws at once. */
const wear = async ($: EngineInterface, slot: BandSlot, entryId: string | null) => {
  try {
    const { id } = await stamp($)
    const command: Command =
      entryId === null
        ? { id, type: 'item.unequip', data: { slot } }
        : { id, type: 'item.equip', data: { entryId, slot } }
    const answer = await runCommand($, command)
    if (answer.status === 'refused') {
      $.ui.toast(answer.message)
      return
    }
    await refresh($, false)
  } catch {
    await update($, link, () => 'offline')
  }
}

/** Opens the pane, and its previews loop while it stays open. */
const openPane = async ($: EngineInterface) => {
  await $.ui.open({ id: paneId, title: 'Questline' })
  isPaneOpen = true
  await syncLoop($)
}

/**
 * Grades a prompt the player typed with Haiku, from what the grader is asked (`askFor`), and queues the scores. A
 * failed call or a reply that doesn't parse sends nothing.
 */
const grade = async ($: EngineInterface, prompt: string, words: number) => {
  const stamped = await stamp($)
  const result = await $.model.complete({
    model: 'haiku',
    system: [{ text: RUBRIC, cache: true }],
    prompt,
    maxTokens: 120,
    effort: 'low',
    timeoutMs: 30_000,
  })
  const scores = result.isAnswered ? scoresOf(result.text) : null
  if (scores === null) return
  await enqueue($, { ...stamped, type: 'prompt.graded', data: { scores, rubricVersion, words, grader: 'haiku' } })
}

/** A slash command the player ran, by the name the stats count it under. */
const commandUsed = async ($: EngineInterface, command: string) => {
  const stamped = await stamp($)
  const listed = (await $.command.list()).find((info) => info.name === command)
  await enqueue($, { ...stamped, type: 'command.used', data: { command: commandNameOf(command, listed?.source) } })
}

/** Runs `work` once the hook has returned; whatever it throws stays here, so it never fails a prompt or a command. */
const later = ($: EngineInterface, work: () => Promise<unknown>) => {
  $.clock.after(0, () => {
    work().catch(() => undefined)
  })
}

/** A new session: a fresh id, then the repo, its first exploration and the server, after the hook returns. */
const begin = async ($: EngineInterface, cwd: string) => {
  $.ui.status(undefined)
  lastPrompt = ''
  lastAnswer = ''
  turnPeak = null
  sessionId = ulid(await $.clock.now())
  socket = socketPathOf(await $.env.get('QUESTLINE_HOME'), await $.env.get('HOME'))
  secret = await machineSecret($)
  $.clock.after(0, async () => {
    await findRepo($, cwd)
    await explore($)
    await connect($)
  })
}

export const register: Register = (on, options) => {
  const minWords = minWordsOf(options)
  motion = motionOf(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await resumeCelebrations($)
    await begin($, e.cwd)
    flushTimer?.cancel()
    flushTimer = $.clock.every(flushEveryMs, () => void flush($))
    // A pane the last copy of the mod opened stays up across a reload: the engine keeps the record.
    isPaneOpen = (await $.ui.panes().catch(() => [])).some((pane) => pane.id === paneId)
    loopTimer?.cancel()
    loopTimer = null
    loopRate = 0
    await syncLoop($)
    await $.command
      .register({ name: 'questline', description: 'Open the Questline pane: your inventory and band styles' })
      .catch(() => undefined)
    return result
  })

  on('command.run', { command: 'questline' }, async ($) => {
    await openPane($)
    return { text: 'Questline pane opened.' }
  })

  on('ui.close', { id: paneId }, async ($, e, next) => {
    const result = await next(e)
    isPaneOpen = false
    await syncLoop($)
    return result
  }).catch(($, e, next) => next(e))

  // A /clear ends the conversation without a new session.start, and the band's state goes with it: start again.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      // Counted under the session it ends.
      await enqueue($, { ...(await stamp($)), type: 'session.cleared', data: {} })
      await begin($, await $.session.cwd())
    }
    return result
  })

  // The prompt goes on first and untouched: grading runs after the hook returns and never holds one back.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const byPlayer = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (result.drop !== undefined || !byPlayer || isSlashCommand(e.text)) return result
    const text = e.text.trim()
    const words = wordsOf(e.text)
    // What the grader reads is taken now: a prompt typed before the grading runs must not become this one's previous.
    if (isGradable(e.origin.kind, e.text, words, minWords)) {
      const asked = askFor(text, lastPrompt, lastAnswer)
      later($, () => grade($, asked, words))
    }
    lastPrompt = text
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') later($, () => commandUsed($, e.command))
    return result
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const trigger = compactionOf(e.trigger)
    // A subagent's own transcript is no compaction of the player's conversation; a skipped one changed nothing.
    if (e.agentId === undefined && trigger !== null && result.messages !== undefined) {
      await enqueue($, { ...(await stamp($)), type: 'session.compacted', data: { trigger } })
    }
    return result
  }).catch(($, e, next) => next(e))

  // The context is reported once a turn, at its fullest: a compaction mid-turn would hide a fill the end didn't reach.
  on('session.measure', ($, e, next) => {
    const pct = e.context.percent
    if (e.changed.includes('context') && pct !== undefined) {
      turnPeak = Math.max(turnPeak ?? 0, Math.min(100, Math.max(0, pct)))
    }
    return next(e)
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

  // A celebration never plays over a main-loop turn: it waits for the idle prompt.
  on('turn.start', async ($, e, next) => {
    await holdCelebrations($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      playSoon($, idleMs)
      await syncLoop($)
      // A turn the person interrupted, or one an error ended, is no finished piece of work.
      if (e.reason === 'answer') {
        const data = {
          durationMs: Math.max(0, Math.round(e.durationMs)),
          toolCalls,
        }
        await enqueue($, { ...(await stamp($)), type: 'turn.completed', data })
      }
      toolCalls = 0
      if (e.answer !== '') lastAnswer = e.answer.slice(-answerTail)
      if (turnPeak !== null) {
        await enqueue($, { ...(await stamp($)), type: 'context.measured', data: { pct: turnPeak } })
        turnPeak = null
      }
      $.clock.after(0, () => void flush($))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const status = await read($, link)
    const current = await read($, view)
    const last = await read($, gain)
    const looks = wornLooks(await read($, wardrobe))
    // A running turn draws every look still, whatever the clock says.
    const moving = e.props.isWorking ? null : await read($, loop)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The band's top edge, so it reads apart from the transcript above it.
    const rule = draw(Text, edgeRow(e.props.bodyColumns, looks.topEdge ?? null, moving), 'edge')

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

    // What a celebration draws: its flourish on the XP bar, in the gain's place or in rows the band grows by. A
    // running turn draws none, whatever the timers say, and nor does a frame another copy of the mod left.
    const staged = e.props.isWorking ? null : await read($, stage)
    const shown = staged !== null && staged.load === load && playing !== null ? staged : null
    const columns = Math.max(0, e.props.bodyColumns - 2 * inset)
    const rows = shown === null ? [] : stageRows(shown, columns, Math.max(0, e.props.maxRows - ownRows))
    const slot = shown === null ? null : slotRow(shown, rows.length > 0)
    const pet = current.pet
    const barLook = looks.xpBar ?? null
    const bar = [...barRow(current, columns, shown, barLook, moving), labelRun(current, barLook)]
    // Under the edge, a row of air, then the XP bar alone and everything else under it, both set in from the sides.
    return (
      <Box flexDirection="column">
        {rule}
        <Text> </Text>
        <Box flexDirection="column" paddingX={inset}>
          {draw(Text, bar, 'bar')}
          <Box flexWrap="wrap" columnGap={2}>
            {draw(Text, levelRow(current, looks.levelDisplay ?? null, moving), 'level')}
            {draw(Text, goldRow(current, looks.goldDisplay ?? null, moving), 'gold')}
            {pet !== null ? (
              <Text>
                {sprite(pet)} {pet.name} <Text color="error">{hearts(pet.mood)}</Text>
              </Text>
            ) : canHatch(current) ? (
              <Button key="hatch" label="🥚 Hatch your egg" variant="primary" onPress={() => void hatch($)} />
            ) : (
              <Text dimColor>🥚 hatches at Lv 1</Text>
            )}
            {slot !== null ? (
              draw(Text, slot, 'slot')
            ) : last === null ? null : (
              <Text color={toneColor[last.tone]} dimColor={last.tone === 'quiet'}>
                {last.text}
              </Text>
            )}
          </Box>
          {rows.length === 0 ? null : (
            <Box key="stage" flexDirection="column">
              {rows.map((row, i) => draw(Text, row, `stage-${i}`))}
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // The pane: a hub of tabs over the game, the inventory first. Each band style is listed with a live preview, drawn
  // by the band's own code, and a button that puts it on.
  on('ui.render', { component: 'Pane', requestId: paneId }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const status = await read($, link)
    const current = await read($, view)
    const owned = await read($, wardrobe)
    const moving = await read($, loop)
    const shownTab = tabOf(await read($, tab))
    const width = Math.max(20, e.props.bodyColumns - 2)
    const preview = Math.max(20, Math.min(width - 4, 56))

    const tabBar = (
      <Box key="tabs" flexWrap="wrap" columnGap={3}>
        {tabs.map((one) =>
          one.id === shownTab ? (
            <Text key={one.id} bold color="claude">
              ◆ {one.label}
            </Text>
          ) : one.isReady ? (
            <Button key={`tab:${one.id}`} plain label={`◇ ${one.label}`} onPress={() => void showTab($, one.id)} />
          ) : (
            <Text key={one.id} dimColor>
              ◇ {one.label} <Text italic>soon</Text>
            </Text>
          ),
        )}
      </Box>
    )
    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">
            ✦ QUESTLINE ✦
          </Text>
          {current === null ? null : (
            <Text dimColor>
              {'  '}
              {current.name} · Lv {current.level} {current.title} · ◈ {current.gold}
            </Text>
          )}
        </Text>
        <Text> </Text>
        {tabBar}
        <Text dimColor>{'─'.repeat(width)}</Text>
      </Box>
    )
    if (current === null || owned === null) {
      const why =
        status === 'offline'
          ? 'The Questline server is not answering. Start it: pnpm --filter @questline/server start'
          : 'Connecting to the Questline server…'
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          <Text dimColor>{why}</Text>
        </Box>
      )
    }

    const sections = lookSections(owned)
    const styles = sections.reduce((count, section) => count + section.choices.length - 1, 0)
    const others = otherItems(owned)
    const previewOf = (slot: BandSlot, choice: Choice): Row => {
      const motion = choice.isLooping ? moving : null
      switch (slot) {
        case 'xpBar':
          return [...barRow(current, preview, null, choice.look, motion), labelRun(current, choice.look)]
        case 'levelDisplay':
          return levelRow(current, choice.look, motion)
        case 'topEdge':
          return edgeRow(preview, choice.look, motion)
        case 'goldDisplay':
          return goldRow(current, choice.look, motion)
      }
    }
    const choiceRow = (slot: BandSlot, choice: Choice) => {
      const color = choice.rarity === null ? undefined : rarityColors[choice.rarity]
      const notes = [
        ...(choice.note !== null ? [choice.note] : choice.rarity === null ? [] : [choice.rarity]),
        ...(choice.isLooping ? ['loops'] : []),
        ...(choice.count > 1 ? [`×${choice.count}`] : []),
      ].join(' · ')
      return (
        <Box key={`${slot}:${choice.key}`} flexDirection="column" marginLeft={2} marginBottom={1}>
          <Box flexWrap="wrap" columnGap={2}>
            <Text>
              <Text color={choice.isWorn ? 'success' : 'inactive'}>{choice.isWorn ? '●' : '○'}</Text>{' '}
              <Text bold {...(color === undefined ? {} : { color })}>
                {choice.name}
              </Text>
              <Text dimColor> {notes}</Text>
            </Text>
            {choice.isWorn ? (
              <Text color="success">equipped</Text>
            ) : (
              <Button
                key={`equip:${slot}:${choice.key}`}
                label="Equip"
                onPress={() => void wear($, slot, choice.entryId)}
              />
            )}
            {choice.isWorn && choice.entryId !== null ? (
              <Button key={`unequip:${slot}`} label="Unequip" dimColor onPress={() => void wear($, slot, null)} />
            ) : null}
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {draw(Text, previewOf(slot, choice), `preview:${slot}:${choice.key}`)}
            {choice.lore === null ? null : (
              <Text dimColor italic>
                {choice.lore}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text>
          <Text bold>Band styles</Text>
          <Text dimColor>
            {'  '}
            {styles === 0 ? 'none yet: they drop like any loot' : `${styles} owned`} · what your band wears
          </Text>
        </Text>
        <Text> </Text>
        {sections.map((section) => (
          <Box key={`section:${section.slot}`} flexDirection="column">
            <Text>
              <Text bold color="claude">
                {section.title}
              </Text>
              <Text dimColor> {'─'.repeat(Math.max(0, width - section.title.length - 1))}</Text>
            </Text>
            {section.choices.map((choice) => choiceRow(section.slot, choice))}
          </Box>
        ))}
        <Text bold>Other items</Text>
        {others.length === 0 ? (
          <Text dimColor>  Nothing yet: loot drops from finished turns, graded prompts and level-ups.</Text>
        ) : (
          others.map((item) => (
            <Text key={`item:${item.itemId}`}>
              {'  '}
              <Text color={rarityColors[item.rarity]}>{item.name}</Text>
              <Text dimColor>
                {' '}
                {item.rarity} · {item.kind}
                {item.count > 1 ? ` · ×${item.count}` : ''}
              </Text>
            </Text>
          ))
        )}
      </Box>
    )
  })
}

/** Shows a tab of the pane. */
const showTab = async ($: EngineInterface, next: PaneTab) => {
  await update($, tab, () => next)
}

/** One row of styled runs as one Text, cut at the band's edge rather than wrapped. */
const draw = (Text: ElementConstructor<TextProps>, row: Row, key: string) => (
  <Text key={key} wrap="truncate">
    {row.map((run, i) => (
      <Text
        key={String(i)}
        {...(run.color === undefined ? {} : { color: run.color })}
        {...(run.bold === undefined ? {} : { bold: run.bold })}
        {...(run.dim === undefined ? {} : { dimColor: run.dim })}
      >
        {run.text}
      </Text>
    ))}
  </Text>
)
