import type { ClientEvent, Command, ServerEvent, Slot } from '@pathofdev/schema'
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, PluginOptions, Register, TextProps, Timer } from 'claude-code'
import type {
  BandLook,
  BandSlot,
  BandView,
  Celebration,
  Gain,
  Link,
  Loop,
  Motion,
  PaneTab,
  Stage,
  WelcomeStep,
  WelcomeView,
  Wizard,
} from '../types'
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
import type { Poll, DeviceCode } from './login'
import {
  accessTokenRequest,
  accountAskOf,
  deviceCodeOf,
  deviceCodeRequest,
  firstPoll,
  nextPoll,
  pollAnswerOf,
  signInOf,
  signInRequestOf,
  timeZoneOf,
} from './login'
import {
  checkoutRef,
  commandNameOf,
  commitRef,
  compactionOf,
  exitIsTheRuns,
  repoIn,
  repoOf,
  repoRef,
  subjectFormOf,
  testRunner,
  workRef,
} from './observe'
import type { Repo } from './observe'
import {
  answerOf,
  failureOf,
  idOf,
  isClosed,
  isCommand,
  isEvents,
  isSession,
  isStream,
  queueAfter,
  requestOf,
  ServerDown,
  settledBy,
  SignedOut,
  socketPathsOf,
  storeKey,
  streamPathOf,
  targetOf,
  tokenOf,
} from './server'
import type { Route, Target } from './server'
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
import type { ServerName } from './switching'
import { nameOf, nowText, placeOf, serverAskOf, serverRowOf, tagOf, whereText } from './switching'
import type { WelcomeLayout } from './welcome'
import {
  closeSetsAside,
  freshWizard,
  speciesWord,
  stepAfter,
  stepBefore,
  welcomeLayout,
  welcomeViewOf,
} from './welcome'
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
const welcome = atom({ plugin: 'questline', key: 'welcome' }, null)
const wizard = atom({ plugin: 'questline', key: 'wizard' }, null)

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
/** Signed out, the mod knocks less often: a sign-in reconnects at once anyway. */
const signedOutRetryMs = 60_000
/** The most of the exit's short bound closing the session may take: the exit goes on without it past that. */
const closeMs = 500

// Module memory: a reload runs session.start again, which sets it all anew.
/** The `toasts` and `server` options, and where the `server` and `serverUrl` options say the mod plays. */
let toasts = true
let server: ServerKind = 'default'
let target: Target = { kind: 'local' }
/** The options as `register` took them, which a switch of servers reads the online server's URL from. */
let given: PluginOptions = {}
/** `PATHOFDEV_HOME` (or `QUESTLINE_HOME`), when set: the home of either local server. */
let named: string | undefined
/**
 * Counts the switches of server: a poll, a flush or a snapshot that set out before one is the last server's, and
 * nothing it brings back is shown or settled here.
 */
let generation = 0
/** A switch of server is under way: a second one meanwhile is turned away. */
let isSwitching = false
/** The online server said the player is signed out (a 401, or no token to send): the band says to sign in. */
let isSignedOut = false
/**
 * The GitHub sign-in under way, for an online origin: its code, where the device flow stands, and the timer of its
 * next poll. A logout, or a new sign-in, stops it; a reload of the mod lets it go.
 */
type SigningIn = { readonly origin: string; readonly code: DeviceCode; poll: Poll; timer: Timer | null }
let signingIn: SigningIn | null = null
/** The `minWords` option, which the welcome's grading step says. */
let gradeWords = 6
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
 * One request to the target: to a local server on the socket it last answered on, else on the others it may listen
 * on, or to the online server with the player's token. A failure to reach it at all is `ServerDown`.
 */
async function call<A>(
  $: EngineInterface,
  path: string,
  is: (value: unknown) => value is A,
  body?: unknown,
  method?: 'DELETE',
): Promise<A> {
  const route: Route = { path, ...(body === undefined ? {} : { body }), ...(method === undefined ? {} : { method }) }
  // The target as the call set out: a switch of server during the token's read must not send this one elsewhere.
  const to = target
  const token = to.kind === 'online' ? tokenOf(await $.store.get(storeKey(to, 'token'))) : null
  // With no token the online server can only answer 401: don't knock every few seconds to hear it.
  if (to.kind === 'online' && token === null) {
    noteSignedOut($, to, false)
    throw new SignedOut(`${path}: not signed in to ${to.origin}`)
  }
  let failure: unknown = null
  const tried = to.kind === 'online' ? [to.origin] : [socket, ...sockets.filter((other) => other !== socket)]
  for (const at of tried) {
    const { url, init } = requestOf(to, route, { socketPath: at, token })
    let response
    try {
      response = await $.http.fetch(url, init)
    } catch (cause) {
      failure ??= cause
      continue
    }
    // An answer from the last server's socket, after a switch, leaves the new server's first in line.
    if (target.kind === 'local' && sockets.includes(at)) socket = at
    const answered = failureOf(response)
    if (answered === 'signedOut') noteSignedOut($, to, true)
    else if (answered === null && to === target) isSignedOut = false
    return answerOf(path, response, is)
  }
  throw new ServerDown(`The Path of Dev server does not answer on ${tried.join(' or ')}`, { cause: failure })
}

