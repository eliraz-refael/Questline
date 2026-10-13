import type {
  ArmedTestRun,
  Boost,
  ClientEvent,
  Command,
  CommandRefusal,
  Context,
  DevCommand,
  GradeDimension,
  Input,
  InventoryEntry,
  ItemDef,
  Mission,
  OwnedPet,
  PlayerState,
  PlayerStats,
  Progress,
  RollRecord,
  QuestDef,
  QuestLoot,
  Rarity,
  ScoringFact,
  ServerEventDraft,
  Slot,
  StatCounters,
  Step,
  SystemEvent,
  XpRule,
} from "@pathofdev/schema"
import { addDays, isLater, localDay } from "./days.ts"
import { formFor, formsFor, glyphFor, levelOf, moodNow, titleFor, totalXp } from "./derive.ts"
import type { RarityWeights } from "./loot.ts"
import { pityAfter, raiseRare, rarityRank, rollLoot } from "./loot.ts"
import { nameIssue, tidyName } from "./names.ts"
import { lifted, patted } from "./pet.ts"
import { closeSpan, openSpan, prunePresence, spanAt } from "./presence.ts"
import { equippedSigil, isSigil } from "./sigils.ts"
import { petSlots } from "./project.ts"
import type { QuestSignal } from "./quests.ts"
import {
  defOf,
  isNewWindow,
  joinParallel,
  measureMission,
  meets,
  missionCadences,
  offerFor,
  type PromptSignal,
  questStateOf,
  questStatesOf,
  windowOf,
} from "./quests.ts"
import { ulids } from "./random.ts"
import { boughtToday, buysXp, isFood, isXpFood, listPrice, offerParts, waresOf } from "./shop.ts"
import { addScores, bandPct, commandKey, contextThresholds, gradeOf, measureContext, statsOf } from "./stats.ts"
import { streakAsOf } from "./streak.ts"

// This version covers the proof of concept: reported XP with daily caps, XP for graded prompts (times the equipped
// sigil), levels, the streak, a loot roll per turn, per graded prompt (better odds for a better grade) and per
// level-up, the player stats, the daily and weekly missions (parallel ones from the sessions the server says are open)
// and their XP boosts, hatching the pet and caring for it (food and pats), equipping items, the shop, trading
// duplicates in (a re-roll for gold, or shards that craft a chosen item), and the first-run welcome's choices (the
// character's name, the egg's species and name, and the welcome done). Verified-tier facts wait for the verifier, and
// other commands are refused for now.

/** What one step builds up. It lives only inside `step`, so the function stays pure. */
interface Run {
  state: PlayerState
  readonly context: Context
  readonly events: Array<ServerEventDraft>
  readonly rolls: Array<RollRecord>
  readonly newId: () => string
  /** A dev command's run: what it makes is marked `dev`. */
  readonly isDev: boolean
}

/**
 * System inputs that are bookkeeping, not play: a migration wrote them into the log, and a replay of one must do just
 * what the migration did, so it rolls no window. XP a curve change carried is one.
 */
const bookkeeping: ReadonlyArray<SystemEvent["type"]> = ["xp.carried"]

const isBookkeeping = (input: Input): boolean => input.kind === "system" && bookkeeping.includes(input.event.type)

/**
 * Every step first rolls the missions of a local day or week begun since the last roll, then applies its input. A
 * refused command changes nothing, the roll included: the next step rolls instead. Bookkeeping rolls nothing.
 */
export const step = (state: PlayerState, input: Input, context: Context): Step => {
  const rolled = isBookkeeping(input) ? { state, events: [] } : rollQuests(state, context)
  const result = dispatch(rolled.state, input, context)
  if (result.refusal !== null) return refuse(state, result.refusal)
  return rolled.events.length === 0 ? result : { ...result, events: [...rolled.events, ...result.events] }
}

const dispatch = (state: PlayerState, input: Input, context: Context): Step => {
  switch (input.kind) {
    case "client":
      return applyClient(state, input.event, context)
    case "command":
      return applyCommand(state, input.command, context)
    case "system":
      return applySystem(state, input.event, context)
  }
}

/**
 * The missions of each window begun since they were last rolled, or of both windows again when `salt` re-rolls them
 * (a dev command): the old window's missions go, and the new set is offered. Grants recorded for windows now over
 * are dropped, as a mission completes once per window.
 */
const rollQuests = (
  state: PlayerState,
  context: Context,
  salt?: string,
): { readonly state: PlayerState; readonly events: ReadonlyArray<ServerEventDraft> } => {
  const { rules, now } = context
  const today = localDay(now, state.timezone)
  let quests = state.progress.quests
  const windows = { ...state.progress.questWindows }
  const events: Array<ServerEventDraft> = []
  let rolled = false
  for (const cadence of missionCadences) {
    const window = windowOf(cadence, today)
    if (salt === undefined && !isNewWindow(windows[cadence], window)) continue
    rolled = true
    const had = quests.some((mission) => mission.cadence === cadence)
    const count = cadence === "daily" ? rules.missions.daily.count : rules.missions.weekly.offered
    const offered = offerFor(context, cadence, window, count, state.timezone, salt)
    quests = [...quests.filter((mission) => mission.cadence !== cadence), ...offered]
    windows[cadence] = window
    if (offered.length > 0 || had) {
      const states = questStatesOf(context.questPacks, offered, state.timezone, now)
      events.push({ type: "quest.offered", data: { cadence, quests: states } })
    }
  }
  if (!rolled) return { state, events }
  const current = new Set([windows.daily, windows.weekly])
  const completedQuests = state.holdings.completedQuests.filter((done) => current.has(done.window))
  return {
    state: {
      ...state,
      progress: { ...state.progress, quests, questWindows: windows },
      holdings: { ...state.holdings, completedQuests },
    },
    events,
  }
}

const begin = (state: PlayerState, context: Context, isDev = false): Run => ({
  state,
  context,
  events: [],
  rolls: [],
  newId: ulids(context.rollSeed, context.logSeq, context.now),
  isDev,
})

const finish = (run: Run): Step => ({ state: run.state, rolls: run.rolls, refusal: null, events: run.events, claims: [] })

const refuse = (state: PlayerState, refusal: CommandRefusal): Step => ({
  state,
  rolls: [],
  refusal,
  events: [],
  claims: [],
})

const setProgress = (run: Run, progress: Partial<Progress>): void => {
  run.state = { ...run.state, progress: { ...run.state.progress, ...progress } }
}

const setHoldings = (run: Run, holdings: Partial<PlayerState["holdings"]>): void => {
  run.state = { ...run.state, holdings: { ...run.state.holdings, ...holdings } }
}

