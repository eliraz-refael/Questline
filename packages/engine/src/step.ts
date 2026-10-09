import type {
  ArmedTestRun,
  ClientEvent,
  Command,
  CommandRefusal,
  Context,
  Input,
  InventoryEntry,
  PlayerState,
  Progress,
  RollRecord,
  ScoringFact,
  ServerEventDraft,
  Step,
  SystemEvent,
} from "@questline/schema"
import { addDays, isLater, localDay } from "./days.ts"
import { formFor, formsFor, levelOf, moodNow, titleFor, totalXp } from "./derive.ts"
import { pityAfter, rollLoot } from "./loot.ts"
import { ulids } from "./random.ts"
import { streakAsOf } from "./streak.ts"

// This version covers the proof of concept: reported XP with daily caps, levels, the streak, a loot roll per turn
// and hatching the pet. Verified-tier facts wait for the verifier, and other commands are refused for now.

/** What one step builds up. It lives only inside `step`, so the function stays pure. */
interface Run {
  state: PlayerState
  readonly context: Context
  readonly events: Array<ServerEventDraft>
  readonly rolls: Array<RollRecord>
  readonly newId: () => string
}

export const step = (state: PlayerState, input: Input, context: Context): Step => {
  switch (input.kind) {
    case "client":
      return applyClient(state, input.event, context)
    case "command":
      return applyCommand(state, input.command, context)
    case "system":
      return applySystem(state, input.event, context)
  }
}

