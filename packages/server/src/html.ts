import type { Sprite } from "@pathofdev/schema"
import { spriteRuns } from "@pathofdev/schema"

// The HTML boundary: every page the server renders is built here, from `Html`, so nothing a player wrote (a character
// name, a pet's name) reaches a page as markup. A string is text until it is escaped:
//
//   html`<p>${slot}</p>`   slot:
//     ├─ Html ───────────────────▶ as it is: markup this module built, from escaped parts or constants
//     ├─ string, number ─────────▶ escapeHtml: & < > " ' as entities, so text in an element or a quoted attribute
//     ├─ an array of slots ──────▶ each, in order
//     └─ null, undefined, false ─▶ nothing, for a part left out
//   raw(constant) ───────────────▶ Html as written: only for constants in the source (the style sheet), never data
//
// A page has no script and inlines its one style sheet, so the CSP (pages.ts) allows no script at all.

const HtmlTypeId: unique symbol = Symbol.for("pathofdev/Html")

/** Markup that is safe to send: built by `html` from escaped text, or a constant through `raw`. */
export interface Html {
  readonly [HtmlTypeId]: true
  readonly text: string
}

const make = (text: string): Html => ({ [HtmlTypeId]: true, text })

export const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && HtmlTypeId in value

/** What a template may put in a slot. */
export type Slot = Html | string | number | null | undefined | false | ReadonlyArray<Slot>

const entities: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

/** `text` as HTML text: safe in an element and in a quoted attribute. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => entities[ch]!)

const slotText = (slot: Slot): string => {
  if (slot === null || slot === undefined || slot === false) return ""
  if (isHtml(slot)) return slot.text
  if (typeof slot === "string") return escapeHtml(slot)
  if (typeof slot === "number") return escapeHtml(String(slot))
  return slot.map(slotText).join("")
}

/** Markup from a template: its literal parts as written, each slot as `Slot` says. */
export const html = (strings: TemplateStringsArray, ...slots: ReadonlyArray<Slot>): Html =>
  make(strings.reduce((out, part, i) => out + slotText(slots[i - 1]) + part))

/** A constant from the source as markup, as written. Never call it on anything read from a request or a save. */
export const raw = (constant: string): Html => make(constant)

/** A sprite as an inline SVG, one rect per run, in its own palette; `label` names it for a screen reader. */
export const spriteSvg = (sprite: Sprite, label: string): Html => {
  const width = sprite.rows[0]?.length ?? 0
  return html`<svg class="sprite" viewBox="0 0 ${width} ${sprite.rows.length}" role="img" aria-label="${label}">${
    spriteRuns(sprite.rows).map((run) =>
      html`<rect x="${run.x}" y="${run.y}" width="${run.width}" height="1" fill="${sprite.palette[run.cell] ?? "none"}"/>`
    )
  }</svg>`
}
