import type { PlayerStats, RulesConfig, ScoringFact, ServerEvent, Snapshot } from '@questline/schema'
import type { PluginOptions } from 'claude-code'
import type { BandView, GainLine, OwnedItem, StatsView, Wardrobe } from '../types'
import { boostText, tierOf } from './celebrate'
import { knowsSigilsOf, multiplierText, sigilOf, wornSigil } from './sigils'

// What the band draws, worked out from the server's snapshot and stream; no game rule is computed here.

export const viewOf = (snapshot: Snapshot): BandView => ({
  name: snapshot.character.name,
  level: snapshot.character.level,
  title: snapshot.character.title,
  // An older server's snapshot names no glyph: the band's first one stands in.
  glyph: snapshot.character.glyph || '⚔',
  xp: {
    total: snapshot.character.xp.total,
    intoLevel: snapshot.character.xp.intoLevel,
    forNextLevel: snapshot.character.xp.forNextLevel,
  },
  gold: snapshot.character.gold,
  isDev: snapshot.dev === true,
  pet:
    snapshot.pet === null
      ? null
      : { species: snapshot.pet.species, name: snapshot.pet.name, form: snapshot.pet.form, mood: snapshot.pet.mood },
})

/**
 * What the player owns, by the definitions the snapshot carries, and what is equipped where; `rules`, the session's,
 * say whether the server deals in sigils.
 */
export const wardrobeOf = (snapshot: Snapshot, rules: Partial<RulesConfig> = {}): Wardrobe => {
  // An older server's snapshot carries no definitions: nothing it can't name is shown.
  const defs = Array.isArray(snapshot.items) ? snapshot.items : []
  const inventory = Array.isArray(snapshot.inventory) ? snapshot.inventory : []
  const byId = new Map(defs.map((def) => [def.id, def]))
  const items = inventory.flatMap((entry): Array<OwnedItem> => {
    const def = byId.get(entry.itemId)
    if (def === undefined) return []
    const { name, category, slot, lore } = def
    const look = def.look ?? null
    const sigil = sigilOf(def)
    const rarity = tierOf(def.rarity)
    const owned: OwnedItem = { entryId: entry.id, itemId: def.id, name, rarity, category, slot, look, lore }
    return [sigil === null ? owned : { ...owned, sigil }]
  })
  const equipped: Record<string, string> = {}
  const worn = [...Object.entries(snapshot.character.equipped ?? {}), ...Object.entries(snapshot.pet?.equipped ?? {})]
  for (const [slot, entryId] of worn)
    if (typeof entryId === 'string') equipped[slot] = entryId
  return { items, equipped, knowsSigils: knowsSigilsOf(rules) }
}

/** A count or a share as the snapshot has it; `fallback` for one an older server doesn't send. */
const numberOr = <A,>(value: unknown, fallback: A): number | A =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * The Stats tab's numbers. An older server counts fewer stats, or sends none: what it lacks reads as nothing yet,
 * and the best grade, the best streak and the profile, which the tab says it can't show, as null.
 */
