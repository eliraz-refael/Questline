import type {
  Context,
  FactGoal,
  GradeDimension,
  Mission,
  MissionCadence,
  ParallelGoal,
  ParallelPrompt,
  PlayerState,
  QuestDef,
  QuestGoal,
  QuestPack,
  QuestState,
  ScoringFact,
  SessionSpan,
} from "@pathofdev/schema"
import { addDays, isLater, localDay, startOfDay, weekOf } from "./days.ts"
import { draws } from "./random.ts"
import { qualityDimensions } from "./stats.ts"

// Missions are the daily and weekly quests. Each local day the engine offers the rules' number of dailies, which run
// at once, and each local week (Monday to Sunday) a set of weeklies the player picks from. The sets are drawn from the
// active packs by the player's seed and the window, so a step and its replay draw the same ones.

export const missionCadences: ReadonlyArray<MissionCadence> = ["daily", "weekly"]

/** The window a local day falls in: the day itself, or the Monday that starts its week. */
export const windowOf = (cadence: MissionCadence, day: string): string => (cadence === "daily" ? day : weekOf(day))

/** The instant a window ends: the local midnight after its last day. */
export const windowEnd = (cadence: MissionCadence, window: string, timeZone: string): string =>
  startOfDay(addDays(window, cadence === "daily" ? 1 : 7), timeZone)

/** The pack quest a mission runs, if an active pack still has it. */
export const defOf = (
  packs: ReadonlyArray<QuestPack>,
  mission: Pick<Mission, "packId" | "questId">,
): QuestDef | undefined =>
  packs.find((pack) => pack.id === mission.packId)?.quests.find((q) => q.id === mission.questId)

/**
 * Whether `window` is later than the one last rolled. Windows only move forward: a time zone moved west, back into a
 * day already rolled, keeps the running missions rather than rolling the earlier day again.
 */
export const isNewWindow = (last: string | null, window: string): boolean => last === null || window > last

/** Whether a step at `now` would roll new missions: a local day or week has begun since they were last rolled. */
export const questsDue = (state: PlayerState, now: string): boolean => {
  const today = localDay(now, state.timezone)
  const windows = state.progress.questWindows
  return isNewWindow(windows.daily, windowOf("daily", today)) || isNewWindow(windows.weekly, windowOf("weekly", today))
}

/** Whether a quest may be offered in a window that starts at `start`. */
const isAvailable = (quest: QuestDef, start: string): boolean =>
  (quest.availableFrom === undefined || !isLater(quest.availableFrom, start)) &&
  (quest.availableUntil === undefined || isLater(quest.availableUntil, start))

/**
 * A window's missions: up to `count` of the active packs' quests of that cadence, drawn without repeats by the seed,
 * the window and `salt` (a dev re-roll's own), so the same window draws the same set however often it is rolled.
 */
export const offerFor = (
  context: Pick<Context, "questPacks" | "rollSeed">,
  cadence: MissionCadence,
  window: string,
  count: number,
  timeZone: string,
  salt = "",
): Array<Mission> => {
  const start = startOfDay(window, timeZone)
  const pool = context.questPacks.flatMap((pack) =>
    pack.quests
      .filter((quest) => quest.cadence === cadence && isAvailable(quest, start))
      .map((quest) => ({ pack, quest })),
  )
  const next = draws(context.rollSeed, `quests:${cadence}:${window}${salt}`)
  const picked = Math.min(count, pool.length)
  // The first `picked` places of a Fisher-Yates shuffle.
  for (let i = 0; i < picked; i++) {
    const j = i + Math.floor(next() * (pool.length - i))
    const here = pool[i]
    const there = pool[j]
    if (here !== undefined && there !== undefined) {
      pool[i] = there
      pool[j] = here
    }
  }
  return pool.slice(0, picked).map(({ pack, quest }) => ({
    questId: quest.id,
    packId: pack.id,
    cadence,
    window,
    status: cadence === "daily" ? "active" : "offered",
    progress: 0,
    sessions: [],
    prompts: [],
  }))
}

