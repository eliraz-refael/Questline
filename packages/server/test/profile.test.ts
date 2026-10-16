import { it } from "@effect/vitest"
import { initialState, project } from "@pathofdev/engine"
import type { Privacy, Snapshot } from "@pathofdev/schema"
import { isShown, privacyOf, profileSections, QualityDimension } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import { catalog, escapeHtml, profileOf, profilePage, rules } from "../src/index.ts"
import { start } from "./fixtures.ts"

// What a public page shows, as properties over any snapshot and any privacy: `profileOf` is the allow-list between a
// save and the web, so a section is there only when the player shows it, a field it never names never reaches the
// page, and what a player typed changes the page's text, never its markup.
//
//   drawn privacy, numbers, names, canaries ─▶ snapshotOf ─▶ profileOf ─▶ profilePage
//     canaries sit in fields no page shows (displayName, commands, claims, items, the egg) and in shown ones

/** A string found nowhere else on a page, so finding it means its field reached the page. */
const Canary = Schema.String.check(Schema.isPattern(/^zq[a-z0-9]{10}zq$/))

/** Text built to break markup. */
const Hostile = Schema.Array(
  Schema.Literals(["<", ">", "&", '"', "'", "a", "/", "=", " ", "<script>", " onerror=", "javascript:", "</style>", "🐉"]),
).check(Schema.isMaxLength(10))

const Shown = Schema.optionalKey(Schema.Boolean)
const DrawnPrivacy = Schema.Struct({ public: Schema.Boolean, badges: Shown, pet: Shown, streak: Shown, stats: Shown })

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const Grade = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

const Drawn = Schema.Struct({
  privacy: DrawnPrivacy,
  name: Hostile,
  hatched: Schema.Boolean,
  mood: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  numbers: Schema.Struct({ total: Count, into: Count, level: Count, prestige: Count, days: Count, best: Count, graded: Count }),
  grades: Schema.Array(Grade).check(
    Schema.isMinLength(QualityDimension.literals.length),
    Schema.isMaxLength(QualityDimension.literals.length),
  ),
  shownCanaries: Schema.Struct({ pet: Canary, badge: Canary }),
  hiddenCanaries: Schema.Struct({ displayName: Canary, command: Canary, claim: Canary, item: Canary, egg: Canary }),
})
type Drawn = typeof Drawn.Type

const player = {
  id: "01K6ZQ8W3J5V7XKQ2M4N6P8R9T",
  githubUserId: 1,
  githubLogin: "ada",
  displayName: "Ada",
  createdAt: start,
}

const base = project(
  initialState({ characterName: "Ada", timezone: "UTC", now: start }),
  { rules, catalog, questPacks: [], now: start },
  { player, serverId: `online-${player.id}`, streamEpoch: 1, cursor: 0 },
)

/** A snapshot with the drawn numbers and names, and canaries in the fields no page shows. */
const snapshotOf = (drawn: Drawn, name: string): Snapshot => {
  const { numbers, hiddenCanaries: hidden } = drawn
  const dimensions = Object.fromEntries(QualityDimension.literals.map((quality, i) => [quality, drawn.grades[i]! / 10]))
  return {
    ...base,
    player: { ...base.player, displayName: hidden.displayName },
    character: {
      ...base.character,
      name,
      level: numbers.level,
      prestige: numbers.prestige,
      xp: { ...base.character.xp, total: numbers.total, intoLevel: numbers.into, forNextLevel: numbers.into + 100 },
      streak: { ...base.character.streak, days: numbers.days, best: numbers.best },
    },
    pet: drawn.hatched ? { species: "fox", name: drawn.shownCanaries.pet, form: 1, mood: drawn.mood, equipped: {} } : null,
    egg: drawn.hatched ? null : { species: "owl", name: hidden.egg },
    achievements: [{ id: drawn.shownCanaries.badge, unlockedAt: start }],
    claims: [{ claimId: player.id, kind: "change.merged", subject: `${hidden.claim}/repo#1`, status: "pending" }],
    inventory: [{ id: player.id, itemId: hidden.item, acquiredAt: start, source: { kind: "drop", ref: hidden.item }, dye: null }],
    stats: {
      ...base.stats,
      commands: { [`/${hidden.command}`]: 3 },
      prompts: { ...base.stats.prompts, graded: numbers.graded },
      grades: { best: drawn.grades[0]! / 10, dimensions: dimensions as Snapshot["stats"]["grades"]["dimensions"] },
    },
  }
}

const viewOf = (drawn: Drawn, name = drawn.name.join("")) => {
  const privacy: Privacy = privacyOf(drawn.privacy)
  const profile = profileOf("ada", snapshotOf(drawn, name), privacy)
  return { privacy, profile, page: profilePage(profile, "https://pathof.dev/u/ada") }
}

describe("profileOf", () => {
  it.prop("has a section exactly when the player shows it", [Drawn], ([drawn]) => {
    const { privacy, profile } = viewOf(drawn)
    for (const section of profileSections) expect({ section, has: section in profile }).toEqual({ section, has: isShown(privacy, section) })
  })

  it.prop("shows the snapshot's own numbers", [Drawn], ([drawn]) => {
    const { profile } = viewOf(drawn)
    const { numbers } = drawn
    expect(profile.character).toMatchObject({ level: numbers.level, prestige: numbers.prestige })
    expect(profile.character.xp).toEqual({ total: numbers.total, intoLevel: numbers.into, forNextLevel: numbers.into + 100 })
    if (profile.streak !== undefined) expect(profile.streak).toMatchObject({ days: numbers.days, best: numbers.best })
    if (profile.stats !== undefined) expect(profile.stats.graded).toBe(numbers.graded)
  })
})

describe("profilePage", () => {
  it.prop("never shows a field no page names, nor a section the player hides", [Drawn], ([drawn]) => {
    const { privacy, page } = viewOf(drawn)
    for (const canary of Object.values(drawn.hiddenCanaries)) expect(page).not.toContain(canary)
    expect(page.includes(drawn.shownCanaries.pet)).toBe(isShown(privacy, "pet") && drawn.hatched)
    expect(page.includes(drawn.shownCanaries.badge)).toBe(isShown(privacy, "badges"))
  })

  it.prop("draws a character name as text, so the markup is the same whatever it holds", [Drawn], ([drawn]) => {
    // The name between two markers, so its escaped form is found in the page and nowhere else.
    const marked = `zqh${drawn.name.join("")}hqz`
    const page = viewOf(drawn, marked).page
    const plain = viewOf(drawn, "zqhhqz").page
    expect(page.replaceAll(escapeHtml(marked), "NAME")).toBe(plain.replaceAll("zqhhqz", "NAME"))
    expect(page).not.toMatch(/<script/i)
  })
})