export const statsViewOf = (
  snapshot: Snapshot,
  rules: Partial<RulesConfig> = {},
  wardrobe: Wardrobe = wardrobeOf(snapshot, rules),
): StatsView => {
  const stats: Partial<PlayerStats> = snapshot.stats ?? {}
  const prompts: Partial<PlayerStats['prompts']> = stats.prompts ?? {}
  const peak: Partial<PlayerStats['contextPeak']> = stats.contextPeak ?? {}
  const crossed: Partial<PlayerStats['contextCrossed']> = stats.contextCrossed ?? {}
  const compactions: Partial<PlayerStats['compactions']> = stats.compactions ?? {}
  const dimensions: Readonly<Record<string, unknown>> | null = stats.grades?.dimensions ?? null
  const streak: Partial<Snapshot['character']['streak']> = snapshot.character.streak ?? {}
  const xp: Partial<Snapshot['character']['xp']> = snapshot.character.xp ?? {}
  const commands = Object.entries(stats.commands ?? {})
    .map(([name, uses]) => ({ name, uses: numberOr(uses, 0) }))
    .filter((command) => command.uses > 0)
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
  return {
    streak: {
      days: numberOr(streak.days, 0),
      best: numberOr(streak.best, null),
      restDaysLeftThisWeek: numberOr(streak.restDaysLeftThisWeek, 0),
    },
    prompts: {
      graded: numberOr(prompts.graded, 0),
      today: numberOr(prompts.gradedToday, 0),
      average: numberOr(prompts.averageScore, 0),
      best: numberOr(stats.grades?.best, null),
      regretted: numberOr(prompts.regretted, 0),
    },
    profile:
      dimensions === null
        ? null
        : Object.entries(dimensions).map(([dimension, average]) => ({ dimension, average: numberOr(average, 0) })),
    context: {
      lastSession: numberOr(peak.lastSession, 0),
      average: numberOr(peak.average, 0),
      pct50: numberOr(crossed.pct50, 0),
      pct75: numberOr(crossed.pct75, 0),
      pct100: numberOr(crossed.pct100, 0),
    },
    clears: numberOr(stats.clears, 0),
    compactions: { manual: numberOr(compactions.manual, 0), auto: numberOr(compactions.auto, 0) },
    commands,
    xp: { verified: numberOr(xp.verified, 0), reported: numberOr(xp.reported, 0) },
    items: Array.isArray(snapshot.inventory) ? snapshot.inventory.length : 0,
    sigil: knowsSigilsOf(rules) ? sigilStatOf(wardrobe) : null,
  }
}

/**
 * The sigil worn, with its name and rarity, for the Stats tab: `worn` null when none is, or when the one worn is one
 * the snapshot can't name, which `isUnknown` says.
 */
const sigilStatOf = (wardrobe: Wardrobe): NonNullable<StatsView['sigil']> => {
  const worn = wornSigil(wardrobe)
  if (worn?.sigil !== undefined) return { worn: { ...worn.sigil, name: worn.name, rarity: worn.rarity } }
  return wardrobe.equipped['sigil'] === undefined ? { worn: null } : { worn: null, isUnknown: true }
}

/** The egg hatches once the character reaches level 1. */
export const canHatch = (view: BandView): boolean => view.pet === null && view.level >= 1

/** The XP bar as filled and empty cells. */
export const bar = (view: BandView, width: number): { filled: number; empty: number } => {
  const share = view.xp.forNextLevel === 0 ? 0 : view.xp.intoLevel / view.xp.forNextLevel
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return { filled, empty: width - filled }
}

// Placeholder sprites until the pixel art lands: one face per species, a little bigger per form.
const faces: Record<string, ReadonlyArray<string>> = {
  fox: ['ᓚᘏᗢ', 'ᓚᘏᗢ✧', '✧ᓚᘏᗢ✧', '✦ᓚᘏᗢ✦'],
  slime: ['(•ᴗ•)', '(•ᴗ•)✧', '✧(•ᴗ•)✧', '✦(•ᴗ•)✦'],
  robot: ['[o_o]', '[o_o]✧', '✧[o_o]✧', '✦[o_o]✦'],
  owl: ['{◉,◉}', '{◉,◉}✧', '✧{◉,◉}✧', '✦{◉,◉}✦'],
}

export const sprite = (pet: NonNullable<BandView['pet']>): string => {
  const forms = faces[pet.species] ?? faces['fox'] ?? ['?']
  return forms[Math.min(pet.form, forms.length - 1)] ?? '?'
}

export const hearts = (mood: number): string => (mood > 70 ? '♥♥♥' : mood > 40 ? '♥♥' : '♥')