const applyClient = (state: PlayerState, event: ClientEvent, context: Context): Step => {
  const run = begin(state, context)
  // The edge allows event times up to 5 minutes ahead, which can cross local midnight: never count a day not begun.
  const today = localDay(context.now, state.timezone)
  const eventDay = localDay(event.occurredAt, state.timezone)
  const day = eventDay > today ? today : eventDay
  // Stats earn no XP, so they don't start the day's streak either.
  if (!isStat(event)) markActive(run, day)
  switch (event.type) {
    case "turn.completed":
      roll(run, "turn", context.rules.loot.chancePerTurn)
      break
    case "prompt.graded":
      joinQuests(run, event.sessionId, event.occurredAt, gradePrompt(run, event.data.scores, day), day)
      break
    case "session.cleared":
      setStats(run, { clears: run.state.progress.stats.clears + 1 })
      statsChanged(run, (stats) => ({ clears: stats.clears }))
      advance(run, { kind: "clears" }, day)
      break
    case "session.compacted": {
      const compactions = run.state.progress.stats.compactions
      setStats(run, { compactions: { ...compactions, [event.data.trigger]: compactions[event.data.trigger] + 1 } })
      statsChanged(run, (stats) => ({ compactions: stats.compactions }))
      advance(run, { kind: "compactions", trigger: event.data.trigger }, day)
      break
    }
    case "command.used": {
      const commands = run.state.progress.stats.commands
      const name = commandKey(commands, event.data.command)
      setStats(run, { commands: { ...commands, [name]: (commands[name] ?? 0) + 1 } })
      statsChanged(run, (stats) => ({ commands: stats.commands }))
      advance(run, { kind: "command", command: event.data.command }, day)
      break
    }
    case "context.measured": {
      const before = statsOf(run.state, context.now)
      setStats(run, { context: measureContext(run.state.progress.stats.context, event.sessionId, event.data.pct) })
      const after = statsOf(run.state, context.now)
      const crossed = contextThresholds.some(([key]) => after.contextCrossed[key] !== before.contextCrossed[key])
      const peak =
        after.contextPeak.lastSession !== before.contextPeak.lastSession ||
        after.contextPeak.average !== before.contextPeak.average
      if (crossed || peak) {
        statsChanged(run, (stats) => ({
          ...(crossed ? { contextCrossed: stats.contextCrossed } : {}),
          ...(peak ? { contextPeak: stats.contextPeak } : {}),
        }))
      }
      measureQuests(run, event.sessionId, event.data.pct, day)
      break
    }
    case "commit.made":
    case "change.opened":
    case "change.merged":
    case "issue.closed":
    case "repo.explored":
      grant(run, event.type, day)
      break
    case "review.submitted":
      // Credit lands when the author acts on the review, which only the verifier can see.
      break
    case "tests.failed":
      arm(run, { sessionId: event.sessionId, checkout: event.data.checkout })
      break
    case "tests.passed":
      if (disarm(run, { sessionId: event.sessionId, checkout: event.data.checkout })) grant(run, "tests.green", day)
      break
  }
  prune(run)
  return finish(run)
}

const statEvents: ReadonlyArray<ClientEvent["type"]> = [
  "session.cleared",
  "session.compacted",
  "command.used",
  "context.measured",
]
const isStat = (event: ClientEvent): boolean => statEvents.includes(event.type)

const setStats = (run: Run, stats: Partial<StatCounters>): void => {
  setProgress(run, { stats: { ...run.state.progress.stats, ...stats } })
}

/** A quiet update of the stats the event changed, as `pick` takes them from the stats as they now stand. */
const statsChanged = (run: Run, pick: (stats: PlayerStats) => Partial<PlayerStats>): void => {
  run.events.push({ type: "stats.changed", data: { stats: pick(statsOf(run.state, run.context.now)) } })
}

/**
 * A graded prompt: XP from its weighted quality grade, tapered by how many the day has seen already, times the sigil
 * equipped now, a loot roll whose chance rises with the grade (a great grade also raises the rare-and-better weights),
 * and the prompt stats. The grade is priced whatever rubric version made it, and the sigil at the multiplier the
 * catalogue in force gives it; the grade is returned, for the parallel missions.
 */
const gradePrompt = (run: Run, scores: Readonly<Record<GradeDimension, number>>, day: string): number => {
  const { rules } = run.context
  const grade = gradeOf(rules.prompt, scores)
  const nth = (run.state.progress.tallies.find((t) => t.day === day)?.counts["prompt.graded"] ?? 0) + 1
  const sigil = equippedSigil(run.state, run.context)
  // maxXp * grade / 10 * pct / 100 * sigil, to the thousandth so float error never costs a point; the flat boosts and
  // the one rounding down come in `grant`.
  const xp = Math.round(rules.prompt.maxXp * grade * bandPct(rules.prompt, nth) * sigil) / 1000
  grant(run, "prompt.graded", day, { xp, prompt: { scores, grade }, ...(sigil > 1 ? { sigil } : {}) })
  const prompts = run.state.progress.stats.prompts
  setStats(run, {
    prompts: {
      graded: prompts.graded + 1,
      scoreSum: prompts.scoreSum + grade,
      regretted: prompts.regretted + (scores.regret >= rules.prompt.regretAt ? 1 : 0),
      best: Math.max(prompts.best, grade),
      dimensions: addScores(prompts.dimensions, scores),
    },
  })
  const { loot } = rules
  const weights = grade >= loot.promptGreatAt ? raiseRare(loot.weights, loot.promptGreatRareFactor) : loot.weights
  roll(run, "prompt", (loot.promptChanceAtTen * grade) / 10, { weights })
  statsChanged(run, (stats) => ({ prompts: stats.prompts, grades: stats.grades }))
  return grade
}

const applyCommand = (state: PlayerState, command: Command, context: Context): Step => {
  if (context.mode.kind === "replay" && context.mode.recorded.refusal !== null) {
    return refuse(state, context.mode.recorded.refusal)
  }
  switch (command.type) {
    case "pet.hatch":
      return hatch(state, command.data, context)
    case "item.equip":
      return equip(state, command.data, context)
    case "item.unequip":
      return unequip(state, command.data.slot, context)
    case "quest.accept":
      return accept(state, command.data.questId, context)
    case "quest.abandon":
      return abandon(state, command.data.questId, context)
    case "pet.pet":
      return pat(state, context)
    case "pet.feed":
      return feed(state, command.data.entryId, context)
    case "shop.buy":
      return buy(state, command.data.offerId, context)
    case "item.reroll":
      return reroll(state, command.data.entryId, context)
    case "item.salvage":
      return salvage(state, command.data.entryId, context)
    case "shards.craft":
      return craft(state, command.data, context)
    case "character.rename":
      return rename(state, command.data.name, context)
    case "egg.choose":
      return chooseEgg(state, command.data, context)
    case "welcome.done":
      return welcomed(state, context)
    case "dev.grantItem":
    case "dev.grantStyles":
    case "dev.grantXp":
    case "dev.setGold":
    case "dev.completeQuest":
    case "dev.rollQuests":
    case "dev.fakeSession":
    case "dev.restockShop":
    case "dev.setMood":
    case "dev.setShards":
      return context.dev === true
        ? runDev(state, command, context)
        : refuse(state, { code: "not_allowed", message: "Dev commands run only on a local server in dev mode" })
    default:
      return refuse(state, { code: "not_allowed", message: "Not available in this version yet" })
  }
}

