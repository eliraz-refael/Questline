import type { RulesConfig } from '@questline/schema'
import type { CareView } from '../types'

// How the pet feels, in plain words and hearts, from its mood and the rules' happy line. A low mood reads as sleepy,
// never sad: neglect never guilts the player, and nothing is lost.

/** Whether the server takes care of the pet: only one whose rules say what a meal and a pat do. */
export const knowsCareOf = (rules: Partial<RulesConfig>): boolean => {
  const care: unknown = rules.pet?.care
  return typeof care === 'object' && care !== null
}

/** The mood above which the pet is happy: the rules', or the starter's when an older server doesn't say. */
export const happyLine = (care: Pick<CareView, 'happyAbove'> | null): number => care?.happyAbove ?? 70

/** How the pet feels, in a word: happy above the rules' line, content above half of it, sleepy below. */
export const moodWord = (mood: number, happyAbove: number): 'happy' | 'content' | 'sleepy' =>
  mood > happyAbove ? 'happy' : mood > happyAbove / 2 ? 'content' : 'sleepy'

const hearts: Record<ReturnType<typeof moodWord>, string> = { happy: '♥♥♥', content: '♥♥', sleepy: '♥' }

/** Hearts for a mood: three for a happy pet, two for a content one, one for a sleepy one. Never none. */
export const heartsFor = (mood: number, happyAbove: number): string => hearts[moodWord(mood, happyAbove)]
