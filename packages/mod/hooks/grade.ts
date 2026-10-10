import type { GradeDimension } from '@questline/schema'
import type { PluginOptions } from 'claude-code'

// Grading the prompts the player types: which ones are graded, what Haiku is asked, and reading its scores back.
// Only the scores leave the machine; the prompt, the answer it follows and the grader's note stay here.

/** The rubric below, as the server's `prompt.rubricVersion` names it. A change to the rubric bumps it. */
export const rubricVersion = 1

export const RUBRIC = `You grade one prompt a developer typed to an AI coding assistant. Score each from 0 to 10 against what
this prompt needs, not against an ideal task prompt: a short follow-up or a question loses nothing for context it does not need.
clarity: the ask is unambiguous and easy to follow
grammar: spelling, grammar and punctuation
specificity: points at the files, errors, symbols or examples involved
instructive: concrete, actionable direction (what, where, constraints)
context: gives the why behind the ask
doneCriteria: says how to know it is finished (tests pass, a behaviour, a shape)
focus: one well-sized ask rather than a sprawling list
regret: how much it walks back or corrects earlier work or instructions (0 none, 10 undo everything)
Reply with strict JSON only, no prose and no code fence:
{"clarity":n,"grammar":n,"specificity":n,"instructive":n,"context":n,"doneCriteria":n,"focus":n,"regret":n,"note":"at most 8 words"}`

/** How much of the previous answer the grader reads: its end, where the question to the player usually is. */
export const answerTail = 1500

const defaultMinWords = 6

/** The `minWords` option: a prompt shorter than this goes ungraded. A value that is no whole number above 0 is 6. */
export const minWordsOf = (options: PluginOptions): number => {
  const value = options['minWords']
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : defaultMinWords
}

export const wordsOf = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length

/** A slash command's name opens the text: `/compact`, `/plugin:name`, never a path such as `/src/parser.ts`. */
export const isSlashCommand = (text: string): boolean => /^\/[A-Za-z0-9][A-Za-z0-9:._-]*(?:\s|$)/.test(text.trimStart())

/** Typed at the prompt box, not a slash command, and long enough. Pasted text counts toward the words. */
export const isGradable = (originKind: string, text: string, words: number, minWords: number): boolean =>
  originKind === 'composer' && !isSlashCommand(text) && words >= minWords

/** What the grader is asked: the prompt, with the one before it and the end of the answer between them. */
export const askFor = (text: string, previous: string, answer: string): string =>
  [
    `Previous prompt by the user:\n${previous === '' ? '(none)' : previous}`,
    `End of the assistant's previous answer:\n${answer === '' ? '(none)' : answer}`,
    `The prompt to grade:\n<prompt>\n${text}\n</prompt>`,
  ].join('\n\n')

const fieldsOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null

/** A score in range, rounded to the whole number the server takes; null for anything else. */
const scoreOf = (value: unknown): number | null =>
  typeof value === 'number' && value >= 0 && value <= 10 ? Math.round(value) : null

const isComplete = (scores: Record<GradeDimension, number | null>): scores is Record<GradeDimension, number> =>
  Object.values(scores).every((score) => score !== null)

/**
 * The scores in the reply's {...}, its first `{` to its last `}`; null when it doesn't parse or any score is missing
 * or out of range.
 */
export const scoresOf = (reply: string): Record<GradeDimension, number> | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (json === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const fields = fieldsOf(parsed)
  if (fields === null) return null
  const scores: Record<GradeDimension, number | null> = {
    clarity: scoreOf(fields['clarity']),
    grammar: scoreOf(fields['grammar']),
    specificity: scoreOf(fields['specificity']),
    instructive: scoreOf(fields['instructive']),
    context: scoreOf(fields['context']),
    doneCriteria: scoreOf(fields['doneCriteria']),
    focus: scoreOf(fields['focus']),
    regret: scoreOf(fields['regret']),
  }
  return isComplete(scores) ? scores : null
}