const applySystem = (state: PlayerState, event: SystemEvent, context: Context): Step => {
  const run = begin(state, context)
  const { now } = context
  const presence = state.progress.presence
  switch (event.type) {
    case "timezone.changed":
      // The edge checks the zone is one Intl knows before it reaches the log.
      run.state = { ...run.state, timezone: event.tz }
      break
    case "session.opened":
      setProgress(run, { presence: prunePresence(openSpan(presence, event.sessionId, now), now) })
      break
    case "session.closed":
      setProgress(run, { presence: prunePresence(closeSpan(presence, event.sessionId, event.at, now), now) })
      break
    case "xp.carried": {
      // Carried so the level stays where it was: no banner and no drop, as the migration that wrote it gave none. A
      // replay under the steeper curve reached a lower level before the carry, so the carry catches the milestones up
      // to the level it brings back, quietly, as the saved state already had them.
      const xp = run.state.progress.xp
      setProgress(run, { xp: { ...xp, reported: xp.reported + event.amount } })
      reach(run, levelOf(run.state, context.rules).level)
      break
    }
    case "fact.verified":
    case "claim.resolved":
    case "rules.published":
    case "quests.refresh":
      break
  }
  return finish(run)
}

/**
 * The flat XP boosts in percent: a happy pet's, plus the strongest running boost of each kind (food, a mission's),
 * as boosts of one kind never stack.
 */
const bonusPct = (run: Run): number => {
  const { rules, now } = run.context
  const pet = run.state.holdings.pet
  const happy = pet !== null && moodNow(pet, rules, now) > rules.pet.happyAbove ? rules.pet.happyXpBonusPct : 0
  const running = run.state.progress.boosts.filter((boost) => isLater(boost.endsAt, now))
  const strongest = (kind: Boost["kind"]): number =>
    Math.max(0, ...running.filter((boost) => boost.kind === kind).map((boost) => boost.xpBoostPct))
  return happy + strongest("food") + strongest("quest")
}

/** A graded prompt's rule: the `prompt` section sets its XP, and the day's bands, not a cap, taper it. */
const promptRule: XpRule = { xp: 0, tier: "reported", dailyCap: null }

/**
 * Counts one scoring fact and grants its XP, unless the day's cap is reached, and counts it toward the missions whose
 * goal it meets, capped or not. `xp` overrides the rule's amount (to the thousandth); the flat boosts multiply it,
 * and the sum is rounded down once. A graded prompt's grade and sigil ride on the grant, so the mod can say what
 * earned it, and its scores reach the missions that filter on them.
 */
const grant = (
  run: Run,
  fact: ScoringFact,
  day: string,
  options: { readonly xp?: number; readonly prompt?: PromptSignal; readonly sigil?: number } = {},
): void => {
  const { rules } = run.context
  const rule = fact === "prompt.graded" ? promptRule : rules.xp[fact]
  // Verified-tier facts are granted when the verifier confirms them; a hint alone earns nothing.
  if (rule.tier === "verified") return
  const progress = run.state.progress
  const totals = { ...progress.totals, [fact]: (progress.totals[fact] ?? 0) + 1 }
  const tally = progress.tallies.find((t) => t.day === day)
  const count = tally?.counts[fact] ?? 0
  const { prompt } = options
  const signal: QuestSignal = { kind: "fact", fact, ...(prompt === undefined ? {} : { prompt }) }
  if (rule.dailyCap !== null && count >= rule.dailyCap) {
    setProgress(run, { totals })
    run.events.push({ type: "xp.capped", data: { eventType: fact, cap: rule.dailyCap } })
    advance(run, signal, day)
    return
  }
  const counts = { ...tally?.counts, [fact]: count + 1 }
  const tallies = [...progress.tallies.filter((t) => t.day !== day), { day, counts }].sort((a, b) =>
    a.day < b.day ? -1 : 1,
  )
  // In whole thousandths of XP times whole percents, so the one rounding down is exact.
  const amount = Math.floor((Math.round((options.xp ?? rule.xp) * 1000) * (100 + bonusPct(run))) / 100_000)
  const before = levelOf(run.state, rules).level
  setProgress(run, { totals, tallies, xp: { ...progress.xp, reported: progress.xp.reported + amount } })
  if (amount > 0) {
    run.events.push({
      type: "xp.granted",
      data: {
        amount,
        tier: "reported",
        reason: fact,
        totalAfter: totalXp(run.state),
        ...(prompt === undefined ? {} : { grade: prompt.grade }),
        ...(options.sigil === undefined ? {} : { sigil: options.sigil }),
      },
    })
    levelUp(run, before)
  }
  advance(run, signal, day)
}

/**
 * A level above the highest one reached since the last prestige: the banner, a new title, maybe an evolution, and
 * one drop that always lands, by the level-up's own rarity weights. A jump of several levels at once drops once.
 */
const levelUp = (run: Run, before: number): void => {
  const { rules } = run.context
  const after = levelOf(run.state, rules).level
  const { peakLevel, pet } = run.state.holdings
  if (after <= peakLevel) return
  const title = titleFor(rules, after)
  const form = formFor(rules, after)
  const evolves = pet !== null && !pet.forms.includes(form)
  const titled = title !== titleFor(rules, before)
  run.events.push({
    type: "level.up",
    data: {
      from: before,
      to: after,
      // Staged like a rare drop; a new title or evolution makes it a bigger moment.
      tier: titled || evolves ? "epic" : "rare",
      glyph: glyphFor(rules, after),
      ...(titled ? { title } : {}),
      ...(evolves ? { evolution: form } : {}),
    },
  })
  reach(run, after)
  if (evolves) run.events.push({ type: "pet.changed", data: { form } })
  roll(run, "levelUp", 1, { weights: rules.loot.onLevelUp.weights })
}

/**
 * What reaching `level` keeps, with nothing to show for it: the peak level and the pet's forms. A level-up shows them;
 * carried XP only catches them up.
 */
const reach = (run: Run, level: number): void => {
  const { rules } = run.context
  const { peakLevel, pet } = run.state.holdings
  if (level <= peakLevel) return
  const form = formFor(rules, level)
  const evolves = pet !== null && !pet.forms.includes(form)
  // Forms unlocked early, by an evolution stone, stay unlocked.
  const forms = evolves ? [...new Set([...pet.forms, ...formsFor(rules, level)])].sort((a, b) => a - b) : []
  setHoldings(run, { peakLevel: level, pet: evolves ? { ...pet, forms, form } : pet })
}

/** The first event of a local day extends the streak and earns its XP. */
const markActive = (run: Run, day: string): void => {
  const { rules, now } = run.context
  const progress = run.state.progress
  if (progress.activeDays.includes(day)) return
  const activeDays = [...progress.activeDays, day].sort()
  setProgress(run, { activeDays })
  const today = localDay(now, run.state.timezone)
  const current = streakAsOf(activeDays, today, rules.streak.restDaysPerWeek)
  // A late event lands on its own day, where the streak may have been shorter.
  const reached = day === today ? current : streakAsOf(activeDays, day, rules.streak.restDaysPerWeek)
  // A late day can join two past runs into one that ends on a later active day, so each day from it on is measured.
  const joined = activeDays
    .filter((other) => other > day && other < today)
    .map((other) => streakAsOf(activeDays, other, rules.streak.restDaysPerWeek).days)
  setProgress(run, { bestStreak: Math.max(progress.bestStreak, current.days, reached.days, ...joined) })
  grant(run, "streak.day", day, { xp: Math.min(rules.streak.xpPerDay * reached.days, rules.streak.maxXp) })
  run.events.push({
    type: "streak.changed",
    data: { days: current.days, restDaysLeftThisWeek: current.restDaysLeftThisWeek },
  })
}

