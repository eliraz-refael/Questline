import type { ClientEvent, Command, ServerEvent, Slot } from '@pathofdev/schema'
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, TextProps, Timer } from 'claude-code'
import type { BandLook, BandSlot, BandView, Celebration, Gain, Link, Loop, Motion, PaneTab, Stage } from '../types'
import { happyLine } from './care'
import { goldRow, labelRun, edgeRow, levelRow } from './band'
import { celebrationOf, chimeOf, chimeWav, gapMs, idleMs, joinQueue, motionOf, queueOf, scriptOf } from './celebrate'
import type { Row } from './cells'
import { cellsOf, cellsOfRow } from './cells'
import type { DevAsk, ServerKind } from './dev'
import { devAskOf, devCommandOf, devUsage, previewEvents, previews, serverOf, startHint, toNextLevel } from './dev'
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
import {
  answerOf,
  initOf,
  isClosed,
  isCommand,
  isEvents,
  isSession,
  isStream,
  ServerDown,
  socketPathsOf,
  streamPathOf,
  urlOf,
} from './server'
import { loops as isLooping, ownedLooks, ratesOf, wornLooks } from './looks'
import type { MissionEntry } from './missions'
import { knowsTogether, missionChip, missionsLayout, missionsViewOf, roomBeside } from './missions'
import type { Choice } from './pane'
import { brand, headerGap, headerOf, lookSections, otherItems, paneId, renamedNote, tabBarOf, tabOf } from './pane'
import type { ShopAction, ShopEntry } from './shop'
import { careViewOf, eggCardLayout, petCardLayout, shopLayout, shopViewOf } from './shop'
import type { SigilChoice } from './sigils'
import { multiplierText, sigilChoices, wornSigil } from './sigils'
import { statsLayout, titleRow } from './stats'
import {
  batchesOf,
  batchGainOf,
  canHatch,
  fadeMs,
  hearts,
  sprite,
  statsViewOf,
  toastOf,
  toastsOf,
  viewOf,
  wardrobeOf,
} from './view'

// Path of Dev's mod: it reports what happens in the session to the local game server, keeps one long-poll open for
// what the server decides, draws the character in a band above the prompt in the looks the player equipped, and
// opens the `/pathofdev` pane. The server computes every number and sends every look but the band's own.

const view = atom({ plugin: 'questline', key: 'view' }, null)
const link = atom({ plugin: 'questline', key: 'link' }, 'connecting')
const gain = atom({ plugin: 'questline', key: 'gain' }, null)
const stage = atom({ plugin: 'questline', key: 'stage' }, null)
const queue = atom({ plugin: 'questline', key: 'queue' }, [])
const wardrobe = atom({ plugin: 'questline', key: 'wardrobe' }, null)
const stats = atom({ plugin: 'questline', key: 'stats' }, null)
const loops = atom({ plugin: 'questline', key: 'loops' }, null)
const tab = atom({ plugin: 'questline', key: 'tab' }, 'inventory')
const missions = atom({ plugin: 'questline', key: 'missions' }, null)
const abandoning = atom({ plugin: 'questline', key: 'abandoning' }, null)
const session = atom({ plugin: 'questline', key: 'session' }, null)
const shop = atom({ plugin: 'questline', key: 'shop' }, null)
const care = atom({ plugin: 'questline', key: 'care' }, null)

/** This copy of the mod: a reload makes a new one, and a frame the old one left behind is never drawn. */
const load = Math.random()

/** Cells the band's rows are set in from each side, and the rows it takes of its own: the edge, a gap, two rows. */
const inset = 2
const ownRows = 4

const toneColor: Record<Gain['tone'], 'text' | 'suggestion' | 'claude' | 'warning' | 'success' | 'error'> = {
  xp: 'text',
  level: 'claude',
  loot: 'suggestion',
  gold: 'warning',
  quest: 'success',
  pet: 'error',
  quiet: 'text',
}

const hatchLabel = '🥚 Hatch your egg'
const eggHint = '🥚 hatches at Lv 1'

/** Events wait here, across sessions, until the server answers them. The oldest go first past this many. */
const maxQueued = 5000
const batchSize = 100
const flushEveryMs = 30_000
const retryMs = 5_000
/** The most of the exit's short bound closing the session may take: the exit goes on without it past that. */
const closeMs = 500

// Module memory: a reload runs session.start again, which sets it all anew.
/** The `toasts` and `server` options. */
let toasts = true
let server: ServerKind = 'default'
/** Takes the gain's line down once it has stood a minute. */
let fadeTimer: Timer | null = null
let sessionId = ''
/** The socket the server last answered on, then the other places it may listen: see `socketPathsOf`. */
let socket = ''
let sockets: ReadonlyArray<string> = []
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
// The looks' loops: a clock for each rate a looping look asks for, so a 4 fps look steps every 250 ms even beside a
// 6 fps one, running only while the prompt is idle, nothing celebrates and the player wants full motion. The pane's
// previews loop while it is open. Each clock counts its own frames.
const loopTimers = new Map<number, Timer>()
const loopTicks = new Map<number, number>()
let isPaneOpen = false
/** Redraws the open pane each minute while it shows the Missions tab, so their time left keeps up. */
let paneClock: Timer | null = null

/**
 * One request to the local server, on the socket it last answered on, else on the others it may listen on. A failure
 * to reach it at all is `ServerDown`.
 */
async function call<A>(
  $: EngineInterface,
  path: string,
  is: (value: unknown) => value is A,
  body?: unknown,
  method?: 'DELETE',
): Promise<A> {
  let failure: unknown = null
  for (const at of [socket, ...sockets.filter((other) => other !== socket)]) {
    let response
    try {
      response = await $.http.fetch(urlOf(path), initOf(at, body, method))
    } catch (cause) {
      failure ??= cause
      continue
    }
    socket = at
    return answerOf(path, response, is)
  }
  throw new ServerDown(`The Path of Dev server does not answer on ${socket}`, { cause: failure })
}