/**
 * The online server answered 401, or there was no token to send: the player is signed out there, and every event
 * stays queued for them. A token the server turned away is toasted once, as the band alone may go unnoticed.
 */
const noteSignedOut = ($: EngineInterface, to: Target, hadToken: boolean) => {
  if (to !== target) return
  if (hadToken && !isSignedOut && to.kind === 'online')
    $.ui.toast(`The Path of Dev server at ${to.origin} signed you out: /pathofdev login signs you in again.`)
  isSignedOut = true
}

/** What to do when the target doesn't answer: start the local server, sign in, or wait on the online one. */
const offlineHint = (): string =>
  target.kind === 'online'
    ? isSignedOut
      ? 'sign in with /pathofdev login'
      : `the server at ${target.origin} is not answering`
    : `start the server: ${startHint(server)}`

const notAnswering = (): string =>
  target.kind === 'online'
    ? isSignedOut
      ? `You're not signed in to the Path of Dev server at ${target.origin}: /pathofdev login signs you in.`
      : `The Path of Dev server at ${target.origin} is not answering.`
    : `The Path of Dev server is not answering. Start it: ${startHint(server)}`

/** Opens the session, or says it is still here; `presence` asks the server to count it live while this mod polls. */
const openSession = ($: EngineInterface) => call($, '/v1/sessions', isSession, { sessionId, presence: true })
/** Closes a session, so the server stops counting it live; a server from before presence answers 404. */
const closeSession = ($: EngineInterface, id: string) =>
  call($, `/v1/sessions/${encodeURIComponent(id)}`, isClosed, undefined, 'DELETE')
const sendEvents = ($: EngineInterface, events: ReadonlyArray<unknown>) => call($, '/v1/events', isEvents, { events })
const runCommand = ($: EngineInterface, command: Command) => call($, '/v1/commands', isCommand, command)
/** Answers once the stream moves past `after`, or after 25 seconds with nothing; each poll keeps the session live. */
const stream = ($: EngineInterface, after: number) => call($, streamPathOf(after, sessionId), isStream)

const queued = async ($: EngineInterface, key = storeKey(target, 'queue')): Promise<Array<unknown>> => {
  const stored = await $.store.get(key)
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
    await $.store.set(storeKey(target, 'queue'), [...(await queued($)), event].slice(-maxQueued))
  })

const stamp = async ($: EngineInterface) => {
  const now = await $.clock.now()
  return { id: ulid(now), occurredAt: new Date(now).toISOString(), sessionId }
}