/** Puts `next` in place of the mission of the same quest, pack and cadence. */
const setMission = (run: Run, next: Mission): void => {
  const quests = run.state.progress.quests.map((mission) =>
    mission.questId === next.questId && mission.packId === next.packId && mission.cadence === next.cadence
      ? next
      : mission,
  )
  setProgress(run, { quests })
}

/** The running missions of the window `day` falls in, with their pack quests. */
const running = (run: Run, day: string): Array<{ readonly mission: Mission; readonly def: QuestDef }> =>
  run.state.progress.quests.flatMap((mission) => {
    if (mission.status !== "active" || mission.window !== windowOf(mission.cadence, day)) return []
    const def = defOf(run.context.questPacks, mission)
    return def === undefined ? [] : [{ mission, def }]
  })

/** A mission's new progress: its bar ticks, and reaching the goal completes it. */
const progressTo = (run: Run, mission: Mission, def: QuestDef): void => {
  setMission(run, mission)
  run.events.push({
    type: "quest.progress",
    data: { questId: mission.questId, progress: mission.progress, goal: def.goal.count },
  })
  if (mission.progress >= def.goal.count) complete(run, mission, def)
}

/** Counts something that happened on `day` toward every running mission of its window whose goal it meets. */
const advance = (run: Run, signal: QuestSignal, day: string): void => {
  for (const { mission, def } of running(run, day)) {
    if (meets(def.goal, signal)) progressTo(run, { ...mission, progress: mission.progress + 1 }, def)
  }
}

/** A context measurement on `day`, for the running context missions of its window. */
const measureQuests = (run: Run, sessionId: string, pct: number, day: string): void => {
  for (const { mission, def } of running(run, day)) {
    if (def.goal.kind !== "context") continue
    const measured = measureMission(mission, sessionId, pct, def.goal.under)
    if (measured.progress === mission.progress) setMission(run, measured)
    else progressTo(run, measured, def)
  }
}

/**
 * A graded prompt on `day`, for the running parallel missions of its window whose grade it reaches: it counts only if
 * its session was open as it was made, and makes a moment with the waiting prompts of other sessions open with it.
 */
const joinQuests = (run: Run, sessionId: string, at: string, grade: number, day: string): void => {
  const span = spanAt(run.state.progress.presence, sessionId, at)
  if (span === undefined) return
  const prompt = { sessionId, at, openedAt: span.openedAt }
  for (const { mission, def } of running(run, day)) {
    if (def.goal.kind !== "parallel" || grade < def.goal.grade) continue
    const joined = joinParallel(mission, def.goal, prompt, run.state.progress.presence)
    if (joined.moment) progressTo(run, { ...joined.mission, progress: mission.progress + 1 }, def)
    else setMission(run, joined.mission)
  }
}

/**
 * A mission done: the banner at its cadence's tier, then its rewards, each as its own event: reported XP (which may
 * level up, with that drop), gold, an XP boost from now on, and a drop that always lands. A mission already granted
 * in this window grants nothing again.
 */
const complete = (run: Run, mission: Mission, def: QuestDef): void => {
  const { rules, now } = run.context
  setMission(run, { ...mission, status: "completed", progress: Math.min(mission.progress, def.goal.count) })
  const holdings = run.state.holdings
  const granted = holdings.completedQuests.some(
    (done) => done.questId === mission.questId && done.packId === mission.packId && done.window === mission.window,
  )
  if (granted) return
  const done = { questId: mission.questId, packId: mission.packId, window: mission.window, completedAt: now }
  setHoldings(run, { completedQuests: [...holdings.completedQuests, done] })
  const { rewards } = def
  const tier = rules.missions[mission.cadence].tier
  run.events.push({ type: "quest.completed", data: { questId: def.id, title: def.title, tier, rewards } })
  const reason = run.isDev ? "dev" : "quest"
  if (rewards.xp !== undefined && rewards.xp > 0) {
    const before = levelOf(run.state, rules).level
    const xp = run.state.progress.xp
    setProgress(run, { xp: { ...xp, reported: xp.reported + rewards.xp } })
    run.events.push({
      type: "xp.granted",
      data: { amount: rewards.xp, tier: "reported", reason, totalAfter: totalXp(run.state) },
    })
    levelUp(run, before)
  }
  if (rewards.gold !== undefined && rewards.gold > 0) {
    const gold = run.state.holdings.gold + rewards.gold
    setHoldings(run, { gold })
    run.events.push({ type: "gold.changed", data: { delta: rewards.gold, totalAfter: gold, reason } })
  }
  if (rewards.xpBoost !== undefined) {
    const endsAt = new Date(Date.parse(now) + rewards.xpBoost.minutes * 60_000).toISOString()
    const boost: Boost = {
      kind: "quest",
      source: `${mission.packId}/${mission.questId}`,
      xpBoostPct: rewards.xpBoost.pct,
      endsAt,
    }
    setProgress(run, { boosts: [...run.state.progress.boosts, boost] })
  }
  if (rewards.loot !== undefined) rewardDrop(run, rewards.loot, `${mission.packId}/${mission.questId}`)
}

/**
 * A reward's drop: the item it names, or one from its pool (a category, else the whole catalogue) at its rarity,
 * falling to the nearest lower rarity with items. An item the catalogue lacks rolls from the pool instead, and a pool
 * with nothing at or below the rarity rolls from the whole catalogue, so the drop the banner promised lands. A quest
 * never hands out a sigil by name or by pool, as a pack could then give the best one every week: a sigil it names
 * rolls from its pool, and a sigil pool is the whole catalogue, where a sigil drops at the usual share.
 */
const rewardDrop = (run: Run, loot: QuestLoot, ref: string): void => {
  const { catalog } = run.context
  const named = catalog.find((def) => def.id === loot.item && !isSigil(def))
  const keep = named?.rarity ?? loot.rarity
  const pooled = loot.pool === undefined || loot.pool === "sigil" ? undefined : loot.pool
  const category = pooled === undefined ? catalog : catalog.filter((def) => def.category === pooled)
  const fits = category.some((def) => rarityRank(def.rarity) <= rarityRank(keep))
  const pool = named !== undefined ? [named] : fits ? category : catalog
  roll(run, "reward", 1, { keep, pool, source: { kind: "quest", ref } })
}

const weekliesRunning = (state: PlayerState): number =>
  state.progress.quests.filter((mission) => mission.cadence === "weekly" && mission.status === "active").length

/** The mission of the current windows with that quest id, a weekly first should a pack reuse an id. */
const findMission = (state: PlayerState, questId: string): Mission | undefined => {
  const found = state.progress.quests.filter((mission) => mission.questId === questId)
  return found.find((mission) => mission.cadence === "weekly") ?? found[0]
}

/**
 * Picks an offered weekly, up to the rules' number running at once. Dailies run on their own. A replay applies what
 * the live run accepted, even if the rules or packs have changed since.
 */