/** Opens the session, or says it is still here; `presence` asks the server to count it live while this mod polls. */
const openSession = ($: EngineInterface) => call($, '/v1/sessions', isSession, { sessionId, presence: true })
/** Closes a session, so the server stops counting it live; a server from before presence answers 404. */
const closeSession = ($: EngineInterface, id: string) =>
  call($, `/v1/sessions/${encodeURIComponent(id)}`, isClosed, undefined, 'DELETE')
const sendEvents = ($: EngineInterface, events: ReadonlyArray<unknown>) => call($, '/v1/events', isEvents, { events })
const runCommand = ($: EngineInterface, command: Command) => call($, '/v1/commands', isCommand, command)
/** Answers once the stream moves past `after`, or after 25 seconds with nothing; each poll keeps the session live. */
const stream = ($: EngineInterface, after: number) => call($, streamPathOf(after, sessionId), isStream)

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

/**
 * What one cause earned, as its events arrive together: a celebration for each, then one line at the end of the band
 * (its biggest moment, for a minute) and one toast for the lot.
 */
const showBatch = async ($: EngineInterface, events: ReadonlyArray<ServerEvent>) => {
  const shown = await read($, view)
  // A meal or a pat names the pet, as the band does.
  const petName = shown?.pet?.name ?? 'Your pet'
  const line = batchGainOf(events, petName)
  if (line !== null) {
    const until = (await $.clock.now()) + fadeMs
    await update($, gain, () => ({ ...line, until }))
    fadeAt($, fadeMs, until)
  }
  const toast = toasts ? toastOf(events, petName) : null
  if (toast !== null) $.ui.toast(toast)
  const glyph = shown?.glyph ?? ''
  const celebrations = motion === 'off' ? [] : events.flatMap((event) => celebrationOf(event, glyph) ?? [])
  if (celebrations.length === 0) return
  lineup = celebrations.reduce(joinQueue, lineup)
  await saveQueue($)
  playSoon($, 0)
}

/** Takes the gain's line down in `ms`, unless a newer line has taken its place by then. */
const fadeAt = ($: EngineInterface, ms: number, until: number) => {
  fadeTimer?.cancel()
  fadeTimer = $.clock.after(Math.max(0, ms), () => {
    fadeTimer = null
    update($, gain, (shown) => (shown?.until === until ? null : shown)).catch(() => undefined)
  })
}

/** A fresh copy of the mod fades the line the last one left, when its minute is up; one with no time fades now. */
const resumeFade = async ($: EngineInterface) => {
  fadeTimer?.cancel()
  fadeTimer = null
  const shown = await read($, gain)
  if (shown === null) return
  const left = Number.isFinite(shown.until) ? shown.until - (await $.clock.now()) : 0
  fadeAt($, left, shown.until)
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
  // The pane's previews loop while it is open: the owned looks, and the ones on the shop's shelf.
  const offered = isPaneOpen ? offerLooks(await read($, shop)) : []
  const looks = [...Object.values(wornLooks(owned)), ...(isPaneOpen ? ownedLooks(owned) : []), ...offered]
  const rates = motion === 'full' && !isTurnRunning && playing === null ? ratesOf(looks) : []
  if (rates.length === loopTimers.size && rates.every((rate) => loopTimers.has(rate))) return
  // The clocks are swapped before any await, so two syncs that overlap never leave two clocks at one rate; the atom
  // is written from the clocks in force when the write lands, so the last sync wins there too.
  for (const [rate, timer] of loopTimers) {
    if (rates.includes(rate)) continue
    timer.cancel()
    loopTimers.delete(rate)
  }
  for (const rate of rates) {
    if (loopTimers.has(rate)) continue
    loopTimers.set(rate, $.clock.every(Math.round(1000 / rate), () => void tickLoop($, rate).catch(() => undefined)))
  }
  await update($, loops, loopsNow)
}

/** The looks of the band styles on the shop's shelf, which the Shop tab previews. */
const offerLooks = (shown: { offers: ReadonlyArray<{ look: BandLook | null }> } | null): Array<BandLook> =>
  (shown?.offers ?? []).flatMap((offer) => (offer.look === null ? [] : [offer.look]))

/** The loops' frames as the clocks in force have counted them; null when none runs, which draws still looks. */
const loopsNow = () =>
  loopTimers.size === 0
    ? null
    : { ticks: Object.fromEntries([...loopTimers.keys()].map((rate) => [String(rate), loopTicks.get(rate) ?? 0])) }

const stopLoops = () => {
  for (const timer of loopTimers.values()) timer.cancel()
  loopTimers.clear()
}

const tickLoop = async ($: EngineInterface, rate: number) => {
  if (!loopTimers.has(rate)) return
  loopTicks.set(rate, (loopTicks.get(rate) ?? 0) + 1)
  // A stop that came in while this tick was being written wins: the still looks stay. An atom a /clear emptied is
  // written again, so the loops pick up where they were.
  await update($, loops, loopsNow)
}

