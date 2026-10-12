// The names a player picks, for the character and the egg: how the engine tidies one as it keeps it, and why it
// refuses one. The rule lives here, on the server's side, so every mod and the website meet the same one.

/** The most characters a picked name may have: it sits beside the level on the band, and in the pane's header. */
export const maxNameLength = 20

/**
 * The most UTF-16 code units the schema's `Name` holds. A letter outside the BMP (a styled `𝓐`, a rare CJK one) takes
 * two, so a name within `maxNameLength` characters can still overflow it, and a state that keeps one no longer decodes.
 */
const maxNameUnits = 32

/** A name as the engine keeps it: trimmed, and each run of spaces inside it one space. */
export const tidyName = (typed: string): string => typed.normalize("NFC").trim().replace(/\s+/gu, " ")

/** Letters and digits in any script, with spaces and `. - _ '` after the first; marks join the letter before them. */
const namePattern = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'-]*$/u

/**
 * Why a tidied name can't be kept, in words the player reads, or null when it can: 1 to `maxNameLength` characters,
 * of letters, digits, spaces and `. - _ '`, opening with a letter or a digit. `whose` names what is being named.
 */
export const nameIssue = (name: string, whose: string): string | null => {
  if (name === "") return `Give ${whose} a name`
  const length = [...name].length
  if (length > maxNameLength) return `A name takes at most ${maxNameLength} characters, and that one has ${length}`
  if (name.length > maxNameUnits) return "That name's characters take too much room: try a shorter one"
  if (!namePattern.test(name)) {
    return "A name takes letters, digits, spaces and . - _ ' only, and opens with a letter or a digit"
  }
  return null
}