const accept = (state: PlayerState, questId: string, context: Context): Step => {
  const mission = findMission(state, questId)
  if (mission === undefined) return refuse(state, { code: "not_allowed", message: "That mission is not on offer" })
  if (mission.cadence === "daily") return refuse(state, { code: "not_allowed", message: "Dailies run on their own" })
  const def = defOf(context.questPacks, mission)
  if (context.mode.kind === "live") {
    if (mission.status !== "offered") {
      return refuse(state, { code: "not_allowed", message: "That mission is already taken" })
    }
    if (def === undefined) return refuse(state, { code: "not_allowed", message: "That mission is no longer offered" })
    const most = context.rules.missions.weekly.active
    if (weekliesRunning(state) >= most) {
      return refuse(state, { code: "not_allowed", message: `The quest log is full: ${most} weeklies run at once` })
    }
  }
  const run = begin(state, context)
  const accepted: Mission = { ...mission, status: "active" }
  setMission(run, accepted)
  if (def !== undefined) {
    const quest = questStateOf(accepted, def, state.timezone, context.now)
    run.events.push({ type: "quest.accepted", data: { quest } })
  }
  return finish(run)
}

/** Gives up a running weekly: back on offer, its progress gone, its place in the quest log free. */
const abandon = (state: PlayerState, questId: string, context: Context): Step => {
  const mission = findMission(state, questId)
  if (mission?.cadence === "daily") return refuse(state, { code: "not_allowed", message: "Dailies run on their own" })
  if (mission === undefined || mission.status !== "active") {
    return refuse(state, { code: "invalid", message: "That mission is not running" })
  }
  const run = begin(state, context)
  const offered: Mission = { ...mission, status: "offered", progress: 0, sessions: [], prompts: [] }
  setMission(run, offered)
  const def = defOf(context.questPacks, mission)
  if (def !== undefined) {
    const quest = questStateOf(offered, def, state.timezone, context.now)
    run.events.push({ type: "quest.abandoned", data: { quest } })
  }
  return finish(run)
}

const sameRun = (a: ArmedTestRun, b: ArmedTestRun): boolean =>
  a.sessionId === b.sessionId && (a.checkout?.repo ?? null) === (b.checkout?.repo ?? null)

/** At most this many failing runs wait for a green one. */
const maxArmed = 20

const arm = (run: Run, failed: ArmedTestRun): void => {
  const armed = run.state.progress.tests.armed.filter((other) => !sameRun(other, failed))
  setProgress(run, { tests: { armed: [...armed, failed].slice(-maxArmed) } })
}

/** True when a failing run in the same session and repo was waiting for this green one. */
const disarm = (run: Run, passed: ArmedTestRun): boolean => {
  const armed = run.state.progress.tests.armed
  const left = armed.filter((other) => !sameRun(other, passed))
  setProgress(run, { tests: { armed: left } })
  return left.length < armed.length
}

/** How a roll differs from a turn's: its own rarity weights, or a reward's rarity, item pool and where it came from. */
interface RollOptions {
  readonly weights?: RarityWeights
  /** A reward's rarity: the pity timers never raise it, though the drop moves them as any drop does. */
  readonly keep?: Rarity
  /** The items it draws from; the whole catalogue when absent. */
  readonly pool?: ReadonlyArray<ItemDef>
  readonly source?: InventoryEntry["source"]
  /**
   * A trade, a duplicate re-rolled: it brings no gold and leaves the pity timers be, as paying to re-roll must never
   * buy a better next drop, and the caller announces what it made rather than a drop.
   */
  readonly trade?: boolean
}

/** What a roll put in the inventory, with its definition when the catalogue has one. */
interface Rolled {
  readonly entry: InventoryEntry
  readonly item: ItemDef | undefined
}

/**
 * Rolls loot, by the trigger's own odds if it has them, or in a replay applies the roll the log recorded. Returns
 * what it put in the inventory, if anything.
 */
const roll = (run: Run, trigger: RollRecord["trigger"], chance: number, options: RollOptions = {}): Rolled | null => {
  const { context } = run
  const { rules, catalog } = context
  const loot = run.state.holdings.loot
  let record: RollRecord
  if (context.mode.kind === "replay") {
    const recorded = context.mode.recorded.rolls[run.rolls.length]
    // The rules may now roll where the live run didn't; only the recorded rolls replay.
    if (recorded === undefined) return null
    record = recorded
  } else {
    const pool = options.pool ?? catalog
    const { weights, keep } = options
    const drop = rollLoot(context.rollSeed, loot.nextRoll, chance, rules, pool, loot.pity, weights, keep)
    record = {
      number: loot.nextRoll,
      trigger,
      chance,
      pityBefore: loot.pity,
      rulesVersion: rules.version,
      drop:
        drop === null
          ? null
          : {
              rarity: drop.rarity,
              itemId: drop.item.id,
              gold: options.trade === true ? 0 : drop.gold,
              entryId: run.newId(),
            },
    }
  }
  run.rolls.push(record)
  const nextRoll = Math.max(loot.nextRoll, record.number + 1)
  if (record.drop === null) {
    setHoldings(run, { loot: { ...loot, nextRoll } })
    return null
  }
  const { drop } = record
  const pity = options.trade === true ? loot.pity : pityAfter(loot.pity, drop.rarity)
  const entry: InventoryEntry = {
    id: drop.entryId,
    itemId: drop.itemId,
    acquiredAt: context.now,
    source: run.isDev
      ? { kind: "dev", ref: String(record.number) }
      : (options.source ?? { kind: "drop", ref: String(record.number) }),
    dye: null,
  }
  const gold = run.state.holdings.gold + drop.gold
  setHoldings(run, { inventory: [...run.state.holdings.inventory, entry], gold, loot: { nextRoll, pity } })
  const item = catalog.find((def) => def.id === drop.itemId)
  // An item a later catalogue removed is still owned; it just has no definition to show.
  if (item !== undefined && options.trade !== true) {
    run.events.push({ type: "loot.dropped", data: { entry, item, gold: drop.gold, pity, tier: drop.rarity } })
  }
  if (drop.gold > 0) {
    const reason = run.isDev ? "dev" : "drop"
    run.events.push({ type: "gold.changed", data: { delta: drop.gold, totalAfter: gold, reason } })
  }
  return { entry, item }
}

/**
 * Keeps the tallies to the last 7 days, the active days to the current streak (never fewer than 7 days), and the
 * boosts to those still running.
 */
const prune = (run: Run): void => {
  const { rules, now } = run.context
  const progress = run.state.progress
  const today = localDay(now, run.state.timezone)
  const weekAgo = addDays(today, -7)
  const start = streakAsOf(progress.activeDays, today, rules.streak.restDaysPerWeek).start ?? today
  const keepFrom = start < weekAgo ? start : weekAgo
  setProgress(run, {
    tallies: progress.tallies.filter((t) => t.day >= weekAgo),
    activeDays: progress.activeDays.filter((day) => day >= keepFrom),
    boosts: progress.boosts.filter((boost) => isLater(boost.endsAt, now)),
  })
}

/**
 * The egg hatches at level 1: as the species and name the player picked for it in the welcome, else as the command
 * names them (an older mod sends the fox Ember), which must be a species of the rules' and a name the engine keeps. A
 * replay applies what the live run accepted, even if a rebalance has since moved the level below 1.
 */