/** Sends what waits, a batch at a time. Whatever the server answered leaves the queue; the rest waits. */
const flush = async ($: EngineInterface): Promise<void> => {
  if (isFlushing) return
  isFlushing = true
  // The queue of the server this flush set out for: a switch of server stops it before its next batch.
  const at = generation
  const key = storeKey(target, 'queue')
  // What this flush has sent and must leave queued (an unknown type waits for a newer server): the next batch
  // reads past it, so a run of such events never holds back the ones behind it.
  const waiting = new Set<string>()
  try {
    for (;;) {
      const batch = (await queued($, key)).filter((event) => !waiting.has(idOf(event) ?? '')).slice(0, batchSize)
      if (batch.length === 0 || at !== generation) return
      // A failure throws past here, so it settles nothing: a signed-out or offline server keeps every event.
      const done = settledBy(await sendEvents($, batch))
      for (const event of batch) if (!done.has(idOf(event) ?? '')) waiting.add(idOf(event) ?? '')
      if (done.size > 0)
        await changeQueue(async () => {
          await $.store.set(key, queueAfter(await queued($, key), done))
        })
    }
  } catch (error) {
    if (error instanceof ServerDown && at === generation) await update($, link, () => 'offline')
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
  const at = generation
  const opened = await openSession($)
  // The last server's snapshot, after a switch: the band shows only the server the mod plays on now.
  if (at !== generation) return
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
  // And no welcome: the mod never offers it there.
  const greeted = welcomeViewOf(opened.snapshot, opened.rules ?? {}, gradeWords)
  await update($, view, () => next)
  await update($, wardrobe, () => owned)
  await update($, stats, () => counted)
  await update($, missions, () => quests)
  await update($, shop, () => sold)
  await update($, care, () => cared)
  await update($, welcome, () => greeted)
  // Again here, as a /clear empties the session's state after its end hook has written the new id.
  await update($, session, () => sessionId)
  await update($, link, () => 'online')
  await syncLoop($)
}

/** One long-poll, then the next. A failure waits a little and reconnects from a fresh snapshot. */
const poll = async ($: EngineInterface): Promise<void> => {
  if (isPolling) return
  isPolling = true
  const at = generation
  try {
    const answer = await stream($, cursor)
    // The last server's stream, after a switch, which let it go: what it brought is not this server's.
    if (at !== generation) return
    if (answer.resync === true) {
      await refresh($, true)
    } else if (answer.events.length > 0) {
      const fresh = answer.events.filter((event) => event.seq > cursor)
      for (const batch of batchesOf(fresh)) await showBatch($, batch)
      cursor = answer.cursor
      await refresh($, false)
    }
    if (at !== generation) return
    isPolling = false
    $.clock.after(0, () => void poll($))
  } catch {
    if (at !== generation) return
    isPolling = false
    await update($, link, () => 'offline').catch(() => undefined)
    retryLater($)
  }
}

/** One reconnect waits at a time: a /clear that connects again while one waits replaces it, not adds to it. */
const retryLater = ($: EngineInterface) => {
  reconnect?.cancel()
  reconnect = $.clock.after(isSignedOut ? signedOutRetryMs : retryMs, () => void connect($))
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
  await offerWelcome($).catch(() => undefined)
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
  repo = repoIn(subjectFormOf(target), repoOf(await git($, cwd, ['remote', 'get-url', 'origin']), top))
  const head = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  branch = head === null || head === 'HEAD' ? null : head
}

/** The first session in a repo explores it. */
const explore = async ($: EngineInterface) => {
  if (repo === null) return
  const id = repo.kind === 'github' ? repo.name : repo.id
  const stored = await $.store.get(storeKey(target, 'explored'))
  const explored = Array.isArray(stored) ? stored : []
  if (explored.includes(id)) return
  await enqueue($, {
    ...(await stamp($)),
    type: 'repo.explored',
    data: { repo: await repoRef(secret, repo) },
  })
  await $.store.set(storeKey(target, 'explored'), [...explored, id])
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

/**
 * Hatches the egg: as the server says it is, picked in the welcome or its default; an older server says nothing of it,
 * and hatches the fox Ember, as every egg did before the welcome.
 */
const hatch = async ($: EngineInterface) => {
  const egg = (await read($, welcome))?.egg ?? { species: 'fox', name: 'Ember' }
  try {
    const answer = await runCommand($, {
      ...(await stamp($)),
      type: 'pet.hatch',
      data: { species: egg.species, name: egg.name },
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
    const how = `switch to it with /pathofdev server dev, and start it with ${startHint('dev')}`
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

/** Why the server the mod plays on does not answer, as the player can act on it: online with no token, sign in. */
const signedOutText = (origin: string): string =>
  ` You're not signed in to ${origin}, so the mod waits offline and keeps what you do queued for it: ` +
  '/pathofdev login signs you in.'

const downText = (): string =>
  target.kind === 'online' ? ' It is not answering now.' : ` It isn't running: start it with ${startHint(server)}`

/** What a first try at the server just switched to came to: nothing to add once it answered. */
const reachText = (error: unknown): string =>
  error === null
    ? ''
    : error instanceof SignedOut && target.kind === 'online'
      ? signedOutText(target.origin)
      : error instanceof ServerDown
        ? downText()
        : ' It answered something unexpected.'

/** `/pathofdev server`: where the mod plays, and, when it is offline there, why and what to do. */
const whereNow = async ($: EngineInterface): Promise<string> => {
  const where = whereText(target, named)
  if ((await read($, link)) !== 'offline') return where
  if (target.kind !== 'online') return `${where}${downText()}`
  const token = tokenOf(await $.store.get(storeKey(target, 'token')))
  return `${where}${token === null || isSignedOut ? signedOutText(target.origin) : downText()}`
}

/** Takes down what the mod showed of the last server, so none of it (its dev controls, say) stays on show. */
const forget = async ($: EngineInterface) => {
  fadeTimer?.cancel()
  fadeTimer = null
  frame?.cancel()
  frame = null
  reconnect?.cancel()
  reconnect = null
  lineup = []
  playing = null
  await update($, link, () => 'connecting')
  await update($, view, () => null)
  await update($, wardrobe, () => null)
  await update($, stats, () => null)
  await update($, missions, () => null)
  await update($, shop, () => null)
  await update($, care, () => null)
  await update($, welcome, () => null)
  await update($, wizard, () => null)
  await update($, abandoning, () => null)
  await update($, gain, () => null)
  await update($, stage, () => null)
  await update($, queue, () => [])
  await syncLoop($)
}

/**
 * `/pathofdev server play|dev|online`, or `dev off`: the mod plays on that server from now on. The choice is the
 * `server` option, written as the player would in /config, so the settings say the same; the engine reloads the mod
 * with it, and the reload finds the mod there already. The last server first sends what waits for it, if it answers
 * at once (the rest stays queued for it), and closes its session; then the mod opens a new one on the new server.
 */
const switchServer = async ($: EngineInterface, to: ServerName): Promise<string> => {
  if (to === nameOf(target)) return `Already playing on ${placeOf(target, named)}.`
  if (isSwitching) return 'A switch of server is under way.'
  isSwitching = true
  try {
    const row = serverRowOf(await $.config.list().catch(() => []), $.plugin.name)
    if (row === null) return 'This session lists no Server option for Path of Dev: set it in /config.'
    if (row.isLocked) return 'Your managed settings pin the Server option, so the mod stays where it plays.'
    const ending = sessionId
    await within($, closeMs, flush($))
    await within($, closeMs, closeSession($, ending))
    // The server never opens a closed session again: the reload the write sets off, finding this state, takes a new id.
    await update($, session, () => null).catch(() => undefined)
    const written = await $.config
      .set({ key: row.key, value: to })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    if (written.deny !== undefined) {
      // Still here: a new session, as the server never opens a closed one again.
      await begin($, await $.session.cwd(), null)
      return `The Server option stays as it is: ${written.deny}`
    }
    generation += 1
    // The stream held on the last server is let go: the new one's starts at once, not once that one answers.
    isPolling = false
    given = { ...given, server: to }
    server = serverOf(given)
    target = targetOf(given)
    isSignedOut = false
    stopSignIn()
    // The repo as the new server's subjects name it, at once: none goes online by name before begin finds it again.
    if (repo !== null) repo = repoIn(subjectFormOf(target), repo)
    await forget($)
    await begin($, await $.session.cwd(), null)
    const reached = await refresh($, true).then(() => null, (error: unknown) => error)
    if (reached instanceof ServerDown) await update($, link, () => 'offline')
    return `${nowText(target, named)}${reachText(reached)}`
  } finally {
    isSwitching = false
  }
}

/** Stops the GitHub sign-in under way, if any: true when there was one. */
const stopSignIn = (): boolean => {
  const was = signingIn
  was?.timer?.cancel()
  signingIn = null
  return was !== null
}

/** Why sign-in is for the online server alone. */
const noSignIn = (): string =>
  `You play on ${placeOf(target, named)}, which needs no sign-in. /pathofdev server online switches to the online ` +
  'server.'

/**
 * `/pathofdev login`: starts GitHub's device flow and says where to enter the code. The mod polls GitHub as it asks,
 * trades the GitHub token for a game token at the online server, and toasts how it went; the player plays on meanwhile.
 */
const login = async ($: EngineInterface): Promise<string> => {
  if (target.kind !== 'online') return noSignIn()
  const to = target
  const under = signingIn
  if (under !== null && under.origin === to.origin)
    return `A sign-in is under way: open ${under.code.verificationUri} and enter ${under.code.userCode}.`
  stopSignIn()
  const token = tokenOf(await $.store.get(storeKey(to, 'token')))
  if (token !== null && !isSignedOut) return `You're signed in to ${to.origin}. /pathofdev logout signs you out.`
  const asked = deviceCodeRequest()
  const response = await $.http.fetch(asked.url, asked.init).catch(() => null)
  if (response === null) return 'GitHub is not answering: try /pathofdev login again in a minute.'
  const code = response.ok ? deviceCodeOf(response.text) : null
  if (code === null) return `GitHub did not start a sign-in (it answered ${response.status}): try again in a minute.`
  // A switch of server while GitHub answered: this sign-in was for the last one.
  if (target !== to) return noSignIn()
  const flow: SigningIn = { origin: to.origin, code, poll: firstPoll(code, await $.clock.now()), timer: null }
  // A code that expires before its first poll could come: kept, it would stand as "under way" with nothing polling.
  if (flow.poll.kind !== 'waiting') return 'GitHub gave a sign-in code that expires at once: try /pathofdev login again.'
  signingIn = flow
  waitToPoll($, flow)
  const minutes = Math.max(1, Math.round(code.expiresIn / 60))
  return (
    `To sign in to ${to.origin}, open ${code.verificationUri} and enter ${code.userCode} ` +
    `(it works for ${minutes} minute${minutes === 1 ? '' : 's'}). GitHub tells the server only who you are; the mod ` +
    "says when you're in, and what you do meanwhile waits in the queue."
  )
}

/** Sets the flow's next poll, while it waits: only ever before its code expires, as `nextPoll` sees to. */
const waitToPoll = ($: EngineInterface, flow: SigningIn) => {
  if (flow.poll.kind !== 'waiting') return
  flow.timer = $.clock.after(flow.poll.intervalMs, () => void pollGitHub($, flow).catch(() => undefined))
}

/** One poll of GitHub, and what the flow comes to: another wait, or its end, which a toast says. */
const pollGitHub = async ($: EngineInterface, flow: SigningIn) => {
  flow.timer = null
  if (signingIn !== flow) return
  const asked = accessTokenRequest(flow.code.deviceCode)
  const answer = await $.http.fetch(asked.url, asked.init).then(pollAnswerOf, () => null)
  // A logout or a new sign-in while GitHub answered stopped this one.
  if (signingIn !== flow) return
  flow.poll = nextPoll(flow.poll, answer, await $.clock.now())
  const poll = flow.poll
  if (poll.kind === 'waiting') {
    waitToPoll($, flow)
    return
  }
  if (poll.kind === 'signedIn') {
    // The flow stays under way through the trade, so a logout or a switch meanwhile still stops it.
    try {
      await trade($, flow, poll.githubToken)
    } finally {
      if (signingIn === flow) signingIn = null
    }
    return
  }
  signingIn = null
  if (poll.kind === 'expired') $.ui.toast('The GitHub sign-in code expired: /pathofdev login gives you a new one.')
  else if (poll.kind === 'denied') $.ui.toast('The GitHub sign-in was cancelled: /pathofdev login starts another.')
  else $.ui.toast(`GitHub turned the sign-in down (${poll.error}): /pathofdev login starts another.`)
}

/** The request that revokes `token` at an online target. */
const revokeOf = (to: Target, token: string) =>
  requestOf(to, { path: '/v1/auth/logout', method: 'POST' }, { socketPath: '', token })

/**
 * Trades the GitHub token for a game token at `origin`, the server the sign-in was started for, and drops it: kept
 * nowhere, sent nowhere else. The game token goes in the store; a sign-in turned down or unchecked leaves the sign-in
 * as it was. A token it replaces is revoked, so none is left working that nobody holds.
 */
const trade = async ($: EngineInterface, flow: SigningIn, githubToken: string) => {
  const { origin } = flow
  const to: Target = { kind: 'online', origin }
  const asked = signInRequestOf(to, githubToken, timeZoneOf())
  if (asked === null) return
  const response = await $.http.fetch(asked.url, asked.init).catch(() => null)
  // A logout or a switch of server while the server answered stopped this sign-in: its token is not kept.
  if (signingIn !== flow) return
  if (response === null) {
    $.ui.toast(`The Path of Dev server at ${origin} is not answering: try /pathofdev login again later.`)
    return
  }
  const signIn = signInOf(response)
  if (signIn.kind === 'refused') {
    const why = signIn.message === null ? '' : `: ${signIn.message}`
    $.ui.toast(`The Path of Dev server at ${origin} turned the sign-in down${why}.`)
    return
  }
  if (signIn.kind === 'unavailable') {
    $.ui.toast("The sign-in can't be checked right now (GitHub or the server is busy): try /pathofdev login again in a minute.")
    return
  }
  if (signIn.kind === 'unexpected') {
    $.ui.toast(`The Path of Dev server at ${origin} answered the sign-in with ${signIn.status}.`)
    return
  }
  signingIn = null
  const key = storeKey(to, 'token')
  const replaced = tokenOf(await $.store.get(key))
  await $.store.set(key, signIn.token)
  if (replaced !== null && replaced !== signIn.token) {
    const revoke = revokeOf(to, replaced)
    later($, () => $.http.fetch(revoke.url, revoke.init))
  }
  $.ui.toast(`Signed in to ${origin}${signIn.login === null ? '' : ` as ${signIn.login}`}.`)
  // Still playing there: the band comes online now, and what waited in the queue goes.
  if (target.kind === 'online' && target.origin === origin) {
    isSignedOut = false
    await connect($)
  }
}

/**
 * `/pathofdev logout`: the server revokes the game token and the mod forgets it; a 401 means it was gone already, so
 * the mod forgets it then too. A server that doesn't answer leaves the player signed in, to try again, rather than
 * leave a token working that nobody holds to revoke. What waits in the queue stays for the next sign-in.
 */
const logout = async ($: EngineInterface): Promise<string> => {
  const stopped = stopSignIn() ? 'The sign-in under way is stopped. ' : ''
  if (target.kind !== 'online') return `${stopped}${noSignIn()}`
  const to = target
  const key = storeKey(to, 'token')
  const token = tokenOf(await $.store.get(key))
  if (token === null) return `${stopped}You're not signed in to ${to.origin}.`
  const { url, init } = revokeOf(to, token)
  const response = await $.http.fetch(url, init).catch(() => null)
  const failure = response === null ? 'unavailable' : failureOf(response)
  if (failure !== null && failure !== 'signedOut') {
    const why = response === null ? 'is not answering' : `answered ${response.status}`
    return (
      `${stopped}The Path of Dev server at ${to.origin} ${why}, so you're still signed in: try /pathofdev logout ` +
      'again later.'
    )
  }
  // Only the token this logout revoked: a sign-in that landed meanwhile stays.
  if (tokenOf(await $.store.get(key)) === token) await $.store.delete(key)
  if (target === to) {
    isSignedOut = true
    await update($, link, () => 'offline')
  }
  return `${stopped}Signed out of ${to.origin}. What you do waits in the queue until you sign in again.`
}

/** A dev button in the pane: a toast says why, when it did nothing. */
const pressDev = async ($: EngineInterface, ask: DevAsk) => {
  const ran = await runDev($, ask)
  if (!ran.isDone) $.ui.toast(ran.text)
}

/**
 * Opens the pane, and its previews loop while it stays open. `focus` asks for the keyboard, which the surface grants
 * only over an empty prompt: the person asked for the pane.
 */
const openPane = async ($: EngineInterface, focus = false) => {
  const opened = await $.ui.open({ id: paneId, title: 'Path of Dev', ...(focus ? { focus: true } : {}) })
  isPaneOpen = true
  syncPaneClock($)
  await syncLoop($)
  return opened
}

/**
 * The welcome, offered on its own: when the mod connects to a server that runs it and the player hasn't finished or
 * skipped it, it opens the pane on it, without the keyboard, so a prompt being typed keeps its keys. A pane up already
 * is the player's: the welcome waits on its tab instead of taking the pane over. A terminal too narrow to place the
 * pane unasked says how to open it.
 */
const offerWelcome = async ($: EngineInterface) => {
  const shown = await read($, welcome)
  if (shown?.isKnown !== true || shown.isDone) return
  // Asked of the engine, whose record outlives a reload, rather than of a flag the session's start may not have set.
  if ((await $.ui.panes().catch(() => [])).some((pane) => pane.id === paneId)) return
  await update($, wizard, () => null)
  await update($, tab, () => 'welcome')
  const opened = await openPane($)
  if (!opened.isPlaced) $.ui.toast('Welcome to Path of Dev: /pathofdev welcome opens your first-run guide.')
}

/** `/pathofdev welcome`, or the egg's Change: the welcome from its first step, or from `step`, with the keyboard. */
const openWelcome = async ($: EngineInterface, step: WelcomeStep = 'hello'): Promise<string> => {
  const shown = await read($, welcome)
  if (shown === null) {
    return (await read($, link)) === 'offline' ? notAnswering() : 'Connecting to the Path of Dev server…'
  }
  if (!shown.isKnown) return `The server predates the welcome: restart it with ${startHint(server)}`
  await update($, wizard, () => ({ ...freshWizard, step }))
  await update($, tab, () => 'welcome')
  await openPane($, true)
  return 'The Path of Dev welcome is open.'
}

/**
 * The welcome finished, skipped or set aside: the server hears it once, so it never opens on its own again, and every
 * other session stops offering it. Marked here at once, so a second press or a close right after sends nothing more.
 */
const markWelcomed = async ($: EngineInterface) => {
  const shown = await read($, welcome)
  if (shown?.isKnown !== true || shown.isDone) return
  await update($, welcome, (was) => (was === null ? was : { ...was, isDone: true }))
  await act($, (id) => ({ id, type: 'welcome.done', data: {} }))
}

/** Start playing, or Skip: the pane lands on the inventory, and the welcome starts afresh if opened again. */
const leaveWelcome = async ($: EngineInterface) => {
  await update($, wizard, () => null)
  await update($, tab, () => 'inventory')
  await markWelcomed($)
}

/**
 * A choice of the welcome's, sent as it is made: null once the server took it, else why not in the server's words,
 * which the step shows in place.
 */
const choose = async ($: EngineInterface, made: (id: string) => Command): Promise<string | null> => {
  try {
    const { id } = await stamp($)
    const answer = await runCommand($, made(id))
    if (answer.status === 'refused') return answer.message
    // The choice has landed: a snapshot that can't be fetched now changes nothing about it.
    await refresh($, false).catch(() => undefined)
    return null
  } catch (error) {
    if (!(error instanceof ServerDown)) return 'The server answered something unexpected.'
    await update($, link, () => 'offline')
    return 'The Path of Dev server is not answering.'
  }
}

/** What a step saves before the next one: the character's name, or the egg, each only when it changed. */
const saveStep = async (
  $: EngineInterface,
  draft: Wizard,
  band: BandView,
  shown: WelcomeView,
): Promise<string | null> => {
  const name = draft.name
  if (draft.step === 'name' && name !== null && name.trim() !== band.name) {
    return choose($, (id) => ({ id, type: 'character.rename', data: { name } }))
  }
  const egg = shown.egg
  if (draft.step === 'pet' && band.pet === null && egg !== null) {
    const species = draft.species ?? egg.species
    const petName = draft.petName ?? egg.name
    if (species !== egg.species || petName.trim() !== egg.name) {
      return choose($, (id) => ({ id, type: 'egg.choose', data: { species, name: petName } }))
    }
  }
  return null
}

/**
 * The welcome's next step: what this one picked saved first, and a refusal keeps the step, saying why. Enter in a
 * field passes what it holds as `typed`. The last step lands on the pane.
 */
const nextStep = async ($: EngineInterface, typed?: string) => {
  const at = (await read($, wizard)) ?? freshWizard
  const band = await read($, view)
  const shown = await read($, welcome)
  if (band === null || shown === null) return
  const draft: Wizard =
    typed === undefined
      ? at
      : at.step === 'name'
        ? { ...at, name: typed }
        : at.step === 'pet'
          ? { ...at, petName: typed }
          : at
  const error = await saveStep($, draft, band, shown)
  // A Back, or another press, while the save was out has moved the wizard on: it stands as they left it.
  const moved = async () => ((await read($, wizard)) ?? freshWizard).step !== draft.step
  if (error !== null) {
    if (!(await moved())) await update($, wizard, () => ({ ...draft, error }))
    return
  }
  if (draft.step === 'ready') {
    await leaveWelcome($)
    return
  }
  if (await moved()) return
  await update($, wizard, () => ({ ...draft, step: stepAfter(draft.step), error: null }))
}

const backStep = async ($: EngineInterface) => {
  await update($, wizard, (at) => {
    const was = at ?? freshWizard
    return { ...was, step: stepBefore(was.step), error: null }
  })
}

/** What the player types or picks on a step, kept until the step saves it; a new try clears the last refusal. */
const draftStep = async ($: EngineInterface, change: Partial<Pick<Wizard, 'name' | 'species' | 'petName'>>) => {
  await update($, wizard, (at) => ({ ...(at ?? freshWizard), ...change, error: null }))
}

/**
 * What `/pathofdev <args>` answers: the pane opened, the welcome, a sign-in or out, the servers' answer, or dev mode's
 * to `dev …`.
 */
const runCommandLine = async ($: EngineInterface, args: string): Promise<string> => {
  if (args.trim() === 'welcome') return openWelcome($)
  const account = accountAskOf(args)
  if (account !== null) return typeof account === 'string' ? account : account.kind === 'login' ? login($) : logout($)
  const servers = serverAskOf(args)
  if (servers !== null) {
    if (typeof servers === 'string') return servers
    return servers.kind === 'where' ? whereNow($) : switchServer($, servers.to)
  }
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
  named = (await $.env.get('PATHOFDEV_HOME')) || (await $.env.get('QUESTLINE_HOME'))
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
  gradeWords = minWords
  motion = motionOf(options)
  toasts = toastsOf(options)
  server = serverOf(options)
  target = targetOf(options)
  given = options

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
          'Open the Path of Dev pane: your inventory, the shop, stats and missions (`welcome` for the first-run ' +
          'guide, `server` to say or switch which server you play on, `login` and `logout` for the online server, ' +
          '`dev …` on the dev server)',
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
    // The player closing the pane on the welcome sets it aside, as Skip does: it never opens on its own again.
    if (closeSetsAside(e.origin.kind, tabOf(await read($, tab)))) later($, () => leaveWelcome($))
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
            <Text dimColor>offline · {offlineHint()}</Text>
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
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile app draws no text field yet: the welcome names nothing there.
    const Input = 'Input' in elements ? elements.Input : null
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
    // Beside the title, the server when it is not the player's own save, so dev mode and online play read apart.
    const where = tagOf(target)
    const beside = current === null ? '' : headerOf(current, columns - (where === '' ? 0 : cellsOf(where) + 1))
    const header = (
      <Box flexDirection="column">
        <Text key="header" wrap="truncate">
          <Text bold color="claude">
            {brand}
          </Text>
          {where === '' ? null : <Text color={where === 'dev' ? 'warning' : 'suggestion'}> {where}</Text>}
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
          ? notAnswering()
          : 'Connecting to the Path of Dev server…'
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          <Text dimColor>{why}</Text>
        </Box>
      )
    }

    if (shownTab === 'welcome') {
      const shown = await read($, welcome)
      if (shown === null || !shown.isKnown) {
        const why =
          shown === null
            ? 'Fetching the welcome…'
            : `The server predates the welcome: restart it with ${startHint(server)}`
        return (
          <Box flexDirection="column" paddingX={1}>
            {header}
            <Text dimColor>{why}</Text>
          </Box>
        )
      }
      const layout: WelcomeLayout = welcomeLayout({
        view: shown,
        band: current,
        wizard: (await read($, wizard)) ?? freshWizard,
        columns,
        isFocused: e.props.isFocused,
        hasInput: Input !== null,
        ...(target.kind === 'online' ? { online: target.origin } : {}),
      })
      const { part } = layout
      // The ready step draws the player's own band, by the band's own code, in the looks they wear.
      const worn = wornLooks(owned)
      const bandWidth = Math.max(20, layout.width - 2)
      const field = (
        key: string,
        label: string,
        value: string,
        placeholder: string,
        apply: (typed: string) => Partial<Pick<Wizard, 'name' | 'petName'>>,
      ) =>
        Input === null ? null : (
          <Box key={`${key}:row`} marginLeft={2}>
            <Input
              key={key}
              label={label}
              value={value}
              placeholder={placeholder}
              submitLabel="next"
              autoFocus
              onInput={(typed) => void draftStep($, apply(typed))}
              onSubmit={(typed) => void nextStep($, typed)}
            />
          </Box>
        )
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          {draw(Text, layout.stepper, 'welcome:stepper')}
          <Text> </Text>
          <Box key="welcome:body" flexDirection="column" width={layout.width}>
            {draw(Text, layout.title, 'welcome:title')}
            <Text> </Text>
            {part.kind === 'band' ? (
              <Box key="welcome:band" flexDirection="column" marginLeft={2} marginBottom={1}>
                <Text dimColor>Your band, as it stands:</Text>
                {draw(Text, edgeRow(bandWidth, worn.topEdge ?? null, moving), 'welcome:band:edge')}
                <Box flexDirection="column" paddingX={2}>
                  {draw(
                    Text,
                    [
                      ...barRow(current, bandWidth - 4, null, worn.xpBar ?? null, moving),
                      labelRun(current, worn.xpBar ?? null),
                    ],
                    'welcome:band:bar',
                  )}
                  <Box flexWrap="wrap" columnGap={2}>
                    {draw(Text, levelRow(current, worn.levelDisplay ?? null, moving), 'welcome:band:level')}
                    {draw(Text, goldRow(current, worn.goldDisplay ?? null, moving), 'welcome:band:gold')}
                    {current.pet === null ? (
                      <Text dimColor>🥚 {shown.egg?.name ?? 'your egg'}</Text>
                    ) : (
                      <Text>
                        {sprite(current.pet)} {current.pet.name}{' '}
                        <Text color="error">{hearts(current.pet.mood, happyLine(await read($, care)))}</Text>
                      </Text>
                    )}
                  </Box>
                </Box>
              </Box>
            ) : null}
            {layout.paragraphs.map((row, i) => (
              <Box key={`welcome:para:${i}`} marginLeft={2} marginBottom={1}>
                {para(Text, row, `welcome:para:${i}:text`)}
              </Box>
            ))}
            {part.kind === 'name' ? (
              <Box key="welcome:name" flexDirection="column" marginBottom={1}>
                {field('welcome:name', 'Name  ', part.value, current.name, (typed) => ({ name: typed }))}
              </Box>
            ) : null}
            {part.kind === 'egg' ? (
              <Box key="welcome:egg" flexDirection="column" marginBottom={1}>
                <Box key="welcome:cards" flexWrap="wrap" columnGap={1} marginLeft={1}>
                  {part.cards.map((card) => (
                    <Box
                      key={`welcome:card:${card.id}`}
                      flexDirection="column"
                      alignItems="center"
                      width={18}
                      borderStyle="round"
                      borderColor={card.isPicked ? 'claude' : 'inactive'}
                      hover={{ borderColor: 'claude' }}
                    >
                      <Text bold color={card.isPicked ? 'claude' : 'text'}>
                        {card.face}
                      </Text>
                      <Button
                        key={`welcome:species:${card.id}`}
                        plain
                        {...(card.hotkey === '' ? {} : { hotkey: card.hotkey })}
                        onPress={() => void draftStep($, { species: card.id })}
                      >
                        {card.isPicked ? (
                          <Text bold color="inverseText" backgroundColor="claude">
                            {` ${card.name} `}
                          </Text>
                        ) : (
                          <Text>{card.name}</Text>
                        )}
                      </Button>
                      <Text dimColor wrap="truncate">
                        {card.about}
                      </Text>
                    </Box>
                  ))}
                </Box>
                <Text> </Text>
                {field('welcome:petName', 'Its name  ', part.value, shown.egg?.name ?? '', (typed) => ({
                  petName: typed,
                }))}
                <Box marginLeft={2}>{draw(Text, part.preview, 'welcome:preview')}</Box>
              </Box>
            ) : null}
            {part.kind === 'hatched' ? (
              <Box key="welcome:hatched" flexDirection="column" marginLeft={2} marginBottom={1}>
                {draw(Text, part.card, 'welcome:pet')}
                {draw(Text, part.note, 'welcome:pet:note')}
              </Box>
            ) : null}
            {part.kind === 'points'
              ? part.points.map((point) => (
                  <Box key={`welcome:point:${point.key}`} flexDirection="column" marginBottom={1}>
                    {draw(Text, point.title, `welcome:point:${point.key}:title`)}
                    <Box marginLeft={3}>{para(Text, point.text, `welcome:point:${point.key}:text`)}</Box>
                    {point.rows.map((row, i) => draw(Text, row, `welcome:point:${point.key}:${i}`))}
                  </Box>
                ))
              : null}
            {layout.error === null ? null : (
              <Box key="welcome:error" marginLeft={2} marginBottom={1}>
                {para(Text, layout.error, 'welcome:error:text')}
              </Box>
            )}
            <Box key="welcome:buttons" flexWrap="wrap" columnGap={2} marginLeft={2}>
              {layout.back === null ? null : (
                <Button key="welcome:back" label={layout.back} onPress={() => void backStep($)} />
              )}
              <Button
                key="welcome:next"
                label={layout.next}
                variant="primary"
                {...(part.kind === 'name' || (part.kind === 'egg' && Input !== null) ? {} : { autoFocus: true })}
                onPress={() => void nextStep($)}
              />
              <Button key="welcome:skip" label={layout.skip} dimColor onPress={() => void leaveWelcome($)} />
            </Box>
            <Text> </Text>
            {draw(Text, layout.keys, 'welcome:keys')}
          </Box>
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
      // A server that runs the welcome names the egg, and its species and name can change there until it hatches.
      const greeted = await read($, welcome)
      const picked = greeted?.isKnown === true ? greeted.egg : null
      const egg = eggCardLayout(
        canHatch(current),
        columns,
        picked === null ? null : { name: picked.name, species: speciesWord(greeted?.species ?? [], picked.species) },
      )
      petSection = (
        <Box key="pet" flexDirection="column" marginBottom={1}>
          {draw(Text, egg.title, 'pet:title')}
          <Box flexWrap="wrap" columnGap={2}>
            {draw(Text, egg.row, 'pet:egg')}
            {canHatch(current) ? (
              <Button key="pet:hatch" label="Hatch" variant="primary" onPress={() => void hatch($)} />
            ) : null}
            {picked === null ? null : (
              <Button key="pet:change" label="Change" dimColor onPress={() => void openWelcome($, 'pet')} />
            )}
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

/** Shows a tab of the pane. Leaving the welcome for another sets it aside, as Skip does, its step kept for a return. */
const showTab = async ($: EngineInterface, next: PaneTab) => {
  const was = tabOf(await read($, tab))
  await update($, tab, () => next)
  if (was === 'welcome' && next !== 'welcome') await markWelcomed($)
}

/** Each run of a row as a Text of its own style, for `draw` and `para` to hold. */
const runsOf = (Text: ElementConstructor<TextProps>, row: Row) =>
  row.map((run, i) => (
    <Text
      key={String(i)}
      {...(run.color === undefined ? {} : { color: run.color })}
      {...(run.bold === undefined ? {} : { bold: run.bold })}
      {...(run.dim === undefined ? {} : { dimColor: run.dim })}
      {...(run.background === undefined ? {} : { backgroundColor: run.background })}
    >
      {run.text}
    </Text>
  ))

/** One row of styled runs as one Text, cut at the band's edge rather than wrapped. */
const draw = (Text: ElementConstructor<TextProps>, row: Row, key: string) => (
  <Text key={key} wrap="truncate">
    {runsOf(Text, row)}
  </Text>
)

/** One paragraph of styled runs, wrapped to the width it is given rather than cut. */
const para = (Text: ElementConstructor<TextProps>, row: Row, key: string) => <Text key={key}>{runsOf(Text, row)}</Text>
