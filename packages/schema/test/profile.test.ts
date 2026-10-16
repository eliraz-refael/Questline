import { it } from "@effect/vitest"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import type { PrivacyChange } from "../src/index.ts"
import {
  applyChange,
  changeOf,
  defaultShown,
  isShown,
  Privacy,
  privacyOf,
  privateProfile,
  ProfileChangeRequest,
  profileSections,
  profileUrlOf,
  settingsOf,
} from "../src/index.ts"

// The privacy rules, as properties: a stored profile of any shape reads as a privacy that fails closed; a change
// touches its one key, twice is once, and changes to different keys commute; what is shown follows from the keys.

const Section = Schema.Literals(profileSections)

/** What `players.profile` may hold: what the server writes, older or newer builds' keys, and junk. */
const Stored = Schema.Union([
  Schema.Struct({
    public: Schema.Union([Schema.Boolean, Schema.String, Schema.Number, Schema.Null]),
    pet: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String, Schema.Null])),
    streak: Schema.optionalKey(Schema.Boolean),
    stats: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Number])),
    history: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Array(Schema.Boolean),
  Schema.String,
  Schema.Number,
  Schema.Null,
])

const Change = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["public", "private"]) }),
  Schema.Struct({ kind: Schema.Literals(["hide", "show"]), section: Section }),
])

/** What a stored profile holds as an object, or nothing. */
const recordOf = (stored: unknown): Record<string, unknown> =>
  typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}

/** The key a change writes. */
const keyOf = (change: PrivacyChange): string => ("section" in change ? change.section : "public")

describe("privacyOf", () => {
  it.prop("reads anything stored as a privacy, public only for a literal true", [Stored], ([stored]) => {
    const privacy = privacyOf(stored)
    expect(Schema.is(Privacy)(privacy)).toBe(true)
    expect(privacy.public).toBe(recordOf(stored)["public"] === true)
  })

  it.prop("fails closed: a section shows only for true, or for no key and its default", [Stored, Section], ([stored, section]) => {
    const privacy = privacyOf(stored)
    const record = recordOf(stored)
    const expected = Object.hasOwn(record, section) ? record[section] === true : defaultShown[section]
    expect(isShown(privacy, section)).toBe(privacy.public && expected)
  })

  it.prop("reads a privacy it wrote as itself", [Privacy], ([privacy]) => {
    expect(privacyOf(JSON.parse(JSON.stringify(privacy)))).toEqual(privacy)
  })
})

describe("a privacy change", () => {
  it.prop("twice is once", [Privacy, Change], ([privacy, change]) => {
    expect(applyChange(applyChange(privacy, change), change)).toEqual(applyChange(privacy, change))
  })

  it.prop("commutes with a change to another key", [Privacy, Change, Change], ([privacy, one, other]) => {
    if (keyOf(one) === keyOf(other)) return
    expect(applyChange(applyChange(privacy, one), other)).toEqual(applyChange(applyChange(privacy, other), one))
  })

  it.prop("changes its one key, and leaves every other as it was", [Privacy, Change], ([privacy, change]) => {
    const after = applyChange(privacy, change)
    for (const key of ["public", ...profileSections] as const) {
      if (key !== keyOf(change)) expect(after[key]).toEqual(privacy[key])
    }
    if ("section" in change) expect(isShown({ ...after, public: true }, change.section)).toBe(change.kind === "show")
    else expect(after.public).toBe(change.kind === "public")
  })
})

describe("a change request", () => {
  it.prop("names a change only for a known section to hide or show, and none for the page", [ProfileChangeRequest], ([request]) => {
    const change = changeOf(request)
    const isPage = request.kind === "public" || request.kind === "private"
    const isValid = isPage ? request.section === undefined : profileSections.some((one) => one === request.section)
    expect(change !== null).toBe(isValid)
    if (change !== null) expect(change).toEqual(request)
  })
})

describe("the settings", () => {
  it.prop("list as hidden exactly the sections a public page leaves out", [Privacy, Schema.NullOr(Schema.String)], ([privacy, url]) => {
    const settings = settingsOf(privacy, url)
    expect(settings.isPublic).toBe(privacy.public)
    expect(settings.sections).toEqual(profileSections)
    expect(settings.url).toBe(url)
    expect(settings.hidden).toEqual(profileSections.filter((section) => !isShown({ ...privacy, public: true }, section)))
  })

  it.prop("of a player who never chose are private, every section at its default", [Section], ([section]) => {
    expect(isShown(privateProfile, section)).toBe(false)
    expect(isShown({ public: true }, section)).toBe(defaultShown[section])
  })
})

describe("a profile's address", () => {
  const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/))

  it.prop("is one page for every spelling of a login, under /u/", [Login], ([login]) => {
    const url = profileUrlOf("https://pathof.dev", login)
    expect(url).toBe(profileUrlOf("https://pathof.dev", login.toUpperCase()))
    expect(decodeURIComponent(url.slice("https://pathof.dev/u/".length))).toBe(login.toLowerCase())
  })
})