const hatch = (state: PlayerState, data: { species: string; name: string }, context: Context): Step => {
  const { rules, now } = context
  if (state.holdings.pet !== null) return refuse(state, { code: "not_allowed", message: "The pet has hatched" })
  const picked = state.holdings.egg
  if (context.mode.kind === "live") {
    if (levelOf(state, rules).level < 1) {
      return refuse(state, { code: "not_allowed", message: "The egg hatches at level 1" })
    }
    const refusal = picked === null ? eggRefusal(data, rules) : null
    if (refusal !== null) return refuse(state, refusal)
  }
  const egg = picked ?? data
  const forms = formsFor(rules, state.holdings.peakLevel)
  const form = formFor(rules, state.holdings.peakLevel)
  const pet: OwnedPet = {
    species: egg.species,
    name: egg.name,
    hatchedAt: now,
    forms,
    form,
    mood: { value: 100, at: now },
    petted: [],
  }
  const run = begin({ ...state, holdings: { ...state.holdings, pet, egg: null } }, context)
  run.events.push({ type: "pet.hatched", data: { species: pet.species, name: pet.name, form, mood: 100, equipped: {} } })
  return finish(run)
}

/** Why an egg can't be: a species the rules don't have, or a name the engine doesn't keep. */
const eggRefusal = (egg: { species: string; name: string }, rules: Context["rules"]): CommandRefusal | null => {
  const species = rules.pet.species
  if (!species.some((one) => one.id === egg.species)) {
    const names = species.map((one) => one.name).join(", ")
    return { code: "invalid", message: `No egg hatches as a ${egg.species}: pick one of ${names}` }
  }
  const issue = nameIssue(egg.name, "your egg")
  return issue === null ? null : { code: "invalid", message: issue }
}

/** The character's name, tidied, as the band and the pane show it. */
const rename = (state: PlayerState, typed: string, context: Context): Step => {
  const name = tidyName(typed)
  if (context.mode.kind === "live") {
    const issue = nameIssue(name, "your character")
    if (issue !== null) return refuse(state, { code: "invalid", message: issue })
  }
  const run = begin({ ...state, characterName: name }, context)
  run.events.push({ type: "character.renamed", data: { name } })
  return finish(run)
}

/**
 * The egg picked in the welcome: a species of the rules' and a tidied name, which it hatches as. Once it has hatched
 * the pet keeps both, so the pick is refused. A replay applies what the live run accepted.
 */
const chooseEgg = (state: PlayerState, data: { species: string; name: string }, context: Context): Step => {
  const pet = state.holdings.pet
  if (pet !== null) {
    return refuse(state, { code: "not_allowed", message: `${pet.name} has hatched, and keeps its species and name` })
  }
  const egg = { species: data.species, name: tidyName(data.name) }
  if (context.mode.kind === "live") {
    const refusal = eggRefusal(egg, context.rules)
    if (refusal !== null) return refuse(state, refusal)
  }
  const run = begin({ ...state, holdings: { ...state.holdings, egg } }, context)
  run.events.push({ type: "egg.chosen", data: egg })
  return finish(run)
}

/** The welcome finished or skipped: it never shows again on its own. Done again, it changes nothing. */
const welcomed = (state: PlayerState, context: Context): Step => {
  if (state.welcomedAt !== null) return finish(begin(state, context))
  const run = begin({ ...state, welcomedAt: context.now }, context)
  run.events.push({ type: "welcome.done", data: {} })
  return finish(run)
}

const isPetSlot = (slot: Slot): boolean => petSlots.some((pet) => pet === slot)

/**
 * An owned item into the one slot its definition names, replacing what was there; a pet slot needs the pet. A replay
 * applies what the live run accepted, even if a later catalogue moved or dropped the item.
 */
const equip = (state: PlayerState, data: { entryId: string; slot: Slot }, context: Context): Step => {
  const { holdings } = state
  const entry = holdings.inventory.find((owned) => owned.id === data.entryId)
  if (entry === undefined) return refuse(state, { code: "not_owned", message: "That item is not in the inventory" })
  if (context.mode.kind === "live") {
    const item = context.catalog.find((def) => def.id === entry.itemId)
    if (item === undefined) return refuse(state, { code: "invalid", message: "That item can no longer be equipped" })
    if (item.slot !== data.slot) return refuse(state, { code: "invalid", message: "Wrong slot for the item" })
    if (isPetSlot(data.slot) && holdings.pet === null) {
      return refuse(state, { code: "not_allowed", message: "The pet has not hatched" })
    }
  }
  const equipped = { ...holdings.equipped, [data.slot]: entry.id }
  const run = begin({ ...state, holdings: { ...holdings, equipped } }, context)
  run.events.push({ type: "item.equipped", data: { slot: data.slot, entryId: entry.id } })
  return finish(run)
}

/** Empties a slot: a band slot goes back to the mod's own look. */
const unequip = (state: PlayerState, slot: Slot, context: Context): Step => {
  const { holdings } = state
  if (holdings.equipped[slot] === undefined) {
    return refuse(state, { code: "invalid", message: "Nothing is equipped there" })
  }
  const equipped = Object.fromEntries(Object.entries(holdings.equipped).filter(([key]) => key !== slot))
  const run = begin({ ...state, holdings: { ...holdings, equipped } }, context)
  run.events.push({ type: "item.unequipped", data: { slot } })
  return finish(run)
}

const notHatched: CommandRefusal = { code: "not_allowed", message: "The egg has not hatched yet" }

/** A pat lifts the pet's mood while the hour has pats left, and past them adds nothing; never refused once hatched. */
const pat = (state: PlayerState, context: Context): Step => {
  const { rules, now } = context
  const pet = state.holdings.pet
  if (pet === null) return refuse(state, notHatched)
  const run = begin(state, context)
  const { pet: next, gained } = patted(pet, rules, now)
  setHoldings(run, { pet: next })
  run.events.push({ type: "pet.petted", data: { mood: next.mood.value, gained } })
  return finish(run)
}

/** The entry gone from the inventory, and from any slot it was in. */
const spend = (run: Run, entryId: string): void => {
  const { inventory, equipped } = run.state.holdings
  setHoldings(run, {
    inventory: inventory.filter((entry) => entry.id !== entryId),
    equipped: Object.fromEntries(Object.entries(equipped).filter(([, id]) => id !== entryId)),
  })
}

/**
 * Food the pet eats: gone from the inventory, it lifts the pet's mood, and XP food (from play only) starts its XP
 * boost, a flat one of kind `food` (the strongest running food boost counts, so two never stack); a treat only lifts
 * the mood. A replay applies what the live run accepted, with the definition the catalogue now has.
 */