/** What each XP reason the engine names means to a player; the type keeps a word for every scoring fact. */
const xpWords: Record<ScoringFact | 'quest' | 'dev', string> = {
  'prompt.graded': 'prompt graded',
  'streak.day': 'daily streak',
  'commit.made': 'commit',
  'change.opened': 'pull request opened',
  'change.merged': 'pull request merged',
  'review.acted_on': 'review acted on',
  'issue.closed': 'issue closed',
  'bug.fixed': 'bug fixed',
  'first.contribution': 'first contribution',
  'tests.green': 'tests back to green',
  'repo.explored': 'new repo explored',
  quest: 'mission reward',
  dev: 'dev grant',
}
const goldWords: Record<string, string> = { drop: 'loot', quest: 'mission reward', dev: 'dev grant' }
const xpReasons = new Map<string, string>(Object.entries(xpWords))
const goldReasons = new Map<string, string>(Object.entries(goldWords))

/** A reason this mod has no words for yet (a newer server's) reads as its code with the dots spaced out. */
const wordsFor = (words: ReadonlyMap<string, string>, reason: string): string =>
  words.get(reason) ?? reason.replace(/[._]+/g, ' ')

/** A grade as the player reads it: to one decimal, 4.7, or a whole 10. */
const gradeText = (grade: number): string => String(Math.round(grade * 10) / 10)

const signed = (amount: number): string => (amount < 0 ? `−${-amount}` : `+${amount}`)

/** What a sigil added to a grant, as ` · ×2 sigil`; nothing when none did. */
const sigilPart = (sigil: number | undefined): string =>
  typeof sigil === 'number' && sigil > 1 ? ` · ${multiplierText(sigil)} sigil` : ''

/** A dropped item by name, a sigil with its multiplier: `Arcane Sigil ×2`. */
const dropName = (item: Pick<OwnedItem, 'name'> & Parameters<typeof sigilOf>[0]): string => {
  const sigil = sigilOf(item)
  return sigil === null ? item.name : `${item.name} ${multiplierText(sigil.multiplier)}`
}

/** The line one server event puts at the end of the band, if any. */
export const gainOf = (event: ServerEvent): GainLine | null => {
  switch (event.type) {
    case 'xp.granted': {
      const { amount, reason, grade, sigil } = event.data
      // An older server names no grade on a prompt's grant, and none names a sigil when none was worn.
      const why =
        reason === 'prompt.graded' && grade !== undefined ? `prompt graded ${gradeText(grade)}` : wordsFor(xpReasons, reason)
      return { text: `+${amount} XP · ${why}${sigilPart(sigil)}`, tone: 'xp' }
    }
    case 'xp.capped':
      return { text: `${wordsFor(xpReasons, event.data.eventType)} · daily XP cap reached`, tone: 'quiet' }
    case 'level.up':
      return { text: `Level ${event.data.to}!`, tone: 'level' }
    case 'loot.dropped':
      return { text: `${dropName(event.data.item)} · ${event.data.item.rarity}`, tone: 'loot' }
    case 'gold.changed':
      if (event.data.delta === 0) return null
      return { text: `${signed(event.data.delta)} gold · ${wordsFor(goldReasons, event.data.reason)}`, tone: 'gold' }
    case 'pet.hatched':
      return { text: `${event.data.name} hatched!`, tone: 'loot' }
    case 'streak.changed':
      return event.data.days > 1 ? { text: `${event.data.days}-day streak`, tone: 'xp' } : null
    case 'quest.completed':
      return { text: `${event.data.title || 'Mission'} · mission complete`, tone: 'quest' }
    case 'quest.offered': {
      // A new day's dailies, or a new week's weeklies to pick from; an empty set only clears the old ones.
      const count = event.data.quests.length
      if (count === 0) return null
      const text =
        event.data.cadence === 'daily'
          ? `${count} new ${count === 1 ? 'daily' : 'dailies'} · /questline`
          : `${count} ${count === 1 ? 'weekly' : 'weeklies'} on offer · /questline`
      return { text, tone: 'quiet' }
    }
    default:
      return null
  }
}