/** A mission as the mod draws it, as of `now`: one whose window has ended unfinished reads as expired. */
export const questStateOf = (mission: Mission, def: QuestDef, timeZone: string, now: string): QuestState => {
  const expiresAt = windowEnd(mission.cadence, mission.window, timeZone)
  const ended = !isLater(expiresAt, now)
  return {
    questId: mission.questId,
    packId: mission.packId,
    title: def.title,
    description: def.description ?? null,
    cadence: mission.cadence,
    start: mission.cadence === "daily" ? "auto" : "pick",
    status: ended && mission.status !== "completed" ? "expired" : mission.status,
    progress: mission.progress,
    goal: def.goal.count,
    goalKind: def.goal.kind,
    rewards: def.rewards,
    expiresAt,
  }
}

/** The missions as the mod draws them, as of `now`; one whose pack quest is gone has nothing to show. */
export const questStatesOf = (
  packs: ReadonlyArray<QuestPack>,
  missions: ReadonlyArray<Mission>,
  timeZone: string,
  now: string,
): Array<QuestState> =>
  missions.flatMap((mission) => {
    const def = defOf(packs, mission)
    return def === undefined ? [] : [questStateOf(mission, def, timeZone, now)]
  })

/** A graded prompt's scores and weighted grade, which a goal may filter on. */
export interface PromptSignal {
  readonly scores: Readonly<Record<GradeDimension, number>>
  readonly grade: number
}

/** Something that happened which a mission goal may count: a scoring fact, or a stats event. */
export type QuestSignal =
  | { readonly kind: "fact"; readonly fact: ScoringFact; readonly prompt?: PromptSignal }
  | { readonly kind: "clears" }
  | { readonly kind: "compactions"; readonly trigger: "manual" | "auto" }
  | { readonly kind: "command"; readonly command: string }

const promptMeets = (goal: FactGoal, signal: Extract<QuestSignal, { kind: "fact" }>): boolean => {
  if (goal.scores === undefined && goal.grade === undefined) return true
  const prompt = signal.prompt
  if (prompt === undefined) return false
  if (goal.grade !== undefined && prompt.grade < goal.grade) return false
  const scores = goal.scores ?? {}
  return qualityDimensions.every((dimension) => {
    const least = scores[dimension]
    return least === undefined || prompt.scores[dimension] >= least
  })
}

/**
 * Whether a signal counts toward a goal. Context goals count sessions, through `measureMission`, and parallel goals
 * moments, through `joinParallel`, not signals.
 */
export const meets = (goal: QuestGoal, signal: QuestSignal): boolean => {
  switch (goal.kind) {
    case "fact":
      return signal.kind === "fact" && signal.fact === goal.fact && promptMeets(goal, signal)
    case "clears":
      return signal.kind === "clears"
    case "compactions":
      return signal.kind === "compactions" && (goal.trigger === undefined || goal.trigger === signal.trigger)
    case "command":
      return signal.kind === "command" && signal.command === goal.command
    case "context":
    case "parallel":
      return false
  }
}

/** Sessions over the mark a context mission remembers, so a crossed session isn't counted again. */
export const maxCrossedSessions = 20

/**
 * A context measurement folded into a context mission: the session's peak only rises. A session counts once a later
 * one is measured, as the session measured last may still cross the mark, and one over the mark never counts; until
 * the mission completes, a counted session measured again goes back to running, so the progress can fall.
 */
export const measureMission = (mission: Mission, sessionId: string, pct: number, under: number): Mission => {
  const before = mission.sessions.find((session) => session.sessionId === sessionId)
  const peak = before === undefined ? pct : Math.max(before.peak, pct)
  const others = mission.sessions.filter((session) => session.sessionId !== sessionId)
  // Every session under the mark, and the latest ones over it, in the order measured: the one measured last ends it.
  const crossed = others.filter((session) => session.peak >= under)
  const forgotten = new Set(crossed.slice(0, -maxCrossedSessions).map((session) => session.sessionId))
  const sessions = [...others.filter((session) => !forgotten.has(session.sessionId)), { sessionId, peak }]
  return { ...mission, sessions, progress: others.filter((session) => session.peak < under).length }
}