const feed = (state: PlayerState, entryId: string, context: Context): Step => {
  const { rules, now, catalog } = context
  const pet = state.holdings.pet
  if (pet === null) return refuse(state, notHatched)
  const entry = state.holdings.inventory.find((owned) => owned.id === entryId)
  if (entry === undefined) return refuse(state, { code: "not_owned", message: "That food is not in the inventory" })
  const item = catalog.find((def) => def.id === entry.itemId)
  if (context.mode.kind === "live" && item?.category !== "food") {
    return refuse(state, { code: "invalid", message: `${pet.name} eats only food` })
  }
  const run = begin(state, context)
  spend(run, entry.id)
  const next = lifted(pet, rules, now, rules.pet.care.fed)
  const gained = next.mood.value - moodNow(pet, rules, now)
  setHoldings(run, { pet: next })
  const effect = item?.effect ?? null
  const boost =
    effect !== null && effect.xpBoostPct > 0 && effect.minutes > 0
      ? { pct: effect.xpBoostPct, minutes: effect.minutes }
      : undefined
  if (boost !== undefined) {
    const endsAt = new Date(Date.parse(now) + boost.minutes * 60_000).toISOString()
    const running: Boost = { kind: "food", source: entry.itemId, xpBoostPct: boost.pct, endsAt }
    setProgress(run, { boosts: [...run.state.progress.boosts, running] })
  }
  run.events.push({
    type: "pet.fed",
    data: {
      entryId: entry.id,
      itemId: entry.itemId,
      name: item?.name ?? entry.itemId,
      mood: next.mood.value,
      gained,
      ...(boost === undefined ? {} : { xpBoost: boost }),
    },
  })
  return finish(run)
}

/**
 * One of today's offers, for its price: the item joins the inventory and the day counts the copy against the offer's
 * stock. An offer of a day gone by has ended. A replay applies what the live run accepted, at the price the rules now
 * give the item, and never takes the gold below none.
 */
const buy = (state: PlayerState, offerId: string, context: Context): Step => {
  const { rules, now, catalog } = context
  const { holdings } = state
  const today = localDay(now, state.timezone)
  const parts = offerParts(offerId)
  const ware = parts?.day === today ? waresOf(today, context).find((one) => one.item.id === parts.itemId) : undefined
  const bought = boughtToday(state, today, offerId)
  if (context.mode.kind === "live") {
    if (parts === undefined) return refuse(state, { code: "invalid", message: "No offer has that id" })
    if (parts.day !== today) {
      return refuse(state, { code: "sold_out", message: "That offer has ended: the shop restocks each day" })
    }
    // Gold never buys XP: a sigil or XP food is never on offer, whatever the id names.
    const named = catalog.find((def) => def.id === parts.itemId)
    if (named !== undefined && buysXp(named)) return refuse(state, xpFromPlay(named))
    if (ware === undefined) return refuse(state, { code: "invalid", message: "The shop has no such offer today" })
    if (bought >= ware.stock) {
      return refuse(state, { code: "sold_out", message: `${ware.item.name} is sold out for today` })
    }
    if (holdings.gold < ware.price) {
      const message = `${ware.item.name} costs ${ware.price} gold, and you have ${holdings.gold}`
      return refuse(state, { code: "insufficient_gold", message })
    }
  }
  const itemId = parts?.itemId ?? offerId
  const item = ware?.item ?? catalog.find((def) => def.id === itemId)
  const price = Math.min(holdings.gold, ware?.price ?? (item === undefined ? 0 : listPrice(rules, item)))
  const run = begin(state, context)
  const entry: InventoryEntry = {
    id: run.newId(),
    itemId,
    acquiredAt: now,
    source: { kind: "shop", ref: offerId },
    dye: null,
  }
  const sold = holdings.shop.day === today ? holdings.shop.bought : {}
  const gold = holdings.gold - price
  setHoldings(run, {
    inventory: [...holdings.inventory, entry],
    gold,
    shop: { day: today, bought: { ...sold, [offerId]: bought + 1 } },
  })
  if (item !== undefined) run.events.push({ type: "shop.bought", data: { offerId, entry, item, price } })
  if (price > 0) run.events.push({ type: "gold.changed", data: { delta: -price, totalAfter: gold, reason: "shop" } })
  return finish(run)
}

/**
 * The refusal for gold, a re-roll or shards asked for what would buy XP: a sigil or XP food, which come only from play,
 * as drops and mission rewards.
 */
const xpFromPlay = (item: ItemDef): CommandRefusal => ({
  code: "not_allowed",
  message: isXpFood(item)
    ? `${item.name} boosts XP, so it comes only from play, never from gold or shards`
    : `${item.name} is a sigil, which comes only from play, never from gold or shards`,
})

/** Whether the inventory holds another copy of the entry's item, so it is a duplicate to trade in. */
const isDuplicate = (state: PlayerState, entry: InventoryEntry): boolean =>
  state.holdings.inventory.some((other) => other.id !== entry.id && other.itemId === entry.itemId)

const isWorn = (state: PlayerState, entryId: string): boolean =>
  Object.values(state.holdings.equipped).some((id) => id === entryId)

/**
 * Why a duplicate can't be traded in, live: an item gone from the catalogue, food (the shop sells it by the copy, so a
 * spare meal would turn gold into a re-roll or shards on the cheap), the only copy, or the copy worn.
 */
const tradeRefusal = (state: PlayerState, entry: InventoryEntry, item: ItemDef | undefined): CommandRefusal | null => {
  if (item === undefined) return { code: "invalid", message: "That item is no longer in the catalogue" }
  if (isFood(item)) return { code: "not_allowed", message: `${item.name} is food: feed it to your pet` }
  if (!isDuplicate(state, entry)) {
    return { code: "not_allowed", message: `Only a duplicate can be traded in, and you have one ${item.name}` }
  }
  if (isWorn(state, entry.id)) return { code: "not_allowed", message: "That copy is worn: trade in a spare one" }
  return null
}

/**
 * A duplicate and gold for a random other item of its rarity, never a sigil, so gold never buys XP. The re-roll is a
 * roll of its own, recorded for replay, but a trade: it brings no gold and leaves the pity timers be.
 */
const reroll = (state: PlayerState, entryId: string, context: Context): Step => {
  const { rules, catalog } = context
  const { holdings } = state
  const entry = holdings.inventory.find((owned) => owned.id === entryId)
  if (entry === undefined) return refuse(state, { code: "not_owned", message: "That item is not in the inventory" })
  const item = catalog.find((def) => def.id === entry.itemId)
  // Never a sigil or XP food, so gold never buys XP, and never a treat, which the re-roll would cost more than: a look
  // for a look.
  const pool = catalog.filter(
    (def) => def.rarity === item?.rarity && !buysXp(def) && !isFood(def) && def.id !== entry.itemId,
  )
  if (context.mode.kind === "live") {
    const refusal = tradeRefusal(state, entry, item)
    if (refusal !== null) return refuse(state, refusal)
    if (item === undefined || pool.length === 0) {
      return refuse(state, { code: "not_allowed", message: "Nothing else of its rarity to re-roll it into" })
    }
    const cost = rules.loot.rerollGold[item.rarity]
    if (holdings.gold < cost) {
      const message = `A ${item.rarity} re-roll costs ${cost} gold, and you have ${holdings.gold}`
      return refuse(state, { code: "insufficient_gold", message })
    }
  }
  const price = item === undefined ? 0 : Math.min(holdings.gold, rules.loot.rerollGold[item.rarity])
  const run = begin(state, context)
  spend(run, entry.id)
  const gold = run.state.holdings.gold - price
  setHoldings(run, { gold })
  const rolled = roll(run, "reroll", 1, {
    keep: item?.rarity ?? "common",
    pool,
    trade: true,
    source: { kind: "craft", ref: `reroll/${entry.id}` },
  })
  if (rolled?.item !== undefined) {
    const from = { entryId: entry.id, itemId: entry.itemId, name: item?.name ?? entry.itemId }
    const data = { from, entry: rolled.entry, item: rolled.item, price, tier: rolled.item.rarity }
    run.events.push({ type: "item.rerolled", data })
  }
  if (price > 0) run.events.push({ type: "gold.changed", data: { delta: -price, totalAfter: gold, reason: "reroll" } })
  return finish(run)
}

