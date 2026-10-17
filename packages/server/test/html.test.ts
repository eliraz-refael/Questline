import { it } from "@effect/vitest"
import { emptyCell, spriteRuns } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import { escapeHtml, html, isHtml, raw, spriteSvg } from "../src/index.ts"

// The HTML boundary, as properties over hostile text: escaped text never carries markup and reads back as it was; a
// template keeps its own markup and nothing else, whatever goes in its slots; a sprite draws one rect per run.

/** Text built to break markup: tags, quotes, entities, handlers, and some that are only text. */
const Hostile = Schema.Array(
  Schema.Literals(["<", ">", "&", '"', "'", "a", "/", "=", " ", "<script>", " onerror=", "javascript:", "&amp;", "</style>", "é", "🐉"]),
).check(Schema.isMaxLength(12))
const text = (pieces: ReadonlyArray<string>): string => pieces.join("")

const decoded: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }
const unescape = (escaped: string): string => escaped.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => decoded[entity]!)

describe("escapeHtml", () => {
  it.prop("leaves no character that opens markup or ends an attribute, and every & starts an entity", [Hostile], ([pieces]) => {
    const escaped = escapeHtml(text(pieces))
    expect(escaped).not.toMatch(/[<>"']/)
    expect(escaped.replace(/&(?:amp|lt|gt|quot|#39);/g, "")).not.toContain("&")
  })

  it.prop("reads back as the text it was", [Hostile], ([pieces]) => {
    expect(unescape(escapeHtml(text(pieces)))).toBe(text(pieces))
  })
})

describe("html", () => {
  it.prop("escapes a text slot, and passes markup it built as it is", [Hostile, Hostile], ([a, b]) => {
    expect(html`<b title="${text(a)}">${text(b)}</b>`.text).toBe(`<b title="${escapeHtml(text(a))}">${escapeHtml(text(b))}</b>`)
    const inner = html`<i>${text(a)}</i>`
    expect(html`<p>${inner}</p>`.text).toBe(`<p>${inner.text}</p>`)
    expect(isHtml(inner) && !isHtml(text(a))).toBe(true)
  })

  it.prop("draws a list slot in order, and nothing for a part left out", [Schema.Array(Hostile).check(Schema.isMaxLength(5))], ([items]) => {
    const list = html`<ul>${items.map((item) => html`<li>${text(item)}</li>`)}${null}${undefined}${false}</ul>`
    expect(list.text).toBe(`<ul>${items.map((item) => `<li>${escapeHtml(text(item))}</li>`).join("")}</ul>`)
  })

  it.prop("keeps the template's own markup whatever the slots hold", [Schema.Array(Hostile).check(Schema.isMaxLength(5))], ([items]) => {
    const page = (texts: ReadonlyArray<string>) =>
      html`<ul class="x">${texts.map((one, i) => html`<li data-i="${i}" title="${one}">${one}<br></li>`)}</ul>`.text
    const tags = (markup: string) => [...markup.matchAll(/<\/?[a-z]+/g)].map((match) => match[0])
    expect(tags(page(items.map(text)))).toEqual(tags(page(items.map(() => ""))))
  })

  it.prop("passes a constant through raw as it is written", [Hostile], ([pieces]) => {
    expect(raw(text(pieces)).text).toBe(text(pieces))
  })
})

describe("spriteSvg", () => {
  const Grid = Schema.Array(Schema.String.check(Schema.isPattern(/^[.ab]{4}$/))).check(Schema.isMinLength(1), Schema.isMaxLength(5))
  const palette = { a: "#111111", b: "#222222" }

  it.prop("draws one rect per run, in the palette's colours, on a grid-sized view box, its label escaped", [Grid, Hostile], ([rows, label]) => {
    const svg = spriteSvg({ rows, palette }, text(label)).text
    const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="([^"]+)"\/>/g)]
    expect(rects.map(([, x, y, width, fill]) => ({ x: Number(x), y: Number(y), width: Number(width), fill }))).toEqual(
      spriteRuns(rows).map((run) => ({ x: run.x, y: run.y, width: run.width, fill: palette[run.cell as "a" | "b"] })),
    )
    expect(svg).toContain(`viewBox="0 0 4 ${rows.length}"`)
    expect(svg).toContain(`aria-label="${escapeHtml(text(label))}"`)
    expect(rects.length === 0).toBe(rows.every((row) => [...row].every((cell) => cell === emptyCell)))
  })
})