/** Reloads the character from the server; `fromScratch` also moves the cursor to the snapshot's. */
const refresh = async ($: EngineInterface, fromScratch: boolean) => {
  const opened = await openSession($)
  if (fromScratch) cursor = opened.snapshot.cursor
  const next = viewOf(opened.snapshot)
  // An older server's answer carries no rules: it deals in no sigils, and the pane shows none.
  const owned = wardrobeOf(opened.snapshot, opened.rules ?? {})
  const counted = statsViewOf(opened.snapshot, opened.rules ?? {}, owned)
  // An older server's answer carries no rules: the missions then read with no number of picks.
  const quests = missionsViewOf(opened.snapshot, opened.rules ?? {})
  // And no shop or pet care: the Shop tab and the pet's card say to restart it.
  const sold = shopViewOf(opened.snapshot, opened.rules ?? {})
  const cared = careViewOf(opened.snapshot, opened.rules ?? {}, await $.clock.now())
  await update($, view, () => next)
  await update($, wardrobe, () => owned)
  await update($, stats, () => counted)
  await update($, missions, () => quests)
  await update($, shop, () => sold)
  await update($, care, () => cared)
  // Again here, as a /clear empties the session's state after its end hook has written the new id.
  await update($, session, () => sessionId)
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
      const fresh = answer.events.filter((event) => event.seq > cursor)
      for (const batch of batchesOf(fresh)) await showBatch($, batch)
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

/** A command with no answer: only a server that can't be reached is offline; one that answered oddly is still up. */
const commandFailed = async ($: EngineInterface, error: unknown) => {
  if (error instanceof ServerDown) await update($, link, () => 'offline')
  else $.ui.toast('The server answered something unexpected.')
}

/**
 * Puts an owned band style or sigil in its slot, or with no entry empties it (the band's own look back); the band
 * redraws at once.
 */
const wear = ($: EngineInterface, slot: Slot, entryId: string | null) =>
  act($, (id) =>
    entryId === null
      ? { id, type: 'item.unequip', data: { slot } }
      : { id, type: 'item.equip', data: { entryId, slot } },
  )

/** Picks an offered weekly, or gives up a running one; a refusal says why, and the pane redraws from the server. */
const takeMission = async ($: EngineInterface, type: 'quest.accept' | 'quest.abandon', questId: string) => {
  await update($, abandoning, () => null)
  await act($, (id) => ({ id, type, data: { questId } }))
}

/** The first press of a running weekly's Abandon asks again, as its progress would go; null takes the ask back. */
const askAbandon = async ($: EngineInterface, questId: string | null) => {
  await update($, abandoning, () => questId)
}

/**
 * A choice in the pane or the band: a look worn, a mission taken, a purchase, a meal, a pat or a trade. A refusal says
 * why; otherwise the pane redraws from the server, and what it did arrives on the stream, worded on the band and in a
 * toast.
 */
const act = async ($: EngineInterface, made: (id: string) => Command) => {
  try {
    const { id } = await stamp($)
    const answer = await runCommand($, made(id))
    if (answer.status === 'refused') {
      $.ui.toast(answer.message)
      return
    }
    await refresh($, false)
  } catch (error) {
    await commandFailed($, error)
  }
}

const pat = (id: string): Command => ({ id, type: 'pet.pet', data: {} })

/** The command a Shop tab button sends. */
const shopCommand = (action: Exclude<ShopAction, { kind: 'note' }>, id: string): Command => {
  switch (action.kind) {
    case 'buy':
      return { id, type: 'shop.buy', data: { offerId: action.offerId } }
    case 'reroll':
      return { id, type: 'item.reroll', data: { entryId: action.entryId } }
    case 'salvage':
      return { id, type: 'item.salvage', data: { entryId: action.entryId } }
    case 'craft':
      return { id, type: 'shards.craft', data: { rarity: action.rarity, itemId: action.itemId } }
  }
}

/** `/pet`: a pat, from the prompt. What it lifted arrives on the stream; the answer says it was given, or why not. */
const patFromPrompt = async ($: EngineInterface): Promise<string> => {
  const current = await read($, view)
  if (current === null) return 'Connecting to the Path of Dev server…'
  if (current.pet === null) {
    return canHatch(current) ? 'Your egg is ready: hatch it from the band first.' : 'Your egg hatches at level 1.'
  }
  if ((await read($, care))?.isKnown !== true) {
    return `The server predates pet care: restart it with ${startHint(server)}`
  }
  try {
    const { id } = await stamp($)
    const answer = await runCommand($, pat(id))
    if (answer.status === 'refused') return answer.message
    // The pat has landed: a snapshot that can't be fetched now changes nothing about it.
    await refresh($, false).catch(() => undefined)
    return `You pet ${current.pet.name}.`
  } catch (error) {
    if (!(error instanceof ServerDown)) return 'The server answered something unexpected.'
    await update($, link, () => 'offline')
    return 'The Path of Dev server is not answering.'
  }
}

/**
 * Runs what dev mode was asked for: a dev command on the dev server, or a celebration preview here, which plays
 * stand-in events and sends nothing. Only a snapshot from a dev server lets either through.
 */
const runDev = async ($: EngineInterface, ask: DevAsk): Promise<{ text: string; isDone: boolean }> => {
  const current = await read($, view)
  if (current === null || !current.isDev) {
    const how = `set the mod's server option to dev, and start it with ${startHint('dev')}`
    return { text: `Dev mode needs the dev server: ${how}`, isDone: false }
  }
  const shown = await read($, missions)
  if ((ask.kind === 'complete' || ask.kind === 'roll' || ask.kind === 'session') && shown?.isKnown !== true)
    return { text: `The dev server predates missions: restart it with ${startHint('dev')}`, isDone: false }
  // Only a server that names each mission's goal knows parallel missions and stand-in sessions.
  if (ask.kind === 'session' && !knowsTogether(shown))
    return { text: `The dev server predates parallel missions: restart it with ${startHint('dev')}`, isDone: false }
  if ((ask.kind === 'restock' || ask.kind === 'shards') && (await read($, shop))?.isKnown !== true)
    return { text: `The dev server predates the shop: restart it with ${startHint('dev')}`, isDone: false }
  if (ask.kind === 'mood' && (await read($, care))?.isKnown !== true)
    return { text: `The dev server predates pet care: restart it with ${startHint('dev')}`, isDone: false }
  const { id, occurredAt } = await stamp($)
  const command = devCommandOf(ask, id)
  if (command === null) {
    if (ask.kind !== 'celebrate') return { text: devUsage, isDone: false }
    await showBatch($, previewEvents(ask.what, current, occurredAt, id))
    return { text: `Playing a ${ask.what} preview.`, isDone: true }
  }
  try {
    const answer = await runCommand($, command)
    if (answer.status === 'refused') return { text: answer.message, isDone: false }
    // What it made arrives on the stream too, with its celebrations and toast.
    await refresh($, false)
    if (ask.kind === 'session') {
      const text = 'A stand-in session is open, with a prompt graded 10: a good prompt here soon joins it.'
      return { text, isDone: true }
    }
    return { text: 'Done.', isDone: true }
  } catch (error) {
    // Only a server that can't be reached is offline; one that answered oddly is still there.
    if (!(error instanceof ServerDown)) return { text: 'The dev server answered something unexpected.', isDone: false }
    await update($, link, () => 'offline')
    return { text: 'The dev server is not answering.', isDone: false }
  }
}

/** A dev button in the pane: a toast says why, when it did nothing. */
const pressDev = async ($: EngineInterface, ask: DevAsk) => {
  const ran = await runDev($, ask)
  if (!ran.isDone) $.ui.toast(ran.text)
}

/** Opens the pane, and its previews loop while it stays open. */
const openPane = async ($: EngineInterface) => {
  await $.ui.open({ id: paneId, title: 'Path of Dev' })
  isPaneOpen = true
  syncPaneClock($)
  await syncLoop($)
}

/** What `/pathofdev <args>` answers: the pane opened, or dev mode's answer to `dev …`. */
const runCommandLine = async ($: EngineInterface, args: string): Promise<string> => {
  const ask = devAskOf(args)
  if (ask === null) {
    await openPane($)
    return 'Path of Dev pane opened.'
  }
  return typeof ask === 'string' ? ask : (await runDev($, ask)).text
}

/** A minute's redraw runs while the pane is open, and stops with it. */
const syncPaneClock = ($: EngineInterface) => {
  if (!isPaneOpen) {
    paneClock?.cancel()
    paneClock = null
    return
  }
  // Only a tab that tells time redraws: the Missions tab, the Shop's restock, and the pet's meal running out on the
  // Inventory tab. Any other leaves the band and the pane undrawn.
  paneClock ??= $.clock.every(60_000, () => {
    void (async () => {
      const [shown, cared, sold, now] = await Promise.all([read($, tab), read($, care), read($, shop), $.clock.now()])
      const at = tabOf(shown)
      // Past the restock the shelf on show has ended: the next snapshot brings the new day's, which no stream event
      // may bring while the player browses.
      if (at === 'shop' && (sold?.offers ?? []).some((offer) => offer.endsAt !== null && offer.endsAt <= now))
        await refresh($, false).catch(() => undefined)
      if (at === 'missions' || at === 'shop' || (at === 'inventory' && (cared?.boost ?? null) !== null))
        $.ui.invalidate('ui.render')
    })()
  })
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

/** Waits for `work` at most `ms`, whatever it ends in: what it throws stays here. */
const within = ($: EngineInterface, ms: number, work: Promise<unknown>): Promise<void> =>
  new Promise((resolve) => {
    const timer = $.clock.after(Math.max(0, ms), resolve)
    const done = () => {
      timer.cancel()
      resolve()
    }
    work.then(done, done)
  })

/** Runs `work` once the hook has returned; whatever it throws stays here, so it never fails a prompt or a command. */
const later = ($: EngineInterface, work: () => Promise<unknown>) => {
  $.clock.after(0, () => {
    work().catch(() => undefined)
  })
}

/**
 * A new session: its id (`kept`, the one a reload of the mod finds in the session's state, else a fresh one), then the
 * repo, its first exploration and the server, after the hook returns.
 */
const begin = async ($: EngineInterface, cwd: string, kept: string | null) => {
  $.ui.status(undefined)
  lastPrompt = ''
  lastAnswer = ''
  turnPeak = null
  sessionId = kept ?? ulid(await $.clock.now())
  await update($, session, () => sessionId)
  const named = (await $.env.get('PATHOFDEV_HOME')) || (await $.env.get('QUESTLINE_HOME'))
  sockets = socketPathsOf(named, await $.env.get('HOME'), server === 'dev')
  socket = sockets[0] ?? ''
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
  toasts = toastsOf(options)
  server = serverOf(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await resumeCelebrations($)
    await resumeFade($)
    // A reload keeps the session's id: a new one would leave the old open beside it, as if two sessions ran.
    await begin($, e.cwd, await read($, session))
    flushTimer?.cancel()
    flushTimer = $.clock.every(flushEveryMs, () => void flush($))
    // A pane the last copy of the mod opened stays up across a reload: the engine keeps the record.
    isPaneOpen = (await $.ui.panes().catch(() => [])).some((pane) => pane.id === paneId)
    // A fresh copy starts its own minute; a reload took the last copy's with it.
    paneClock?.cancel()
    paneClock = null
    syncPaneClock($)
    stopLoops()
    // The atom outlives a reload: clear the last copy's frames, or a sync with no clock to start leaves them frozen.
    await update($, loops, () => null)
    await syncLoop($)
    await $.command
      .register({
        name: 'pathofdev',
        description:
          'Open the Path of Dev pane: your inventory, the shop, stats and missions (`dev …` on the dev server)',
      })
      .catch(() => undefined)
    await $.command
      .register({ name: 'questline', description: 'Questline is now Path of Dev: the same as /pathofdev' })
      .catch(() => undefined)
    await $.command
      .register({ name: 'pet', description: 'Pet your Path of Dev companion: a pat lifts its mood a little' })
      .catch(() => undefined)
    return result
  })

  on('command.run', { command: 'pet' }, async ($) => ({ text: await patFromPrompt($) }))

  on('command.run', { command: 'pathofdev' }, async ($, e) => ({ text: await runCommandLine($, e.args) }))

  // The command's name from before Path of Dev: it does what /pathofdev does, and says it was renamed the first time.
  on('command.run', { command: 'questline' }, async ($, e) => {
    const text = await runCommandLine($, e.args)
    if ((await $.store.get('renameNoted')) === true) return { text }
    await $.store.set('renameNoted', true)
    return { text: `${text}\n${renamedNote}` }
  })

  on('ui.close', { id: paneId }, async ($, e, next) => {
    const result = await next(e)
    isPaneOpen = false
    syncPaneClock($)
    await syncLoop($)
    return result
  }).catch(($, e, next) => next(e))

  // A /clear ends the conversation without a new session.start, and the band's state goes with it: close the session
  // and start again under a new one. So does a resume, which goes on under another session. Any other end is the
  // process going: the session is closed within a short part of the exit's bound, and the exit goes on regardless.
  on('session.end', async ($, e, next) => {
    const ending = sessionId
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      await within($, Math.min(closeMs, next.budget.remainingMs / 2), closeSession($, ending))
      // The server never opens a closed session again: a later start that finds this state takes a new id.
      await update($, session, () => null).catch(() => undefined)
      return next(e)
    }
    const result = await next(e)
    // Counted under the session it ends.
    if (e.reason === 'clear') await enqueue($, { ...(await stamp($)), type: 'session.cleared', data: {} })
    later($, () => closeSession($, ending))
    await begin($, await $.session.cwd(), null)
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
    const moving = e.props.isWorking ? null : await read($, loops)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The band's top edge, so it reads apart from the transcript above it.
    const rule = draw(Text, edgeRow(e.props.bodyColumns, looks.topEdge ?? null, moving), 'edge')

    if (status === 'offline') {
      return (
        <Box flexDirection="column">
          {rule}
          <Box flexWrap="wrap">
            <Text color="claude" bold>
              ⚔ Path of Dev{' '}
            </Text>
            <Text dimColor>offline · start the server: {startHint(server)}</Text>
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
    const level = levelRow(current, looks.levelDisplay ?? null, moving)
    const gold = goldRow(current, looks.goldDisplay ?? null, moving)
    // The hearts follow the rules' happy line; a pet the server cares for takes a pat from a click.
    const cared = await read($, care)
    const petHearts = pet === null ? '' : hearts(pet.mood, happyLine(cared))
    // The mission on row 2 takes what the row's other pieces leave, so the row never wraps for it.
    const petCells =
      pet !== null
        ? cellsOf(`${sprite(pet)} ${pet.name} ${petHearts}`)
        : canHatch(current)
          ? cellsOf(hatchLabel) + 4
          : cellsOf(eggHint)
    const tail = slot !== null ? cellsOfRow(slot) : last === null ? 0 : cellsOf(last.text)
    const widths = [cellsOfRow(level), cellsOfRow(gold), petCells, ...(tail > 0 ? [tail] : [])]
    const chip = missionChip(await read($, missions), roomBeside(columns, widths, 2), await $.clock.now())
    // Under the edge, a row of air, then the XP bar alone and everything else under it, both set in from the sides.
    return (
      <Box flexDirection="column">
        {rule}
        <Text> </Text>
        <Box flexDirection="column" paddingX={inset}>
          {draw(Text, bar, 'bar')}
          <Box flexWrap="wrap" columnGap={2}>
            {draw(Text, level, 'level')}
            {draw(Text, gold, 'gold')}
            {pet !== null && cared?.isKnown === true ? (
              <Button key="band:pet" plain onPress={() => void act($, pat)}>
                {sprite(pet)} {pet.name} <Text color="error">{petHearts}</Text>
              </Button>
            ) : pet !== null ? (
              <Text>
                {sprite(pet)} {pet.name} <Text color="error">{petHearts}</Text>
              </Text>
            ) : canHatch(current) ? (
              <Button key="hatch" label={hatchLabel} variant="primary" onPress={() => void hatch($)} />
            ) : (
              <Text dimColor>{eggHint}</Text>
            )}
            {chip === null ? null : draw(Text, chip, 'mission')}
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
  // by the band's own code, and a button that puts it on. The stats are cards that stats.ts lays out.
  on('ui.render', { component: 'Pane', requestId: paneId }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const status = await read($, link)
    const current = await read($, view)
    const owned = await read($, wardrobe)
    const moving = await read($, loops)
    const shownTab = tabOf(await read($, tab))
    // Inside the pane's padding: the header and the tab bar fit it on one row each, at any width.
    const columns = Math.max(0, e.props.bodyColumns - 2)
    const width = Math.max(20, columns)
    const preview = Math.max(20, Math.min(width - 4, 56))

    const bar = tabBarOf(shownTab, columns)
    const tabBar = (
      <Box key="tabs" columnGap={bar.gap}>
        {bar.chips.map((chip) =>
          chip.kind === 'shown' ? (
            <Text key={chip.id} bold color="claude" wrap="truncate">
              {chip.text}
            </Text>
          ) : chip.kind === 'ready' ? (
            <Button key={`tab:${chip.id}`} plain label={chip.text} onPress={() => void showTab($, chip.id)} />
          ) : (
            <Text key={chip.id} dimColor wrap="truncate">
              {chip.text}
              {chip.soon ? <Text italic> soon</Text> : null}
            </Text>
          ),
        )}
      </Box>
    )
    const beside = current === null ? '' : headerOf(current, columns)
    const header = (
      <Box flexDirection="column">
        <Text key="header" wrap="truncate">
          <Text bold color="claude">
            {brand}
          </Text>
          {beside === '' ? null : (
            <Text dimColor>
              {' '.repeat(headerGap)}
              {beside}
            </Text>
          )}
        </Text>
        <Text> </Text>
        {tabBar}
        <Text dimColor wrap="truncate">
          {'─'.repeat(columns)}
        </Text>
      </Box>
    )
    if (current === null || owned === null) {
      const why =
        status === 'offline'
          ? `The Path of Dev server is not answering. Start it: ${startHint(server)}`
          : 'Connecting to the Path of Dev server…'
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          <Text dimColor>{why}</Text>
        </Box>
      )
    }

    if (shownTab === 'missions') {
      const quests = await read($, missions)
      if (quests === null) {
        return (
          <Box flexDirection="column" paddingX={1}>
            {header}
            <Text dimColor>Fetching your missions…</Text>
          </Box>
        )
      }
      const layout = missionsLayout(quests, columns, await $.clock.now())
      const asking = await read($, abandoning)
      // Each mission: its head beside its buttons, then its description, its bar and count, and what it grants.
      const missionRow = (entry: MissionEntry) => {
        const { mission, action } = entry
        const id = mission.questId
        const isAsking = action === 'abandon' && asking === id
        const canComplete = current.isDev && (mission.status === 'active' || mission.status === 'offered')
        return (
          <Box key={`mission:${mission.cadence}:${id}`} flexDirection="column" marginLeft={2} marginBottom={1}>
            <Box flexWrap="wrap" columnGap={2}>
              {draw(Text, entry.head, `mission:${mission.cadence}:${id}:head`)}
              {action === 'accept' ? (
                <Button
                  key={`accept:${id}`}
                  label="Accept"
                  variant="primary"
                  onPress={() => void takeMission($, 'quest.accept', id)}
                />
              ) : null}
              {action === 'full' ? <Text dimColor>log full</Text> : null}
              {action === 'abandon' && !isAsking ? (
                <Button key={`abandon:${id}`} label="Abandon" dimColor onPress={() => void askAbandon($, id)} />
              ) : null}
              {canComplete ? (
                <Button
                  key={`dev:complete:${id}`}
                  label="Complete"
                  dimColor
                  onPress={() => void pressDev($, { kind: 'complete', questId: id })}
                />
              ) : null}
            </Box>
            <Box marginLeft={2} flexDirection="column">
              {mission.description === null ? null : <Text dimColor>{mission.description}</Text>}
              {draw(Text, entry.meter, `mission:${mission.cadence}:${id}:meter`)}
              {draw(Text, entry.rewards, `mission:${mission.cadence}:${id}:rewards`)}
              {isAsking ? (
                <Box key={`asking:${id}`} flexWrap="wrap" columnGap={2}>
                  <Text color="warning">Give it up? Its progress goes, and it goes back on offer.</Text>
                  <Button
                    key={`confirm-abandon:${id}`}
                    label="Abandon"
                    variant="primary"
                    onPress={() => void takeMission($, 'quest.abandon', id)}
                  />
                  <Button key={`keep:${id}`} label="Keep it" onPress={() => void askAbandon($, null)} />
                </Box>
              ) : null}
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          {draw(Text, layout.intro, 'missions:intro')}
          {layout.note === null ? null : draw(Text, layout.note, 'missions:note')}
          <Text> </Text>
          {layout.sections.map((section) => (
            <Box key={`missions:${section.key}`} flexDirection="column" width={layout.width}>
              {draw(Text, section.title, `missions:${section.key}:title`)}
              {section.groups.map((group) => (
                <Box key={`missions:${section.key}:${group.key}`} flexDirection="column">
                  {group.label === null ? null : (
                    <Box marginLeft={2}>{draw(Text, group.label, `missions:${group.key}:label`)}</Box>
                  )}
                  {group.empty === null ? null : (
                    <Box marginLeft={2} marginBottom={1}>
                      {draw(Text, group.empty, `missions:${group.key}:empty`)}
                    </Box>
                  )}
                  {group.entries.map(missionRow)}
                </Box>
              ))}
            </Box>
          ))}
          {/* A server older than missions would refuse a re-roll: no button for it. */}
          {current.isDev && quests.isKnown ? (
            <Box key="dev" flexDirection="column">
              <Text>
                <Text bold color="warning">
                  Dev
                </Text>
                <Text dimColor> the sandbox save: Complete finishes a mission at once, its rewards marked dev</Text>
              </Text>
              <Box flexWrap="wrap" columnGap={2} marginLeft={2}>
                <Button key="dev:roll" label="Re-roll missions" onPress={() => void pressDev($, { kind: 'roll' })} />
                {knowsTogether(quests) ? (
                  <Button
                    key="dev:session"
                    label="Stand-in session"
                    onPress={() => void pressDev($, { kind: 'session' })}
                  />
                ) : null}
              </Box>
            </Box>
          ) : null}
        </Box>
      )
    }

    if (shownTab === 'shop') {
      const sold = await read($, shop)
      if (sold === null) {
        return (
          <Box flexDirection="column" paddingX={1}>
            {header}
            <Text dimColor>Opening the shop…</Text>
          </Box>
        )
      }
      const layout = shopLayout(sold, await read($, care), current.pet?.name ?? null, columns, await $.clock.now())
      // A row's button, or the dim note that stands in its place: sold out, or the gold still to find.
      const actionOf = (entry: ShopEntry, action: ShopAction, i: number) => {
        if (action.kind === 'note') return draw(Text, action.row, `shop:${entry.key}:note:${i}`)
        const key =
          action.kind === 'buy'
            ? `buy:${action.offerId}`
            : action.kind === 'craft'
              ? `craft:${action.rarity}:${action.itemId}`
              : `${action.kind}:${entry.key}`
        return (
          <Button
            key={key}
            label={action.label}
            {...(action.kind === 'buy' || action.kind === 'craft' ? { variant: 'primary' } : {})}
            {...(action.kind === 'salvage' ? { dimColor: true } : {})}
            onPress={() => void act($, (id) => shopCommand(action, id))}
          />
        )
      }
      // A row with a preview or lore stands apart from the next; the section's own gap follows its last.
      const entryRow = (section: string, entry: ShopEntry, isLast: boolean) => (
        <Box
          key={`shop:${section}:${entry.key}`}
          flexDirection="column"
          marginLeft={2}
          {...(!isLast && (entry.preview !== null || entry.lore !== null) ? { marginBottom: 1 } : {})}
        >
          <Box flexWrap="wrap" columnGap={2}>
            {draw(Text, entry.head, `shop:${entry.key}:head`)}
            {entry.actions.map((action, i) => actionOf(entry, action, i))}
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {entry.details.map((row, i) => draw(Text, row, `shop:${entry.key}:detail:${i}`))}
            {entry.preview === null
              ? null
              : draw(
                  Text,
                  previewRow(
                    current,
                    entry.preview.slot,
                    entry.preview.look,
                    isLooping(entry.preview.look) ? moving : null,
                    preview,
                  ),
                  `shop:${entry.key}:preview`,
                )}
            {entry.lore === null ? null : (
              <Text dimColor italic>
                {entry.lore}
              </Text>
            )}
          </Box>
        </Box>
      )
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          {draw(Text, layout.intro, 'shop:intro')}
          {layout.note === null ? null : draw(Text, layout.note, 'shop:note')}
          <Text> </Text>
          {layout.sections.map((section) => (
            <Box key={`shop:${section.key}`} flexDirection="column" width={layout.width} marginBottom={1}>
              {draw(Text, section.title, `shop:${section.key}:title`)}
              {section.rows.map((row, i) => draw(Text, row, `shop:${section.key}:row:${i}`))}
              {section.empty === null ? null : (
                <Box marginLeft={2}>{draw(Text, section.empty, `shop:${section.key}:empty`)}</Box>
              )}
              {section.entries.map((entry, i) => entryRow(section.key, entry, i === section.entries.length - 1))}
            </Box>
          ))}
          {/* A server older than the shop would refuse these: no buttons for them. */}
          {current.isDev && sold.isKnown ? (
            <Box key="dev" flexDirection="column">
              <Text>
                <Text bold color="warning">
                  Dev
                </Text>
                <Text dimColor> the sandbox save: restock the shelf, and gold and shards to spend</Text>
              </Text>
              <Box flexWrap="wrap" columnGap={2} marginLeft={2}>
                <Button key="dev:restock" label="Restock" onPress={() => void pressDev($, { kind: 'restock' })} />
                <Button
                  key="dev:shop-gold"
                  label="Gold 10000"
                  onPress={() => void pressDev($, { kind: 'gold', gold: 10_000 })}
                />
                <Button
                  key="dev:shards"
                  label="10 shards each"
                  onPress={() => void pressDev($, { kind: 'shards', count: 10 })}
                />
              </Box>
            </Box>
          ) : null}
        </Box>
      )
    }

    if (shownTab === 'stats') {
      const counted = await read($, stats)
      if (counted === null) {
        return (
          <Box flexDirection="column" paddingX={1}>
            {header}
            <Text dimColor>Counting…</Text>
          </Box>
        )
      }
      // Cards of label and number rows, each as wide as its card: one column, or two side by side on a wide pane.
      const layout = statsLayout(counted, current, columns, { looks: wornLooks(owned), loop: moving })
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          {draw(Text, layout.intro, 'stats:intro')}
          {layout.note === null ? null : draw(Text, layout.note, 'stats:note')}
          <Text> </Text>
          <Box key="stats" columnGap={layout.gap}>
            {layout.columns.map((cards, i) => (
              <Box key={`stats:column:${i}`} flexDirection="column" width={layout.width}>
                {cards.map((card) => (
                  <Box key={`stats:${card.key}`} flexDirection="column" marginBottom={1}>
                    {draw(Text, titleRow(card.title, layout.width), `stats:${card.key}:title`)}
                    {card.rows.map((row, j) => draw(Text, row, `stats:${card.key}:${j}`))}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    const sections = lookSections(owned)
    const styles = sections.reduce((count, section) => count + section.choices.length - 1, 0)
    const others = otherItems(owned)
    const previewOf = (slot: BandSlot, choice: Choice): Row =>
      previewRow(current, slot, choice.look, choice.isLooping ? moving : null, preview)
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

    // The sigils owned, strongest first, the worn one marked: one counts at a time, so the pane says which.
    const sigils = sigilChoices(owned)
    const worn = wornSigil(owned)
    const sigilRow = (choice: SigilChoice) => {
      const color = choice.rarity === null ? undefined : rarityColors[choice.rarity]
      const notes = [
        choice.sigil === null ? 'no longer in the catalogue' : `${multiplierText(choice.sigil.multiplier)} prompt XP`,
        ...(choice.rarity === null ? [] : [choice.rarity]),
        ...(choice.count > 1 ? [`${choice.count} owned`] : []),
      ].join(' · ')
      const mark = choice.sigil?.glyph ?? '?'
      const markColor = choice.sigil?.color ?? ''
      return (
        <Box key={`sigil:${choice.key}`} flexDirection="column" marginLeft={2} marginBottom={1}>
          <Box flexWrap="wrap" columnGap={2}>
            <Text>
              <Text color={choice.isWorn ? 'success' : 'inactive'}>{choice.isWorn ? '●' : '○'}</Text>{' '}
              <Text bold {...(markColor === '' ? {} : { color: markColor })}>
                {mark}
              </Text>{' '}
              <Text bold {...(color === undefined ? {} : { color })}>
                {choice.name}
              </Text>
              <Text dimColor> {notes}</Text>
            </Text>
            {choice.isWorn ? (
              <Text color="success">equipped</Text>
            ) : (
              <Button
                key={`equip:sigil:${choice.key}`}
                label="Equip"
                onPress={() => void wear($, 'sigil', choice.entryId)}
              />
            )}
            {choice.isWorn ? (
              <Button key="unequip:sigil" label="Unequip" dimColor onPress={() => void wear($, 'sigil', null)} />
            ) : null}
          </Box>
          {choice.lore === null ? null : (
            <Box marginLeft={2}>
              <Text dimColor italic>
                {choice.lore}
              </Text>
            </Box>
          )}
        </Box>
      )
    }
    const sigilIntro =
      worn?.sigil !== undefined
        ? `${multiplierText(worn.sigil.multiplier)} on the XP your graded prompts earn · one worn at a time`
        : owned.equipped['sigil'] !== undefined
          ? 'the one worn is no longer in the catalogue, and adds nothing · one worn at a time'
          : sigils.length === 0
          ? 'none yet: they drop like any loot, and multiply the XP your graded prompts earn'
          : 'none worn · one at a time multiplies the XP your graded prompts earn'
    // Only a server that deals in sigils gets the section: an older one has none to show.
    const sigilSection =
      owned.knowsSigils !== true ? null : (
        <Box key="sigils" flexDirection="column">
          <Text>
            <Text bold>Sigil</Text>
            <Text dimColor>
              {'  '}
              {sigilIntro}
            </Text>
          </Text>
          <Text> </Text>
          {sigils.map(sigilRow)}
          {sigils.length === 0 ? <Text> </Text> : null}
        </Box>
      )

    // The pet's card, first: how it feels, a pat, and the food it can eat. Before the hatch, the egg.
    const cared = await read($, care)
    const pet = current.pet
    let petSection
    if (pet === null) {
      const egg = eggCardLayout(canHatch(current), columns)
      petSection = (
        <Box key="pet" flexDirection="column" marginBottom={1}>
          {draw(Text, egg.title, 'pet:title')}
          <Box flexWrap="wrap" columnGap={2}>
            {draw(Text, egg.row, 'pet:egg')}
            {canHatch(current) ? (
              <Button key="pet:hatch" label="Hatch" variant="primary" onPress={() => void hatch($)} />
            ) : null}
          </Box>
        </Box>
      )
    } else {
      const shownPet = { face: sprite(pet), name: pet.name, mood: pet.mood }
      const card = petCardLayout(cared, shownPet, columns, await $.clock.now())
      petSection = (
        <Box key="pet" flexDirection="column" marginBottom={1}>
          {draw(Text, card.title, 'pet:title')}
          {card.rows.map((row, i) => draw(Text, row, `pet:row:${i}`))}
          {card.note === null ? null : <Box marginLeft={2}>{draw(Text, card.note, 'pet:note')}</Box>}
          {card.canPet ? (
            <Box flexWrap="wrap" columnGap={2} marginLeft={2}>
              <Button key="pet:pat" label="Pet" variant="primary" onPress={() => void act($, pat)} />
              {card.petHint === null ? null : draw(Text, card.petHint, 'pet:hint')}
            </Box>
          ) : null}
          {card.boost === null ? null : draw(Text, card.boost, 'pet:boost')}
          {card.canPet ? (
            <Box flexDirection="column" marginLeft={2}>
              {card.food === null ? null : draw(Text, card.food, 'pet:food')}
              {card.empty === null ? null : <Box marginLeft={2}>{draw(Text, card.empty, 'pet:empty')}</Box>}
              {card.meals.map((meal) => (
                <Box key={`meal:${meal.key}`} flexDirection="column" marginLeft={2}>
                  <Box flexWrap="wrap" columnGap={2}>
                    {draw(Text, meal.head, `meal:${meal.key}:head`)}
                    <Button
                      key={`feed:${meal.key}`}
                      label="Feed"
                      onPress={() =>
                        void act($, (id) => ({ id, type: 'pet.feed', data: { entryId: meal.entryId } }))
                      }
                    />
                  </Box>
                  {meal.lore === null ? null : (
                    <Box marginLeft={2}>
                      <Text dimColor italic>
                        {meal.lore}
                      </Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        {petSection}
        {sigilSection}
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
        {/* Dev mode's controls, only while the mod plays on a dev server. */}
        {current.isDev ? (
          <Box key="dev" flexDirection="column" marginTop={1}>
            <Text>
              <Text bold color="warning">
                Dev
              </Text>
              <Text dimColor> the sandbox save: whatever this makes is marked dev</Text>
            </Text>
            <Box flexWrap="wrap" columnGap={2} marginLeft={2}>
              <Button
                key="dev:styles"
                label="Grant all band styles"
                onPress={() => void pressDev($, { kind: 'styles' })}
              />
              <Button
                key="dev:level"
                label="XP to the next level"
                onPress={() => void pressDev($, { kind: 'xp', amount: toNextLevel(current) })}
              />
              <Button key="dev:xp" label="+1000 XP" onPress={() => void pressDev($, { kind: 'xp', amount: 1000 })} />
              <Button
                key="dev:gold"
                label="Gold 10000"
                onPress={() => void pressDev($, { kind: 'gold', gold: 10_000 })}
              />
              <Button key="dev:gold-0" label="Gold 0" onPress={() => void pressDev($, { kind: 'gold', gold: 0 })} />
              {current.pet !== null && cared?.isKnown === true ? (
                <Button
                  key="dev:mood-20"
                  label="Mood 20"
                  onPress={() => void pressDev($, { kind: 'mood', mood: 20 })}
                />
              ) : null}
              {current.pet !== null && cared?.isKnown === true ? (
                <Button
                  key="dev:mood-100"
                  label="Mood 100"
                  onPress={() => void pressDev($, { kind: 'mood', mood: 100 })}
                />
              ) : null}
            </Box>
            <Box flexWrap="wrap" columnGap={2} marginLeft={2}>
              <Text dimColor>Celebrate</Text>
              {previews.map((what) => (
                <Button
                  key={`dev:celebrate:${what}`}
                  plain
                  label={what}
                  onPress={() => void pressDev($, { kind: 'celebrate', what })}
                />
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}

/** A band style's live preview, drawn by the band's own functions with the player's real XP, level and gold. */
const previewRow = (
  current: BandView,
  slot: BandSlot,
  look: BandLook | null,
  motion: Loop | null,
  width: number,
): Row => {
  switch (slot) {
    case 'xpBar':
      return [...barRow(current, width, null, look, motion), labelRun(current, look)]
    case 'levelDisplay':
      return levelRow(current, look, motion)
    case 'topEdge':
      return edgeRow(width, look, motion)
    case 'goldDisplay':
      return goldRow(current, look, motion)
  }
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