/** A duplicate broken into shards of its rarity, as many as the rules give one. */
const salvage = (state: PlayerState, entryId: string, context: Context): Step => {
  const { rules, catalog } = context
  const entry = state.holdings.inventory.find((owned) => owned.id === entryId)
  if (entry === undefined) return refuse(state, { code: "not_owned", message: "That item is not in the inventory" })
  const item = catalog.find((def) => def.id === entry.itemId)
  if (context.mode.kind === "live") {
    const refusal = tradeRefusal(state, entry, item)
    if (refusal !== null) return refuse(state, refusal)
  }
  const run = begin(state, context)
  spend(run, entry.id)
  if (item !== undefined) {
    const shards = rules.loot.salvageShards[item.rarity]
    const totalAfter = run.state.holdings.shards[item.rarity] + shards
    setHoldings(run, { shards: { ...run.state.holdings.shards, [item.rarity]: totalAfter } })
    const data = { entryId: entry.id, itemId: item.id, name: item.name, rarity: item.rarity, shards, totalAfter }
    run.events.push({ type: "item.salvaged", data })
  }
  return finish(run)
}

/** Shards of a rarity made into a chosen item of it, anything but a sigil or XP food. */
const craft = (state: PlayerState, data: { rarity: Rarity; itemId: string }, context: Context): Step => {
  const { rules, catalog, now } = context
  const { rarity, itemId } = data
  const item = catalog.find((def) => def.id === itemId)
  const need = rules.loot.shardsToCraft
  const have = state.holdings.shards[rarity]
  if (context.mode.kind === "live") {
    if (item === undefined) return refuse(state, { code: "invalid", message: "No item in the catalogue has that id" })
    if (buysXp(item)) return refuse(state, xpFromPlay(item))
    if (item.rarity !== rarity) {
      return refuse(state, { code: "invalid", message: `${item.name} is ${item.rarity}, not ${rarity}` })
    }
    if (have < need) {
      const message = `Crafting takes ${need} ${rarity} shards, and you have ${have}`
      return refuse(state, { code: "insufficient_shards", message })
    }
  }
  const run = begin(state, context)
  const spent = Math.min(have, need)
  const totalAfter = have - spent
  const entry: InventoryEntry = {
    id: run.newId(),
    itemId,
    acquiredAt: now,
    source: { kind: "craft", ref: `shards/${rarity}` },
    dye: null,
  }
  setHoldings(run, {
    shards: { ...state.holdings.shards, [rarity]: totalAfter },
    inventory: [...state.holdings.inventory, entry],
  })
  if (item !== undefined) run.events.push({ type: "shards.crafted", data: { rarity, spent, totalAfter, entry, item } })
  return finish(run)
}

/** How long a dev command's stand-in session stays open. */
const fakeSessionMs = 30 * 60_000

/**
 * A dev command, which the caller has let through: an item or every band style not owned yet, XP that levels up as
 * play would (its drops marked `dev` too), or the gold set. It counts no scoring fact and moves no streak.
 */
const runDev = (state: PlayerState, command: DevCommand, context: Context): Step => {
  const run = begin(state, context, true)
  const { holdings } = state
  const give = (item: ItemDef): void => {
    const entry: InventoryEntry = {
      id: run.newId(),
      itemId: item.id,
      acquiredAt: context.now,
      source: { kind: "dev", ref: command.type },
      dye: null,
    }
    setHoldings(run, { inventory: [...run.state.holdings.inventory, entry] })
    const pity = run.state.holdings.loot.pity
    run.events.push({ type: "loot.dropped", data: { entry, item, gold: 0, pity, tier: item.rarity } })
  }
  switch (command.type) {
    case "dev.grantItem": {
      const item = context.catalog.find((def) => def.id === command.data.itemId)
      if (item === undefined) return refuse(state, { code: "invalid", message: "No item in the catalogue has that id" })
      give(item)
      break
    }
    case "dev.grantStyles": {
      const owned = new Set(holdings.inventory.map((entry) => entry.itemId))
      for (const item of context.catalog) if (item.category === "bandStyle" && !owned.has(item.id)) give(item)
      break
    }
    case "dev.grantXp": {
      const before = levelOf(state, context.rules).level
      const xp = state.progress.xp
      setProgress(run, { xp: { ...xp, reported: xp.reported + command.data.amount } })
      run.events.push({
        type: "xp.granted",
        data: { amount: command.data.amount, tier: "reported", reason: "dev", totalAfter: totalXp(run.state) },
      })
      levelUp(run, before)
      break
    }
    case "dev.setGold": {
      const delta = command.data.gold - holdings.gold
      setHoldings(run, { gold: command.data.gold })
      if (delta !== 0) {
        run.events.push({ type: "gold.changed", data: { delta, totalAfter: command.data.gold, reason: "dev" } })
      }
      break
    }
    case "dev.completeQuest": {
      // A running mission, or an offered weekly, which it takes first; its rewards are marked dev.
      const mission = findMission(state, command.data.questId)
      const def = mission === undefined ? undefined : defOf(context.questPacks, mission)
      if (mission === undefined || def === undefined || mission.status === "completed") {
        return refuse(state, { code: "invalid", message: "No mission on offer or running has that id" })
      }
      complete(run, { ...mission, status: "active", progress: def.goal.count }, def)
      break
    }
    case "dev.rollQuests": {
      const rolled = rollQuests(state, context, `:dev:${context.logSeq}`)
      run.state = rolled.state
      run.events.push(...rolled.events)
      break
    }
    case "dev.restockShop":
      setHoldings(run, { shop: { day: localDay(context.now, state.timezone), bought: {} } })
      break
    case "dev.setMood": {
      const pet = holdings.pet
      if (pet === null) return refuse(state, notHatched)
      setHoldings(run, { pet: { ...pet, mood: { value: command.data.mood, at: context.now } } })
      run.events.push({ type: "pet.changed", data: { mood: command.data.mood } })
      break
    }
    case "dev.setShards": {
      const { count } = command.data
      setHoldings(run, { shards: { common: count, uncommon: count, rare: count, epic: count, legendary: count } })
      break
    }
    case "dev.fakeSession": {
      // Open for a while from now, with a prompt graded 10 made as it opened.
      const sessionId = run.newId()
      const closedAt = new Date(Date.parse(context.now) + fakeSessionMs).toISOString()
      const span = { sessionId, openedAt: context.now, closedAt }
      setProgress(run, { presence: prunePresence([...state.progress.presence, span], context.now) })
      joinQuests(run, sessionId, context.now, 10, localDay(context.now, state.timezone))
      break
    }
  }
  return finish(run)
}