/** The most prompts a parallel mission keeps waiting for a moment; the oldest go first. */
export const maxParallelPrompts = 40

interface Bounds {
  readonly first: number
  readonly last: number
  /** The latest opening and the earliest closing of the chosen prompts' sessions: they met if it is the earlier. */
  readonly opened: number
  readonly closed: number
}

/**
 * A well-graded prompt, made while its session was open, folded into a parallel mission. With waiting prompts of
 * `sessions - 1` other sessions, all made within `withinMinutes` of each other, from sessions whose open spans meet,
 * it makes a moment, and those prompts are spent. The oldest prompts that fit are spent first; prompts too old to meet
 * the newest are let go, as are those whose session's span the presence no longer keeps.
 */
export const joinParallel = (
  mission: Mission,
  goal: ParallelGoal,
  prompt: ParallelPrompt,
  spans: ReadonlyArray<SessionSpan>,
): { readonly mission: Mission; readonly moment: boolean } => {
  const within = goal.withinMinutes * 60_000
  const timeOf = (one: ParallelPrompt): number => Date.parse(one.at)
  const closingOf = (one: ParallelPrompt): number | undefined => {
    const span = spans.find((each) => each.sessionId === one.sessionId && each.openedAt === one.openedAt)
    if (span === undefined) return undefined
    return span.closedAt === null ? Number.POSITIVE_INFINITY : Date.parse(span.closedAt)
  }
  const newest = Math.max(timeOf(prompt), ...mission.prompts.map(timeOf))
  const waiting = [...mission.prompts, prompt]
    .filter((one) => newest - timeOf(one) <= within && closingOf(one) !== undefined)
    .sort((a, b) => timeOf(a) - timeOf(b))
    .slice(-maxParallelPrompts)
  const keep = (prompts: ReadonlyArray<ParallelPrompt>): Mission => ({ ...mission, prompts })
  if (!waiting.includes(prompt)) return { mission: keep(waiting), moment: false }

  const widen = (bounds: Bounds | null, one: ParallelPrompt): Bounds | null => {
    const at = timeOf(one)
    const next: Bounds = {
      first: Math.min(bounds?.first ?? at, at),
      last: Math.max(bounds?.last ?? at, at),
      opened: Math.max(bounds?.opened ?? Number.NEGATIVE_INFINITY, Date.parse(one.openedAt)),
      closed: Math.min(bounds?.closed ?? Number.POSITIVE_INFINITY, closingOf(one) ?? Number.NEGATIVE_INFINITY),
    }
    return next.last - next.first <= within && next.opened < next.closed ? next : null
  }
  // The other sessions in the order their first waiting prompt was made, each with its prompts, oldest first.
  const others = new Map<string, Array<ParallelPrompt>>()
  for (const one of waiting) {
    if (one.sessionId !== prompt.sessionId) others.set(one.sessionId, [...(others.get(one.sessionId) ?? []), one])
  }
  const sessions = [...others.values()]
  type Found = ReadonlyArray<ParallelPrompt> | null
  const search = (from: number, chosen: ReadonlyArray<ParallelPrompt>, bounds: Bounds): Found => {
    if (chosen.length >= goal.sessions) return chosen
    for (let i = from; i < sessions.length; i++) {
      for (const one of sessions[i] ?? []) {
        const next = widen(bounds, one)
        const found = next === null ? null : search(i + 1, [...chosen, one], next)
        if (found !== null) return found
      }
    }
    return null
  }
  const start = widen(null, prompt)
  const spent = start === null ? null : search(0, [prompt], start)
  if (spent === null) return { mission: keep(waiting), moment: false }
  return { mission: keep(waiting.filter((one) => !spent.includes(one))), moment: true }
}