/** The stream's events by what caused them, each cause where it first appears; an event with no cause stands alone. */
export const batchesOf = <E extends { cause: string | null }>(events: ReadonlyArray<E>): Array<Array<E>> => {
  const byCause = new Map<string, Array<E>>()
  const batches: Array<Array<E>> = []
  for (const event of events) {
    const batch = event.cause === null ? undefined : byCause.get(event.cause)
    if (batch !== undefined) {
      batch.push(event)
      continue
    }
    const fresh = [event]
    batches.push(fresh)
    if (event.cause !== null) byCause.set(event.cause, fresh)
  }
  return batches
}

const toneRank: Record<GainLine['tone'], number> = { level: 5, quest: 4, loot: 3, xp: 2, gold: 1, quiet: 0 }

/**
 * A batch's line names its biggest moment: a level-up, else a mission done, else a drop, else XP, else gold; the
 * latest among equals.
 */
export const batchGainOf = (events: ReadonlyArray<ServerEvent>): GainLine | null =>
  events.reduce<GainLine | null>((best, event) => {
    const gain = gainOf(event)
    return gain !== null && (best === null || toneRank[gain.tone] >= toneRank[best.tone]) ? gain : best
  }, null)

/** What a sigil did to a toast's XP: ` (×2 sigil)`, or ` (×2 sigil on the prompt)` beside XP it didn't touch. */
const sigilNote = (sigil: number, isAll: boolean): string =>
  sigil > 1 ? ` (${multiplierText(sigil)} sigil${isAll ? '' : ' on the prompt'})` : ''

/** Drops a toast names one by one; past them it counts the rest. */
const toastItems = 3

/**
 * One toast for everything one cause earned, as `Mission complete: Ship It · +259 XP · Level 2! · Knit Scarf (rare)
 * · +130 gold`; null when it earned nothing.
 */
export const toastOf = (events: ReadonlyArray<ServerEvent>): string | null => {
  let xp = 0
  let gold = 0
  let sigil = 0
  /** XP from grants a sigil multiplied: the prompt's, and not the streak or work beside it. */
  let multiplied = 0
  const levels: Array<string> = []
  const items: Array<string> = []
  const hatched: Array<string> = []
  const missions: Array<string> = []
  const boosts: Array<string> = []
  for (const event of events) {
    if (event.type === 'quest.completed') missions.push(`Mission complete: ${event.data.title || 'Mission'}`)
    const boost = event.type === 'quest.completed' ? event.data.rewards?.xpBoost : undefined
    if (boost !== undefined) boosts.push(boostText(boost))
    if (event.type === 'xp.granted') xp += event.data.amount
    if (event.type === 'xp.granted' && typeof event.data.sigil === 'number') {
      sigil = Math.max(sigil, event.data.sigil)
      multiplied += event.data.amount
    }
    if (event.type === 'gold.changed') gold += event.data.delta
    if (event.type === 'level.up') {
      const { to, title } = event.data
      levels.push(title === undefined ? `Level ${to}!` : `Level ${to}! New title: ${title}`)
    }
    if (event.type === 'loot.dropped') items.push(`${dropName(event.data.item)} (${event.data.item.rarity})`)
    if (event.type === 'pet.hatched') hatched.push(`🥚 ${event.data.name} hatched!`)
  }
  const more = items.length - toastItems
  const parts = [
    ...missions,
    // Grants run to the thousandth; their sum is rounded back, so float error never shows.
    ...(xp > 0 ? [`+${xp} XP${sigilNote(sigil, multiplied === xp)}`] : []),
    ...levels,
    ...items.slice(0, more > 0 ? toastItems - 1 : toastItems),
    ...(more > 0 ? [`${more + 1} more items`] : []),
    ...(gold !== 0 ? [`${signed(gold)} gold`] : []),
    ...boosts,
    ...hatched,
  ]
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The `toasts` option: a toast per reward batch unless the player turned them off. */
export const toastsOf = (options: PluginOptions): boolean => options['toasts'] !== false

/** How long a gain's line stays at the end of the band. */
export const fadeMs = 60_000