const begin = (state: PlayerState, context: Context): Run => ({
  state,
  context,
  events: [],
  rolls: [],
  newId: ulids(context.rollSeed, context.logSeq, context.now),
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
  markActive(run, day)
  switch (event.type) {
    case "turn.completed":
      roll(run, "turn", context.rules.loot.chancePerTurn)
      break
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

const applyCommand = (state: PlayerState, command: Command, context: Context): Step => {
  if (context.mode.kind === "replay" && context.mode.recorded.refusal !== null) {
    return refuse(state, context.mode.recorded.refusal)
  }
  switch (command.type) {
    case "pet.hatch":
      return hatch(state, command.data, context)
    default:
      return refuse(state, { code: "not_allowed", message: "Not available in this version yet" })
  }
}

const applySystem = (state: PlayerState, event: SystemEvent, context: Context): Step => {
  const run = begin(state, context)
  // The edge checks the zone is one Intl knows before it reaches the log.
  if (event.type === "timezone.changed") run.state = { ...run.state, timezone: event.tz }
  return finish(run)
}

/** XP bonus in percent: a happy pet's, plus the strongest running food boost (boosts never stack). */
const bonusPct = (run: Run): number => {
  const { rules, now } = run.context
  const pet = run.state.holdings.pet
  const happy = pet !== null && moodNow(pet, rules, now) > rules.pet.happyAbove ? rules.pet.happyXpBonusPct : 0
  const boosts = run.state.progress.boosts.filter((boost) => isLater(boost.endsAt, now)).map((boost) => boost.xpBoostPct)
  return happy + Math.max(0, ...boosts)
}

/** Counts one scoring fact and grants its XP, unless the day's cap is reached. `xp` overrides the rule's amount. */
const grant = (run: Run, fact: ScoringFact, day: string, xp?: number): void => {
  const { rules } = run.context
  const rule = rules.xp[fact]
  // Verified-tier facts are granted when the verifier confirms them; a hint alone earns nothing.
  if (rule.tier === "verified") return
  const progress = run.state.progress
  const totals = { ...progress.totals, [fact]: (progress.totals[fact] ?? 0) + 1 }
  const tally = progress.tallies.find((t) => t.day === day)
  const count = tally?.counts[fact] ?? 0
  if (rule.dailyCap !== null && count >= rule.dailyCap) {
    setProgress(run, { totals })
    run.events.push({ type: "xp.capped", data: { eventType: fact, cap: rule.dailyCap } })
    return
  }
  const counts = { ...tally?.counts, [fact]: count + 1 }
  const tallies = [...progress.tallies.filter((t) => t.day !== day), { day, counts }].sort((a, b) =>
    a.day < b.day ? -1 : 1,
  )
  const amount = Math.floor(((xp ?? rule.xp) * (100 + bonusPct(run))) / 100)
  const before = levelOf(run.state, rules).level
  setProgress(run, { totals, tallies, xp: { ...progress.xp, reported: progress.xp.reported + amount } })
  if (amount === 0) return
  run.events.push({
    type: "xp.granted",
    data: { amount, tier: "reported", reason: fact, totalAfter: totalXp(run.state) },
  })
  levelUp(run, before)
}

/** A level above the highest one reached since the last prestige: the banner, a new title, maybe an evolution. */
const levelUp = (run: Run, before: number): void => {
  const { rules } = run.context
  const after = levelOf(run.state, rules).level
  const { peakLevel, pet } = run.state.holdings
  if (after <= peakLevel) return
  const title = titleFor(rules, after)
  const form = formFor(rules, after)
  const evolves = pet !== null && !pet.forms.includes(form)
  run.events.push({
    type: "level.up",
    data: {
      from: before,
      to: after,
      ...(title !== titleFor(rules, before) ? { title } : {}),
      ...(evolves ? { evolution: form } : {}),
    },
  })
  // Forms unlocked early, by an evolution stone, stay unlocked.
  const forms = evolves ? [...new Set([...pet.forms, ...formsFor(rules, after)])].sort((a, b) => a - b) : []
  setHoldings(run, { peakLevel: after, pet: evolves ? { ...pet, forms, form } : pet })
  if (evolves) run.events.push({ type: "pet.changed", data: { form } })
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
  grant(run, "streak.day", day, Math.min(rules.streak.xpPerDay * reached.days, rules.streak.maxXp))
  run.events.push({
    type: "streak.changed",
    data: { days: current.days, restDaysLeftThisWeek: current.restDaysLeftThisWeek },
  })
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

/** Rolls loot, or in a replay applies the roll the log recorded. */
const roll = (run: Run, trigger: RollRecord["trigger"], chance: number): void => {
  const { context } = run
  const { rules, catalog } = context
  const loot = run.state.holdings.loot
  let record: RollRecord
  if (context.mode.kind === "replay") {
    const recorded = context.mode.recorded.rolls[run.rolls.length]
    // The rules may now roll where the live run didn't; only the recorded rolls replay.
    if (recorded === undefined) return
    record = recorded
  } else {
    const drop = rollLoot(context.rollSeed, loot.nextRoll, chance, rules, catalog, loot.pity)
    record = {
      number: loot.nextRoll,
      trigger,
      chance,
      pityBefore: loot.pity,
      rulesVersion: rules.version,
      drop: drop === null ? null : { rarity: drop.rarity, itemId: drop.item.id, gold: drop.gold, entryId: run.newId() },
    }
  }
  run.rolls.push(record)
  const nextRoll = Math.max(loot.nextRoll, record.number + 1)
  if (record.drop === null) {
    setHoldings(run, { loot: { ...loot, nextRoll } })
    return
  }
  const { drop } = record
  const pity = pityAfter(loot.pity, drop.rarity)
  const entry: InventoryEntry = {
    id: drop.entryId,
    itemId: drop.itemId,
    acquiredAt: context.now,
    source: { kind: "drop", ref: String(record.number) },
    dye: null,
  }
  const gold = run.state.holdings.gold + drop.gold
  setHoldings(run, { inventory: [...run.state.holdings.inventory, entry], gold, loot: { nextRoll, pity } })
  const item = catalog.find((def) => def.id === drop.itemId)
  // An item a later catalogue removed is still owned; it just has no definition to show.
  if (item !== undefined) run.events.push({ type: "loot.dropped", data: { entry, item, gold: drop.gold, pity } })
  if (drop.gold > 0) run.events.push({ type: "gold.changed", data: { delta: drop.gold, totalAfter: gold, reason: "drop" } })
}

/** Keeps the tallies to the last 7 days and the active days to the current streak (never fewer than 7 days). */
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
  })
}

const hatch = (state: PlayerState, data: { species: string; name: string }, context: Context): Step => {
  const { rules, now } = context
  if (state.holdings.pet !== null) return refuse(state, { code: "not_allowed", message: "The pet has hatched" })
  // A replay applies what the live run accepted, even if a rebalance has since moved the level below 1.
  if (context.mode.kind === "live" && levelOf(state, rules).level < 1) {
    return refuse(state, { code: "not_allowed", message: "The egg hatches at level 1" })
  }
  const forms = formsFor(rules, state.holdings.peakLevel)
  const form = formFor(rules, state.holdings.peakLevel)
  const pet = { species: data.species, name: data.name, hatchedAt: now, forms, form, mood: { value: 100, at: now } }
  const run = begin({ ...state, holdings: { ...state.holdings, pet } }, context)
  run.events.push({ type: "pet.hatched", data: { species: pet.species, name: pet.name, form, mood: 100, equipped: {} } })
  return finish(run)
}
