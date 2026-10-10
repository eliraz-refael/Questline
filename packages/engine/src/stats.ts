import type { GradeDimension, PlayerState, PlayerStats, PromptRules, QualityDimension, StatCounters } from "@questline/schema"
import { localDay } from "./days.ts"

// Graded prompts are priced from their scores; the player stats are counted from stats events and graded prompts,
// and earn no XP on their own.

const quality: ReadonlyArray<QualityDimension> = [
  "clarity",
  "grammar",
  "specificity",
  "instructive",
  "context",
  "doneCriteria",
  "focus",
]

/**
 * The weighted average of a grade's quality scores, 0-10; `regret` is left out, the stats count it. The rules hold
 * at least one weight above zero.
 */
export const gradeOf = (rules: PromptRules, scores: Readonly<Record<GradeDimension, number>>): number => {
  const total = quality.reduce((sum, dimension) => sum + rules.weights[dimension], 0)
  const weighted = quality.reduce((sum, dimension) => sum + rules.weights[dimension] * scores[dimension], 0)
  // To the thousandth, so float error in the weights never puts a grade past 10 or just under a threshold.
  return total === 0 ? 0 : Math.round((weighted / total) * 1000) / 1000
}

/** The share, in percent, the `nth` graded prompt of a local day earns; nothing past the last band. */
export const bandPct = (rules: PromptRules, nth: number): number =>
  rules.perDay.find((band) => band.upTo === null || nth <= band.upTo)?.pct ?? 0

/** The context fills a session can cross, under the names the stats give them. */
export const contextThresholds: ReadonlyArray<readonly [keyof PlayerStats["contextCrossed"], number]> = [
  ["pct50", 50],
  ["pct75", 75],
  ["pct100", 100],
]

/** Sessions whose peak a later measurement can still raise; one measured after falling out counts as new. */
export const maxRecentSessions = 20

/** Distinct command names counted; past this, a new name counts as `custom`. */
export const maxCommands = 100

/**
 * One context measurement folded in: the session moves to the end of the recent ones, its peak only rises, and
 * each fill it crosses counts once per session.
 */
export const measureContext = (
  context: StatCounters["context"],
  sessionId: string,
  pct: number,
): StatCounters["context"] => {
  const before = context.recent.find((session) => session.sessionId === sessionId)?.peak ?? null
  const peak = before === null ? pct : Math.max(before, pct)
  const crossed = { ...context.crossed }
  for (const [key, at] of contextThresholds) if (peak >= at && (before === null || before < at)) crossed[key] += 1
  const others = context.recent.filter((session) => session.sessionId !== sessionId)
  return {
    crossed,
    sessions: before === null ? context.sessions + 1 : context.sessions,
    peakSum: context.peakSum + peak - (before ?? 0),
    recent: [...others, { sessionId, peak }].slice(-maxRecentSessions),
  }
}

/** The command name to count a use under, keeping the record to `maxCommands` names, `custom` included. */
export const commandKey = (commands: StatCounters["commands"], command: string): string => {
  if (Object.hasOwn(commands, command)) return command
  // Leave room for `custom`, where the overflow goes.
  const room = maxCommands - (Object.hasOwn(commands, "custom") ? 0 : 1)
  return Object.keys(commands).length < room ? command : "custom"
}

/** An average to the thousandth: a sum of floats over a count would show its float error in the pane. */
const thousandth = (value: number): number => Math.round(value * 1000) / 1000

/** The stats the mod draws, as of `now`. */
export const statsOf = (state: PlayerState, now: string): PlayerStats => {
  const { stats, tallies } = state.progress
  const { context, prompts } = stats
  const today = localDay(now, state.timezone)
  return {
    clears: stats.clears,
    compactions: stats.compactions,
    commands: stats.commands,
    contextCrossed: context.crossed,
    contextPeak: {
      lastSession: context.recent[context.recent.length - 1]?.peak ?? 0,
      // Clamped: a sum of floats over a count can land a hair outside the range.
      average: context.sessions === 0 ? 0 : Math.min(100, thousandth(context.peakSum / context.sessions)),
    },
    prompts: {
      graded: prompts.graded,
      gradedToday: tallies.find((tally) => tally.day === today)?.counts["prompt.graded"] ?? 0,
      averageScore: prompts.graded === 0 ? 0 : Math.min(10, thousandth(prompts.scoreSum / prompts.graded)),
      regretted: prompts.regretted,
    },
  }
}
