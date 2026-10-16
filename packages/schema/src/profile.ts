import { Predicate, Schema } from "effect"

// What a player shows of themselves on their public page, `pathof.dev/u/<login>`, as `players.profile` keeps it: a
// jsonb the player changes from the mod with `/pathofdev profile`. Private until they say otherwise; a section the
// jsonb has no key for takes its default, which is shown for every section so far.
//
//   isShown(privacy, section)
//     ├─ privacy.public is not literally true ───▶ hidden: the whole page is private (missing, junk: private)
//     ├─ privacy[section] is true or false ──────▶ that
//     ├─ privacy[section] is anything else ──────▶ hidden (a value this build doesn't know fails closed)
//     └─ no key ─────────────────────────────────▶ defaultShown[section]
//
// The header (login, character name, level, title, glyph, XP, prestige) is the page itself: hiding it is `private`.

/** The sections a player can hide or show, in the order the page draws them: the one list. */
export const profileSections = ["badges", "pet", "streak", "stats"] as const

export const ProfileSection = Schema.Literals(profileSections)
export type ProfileSection = typeof ProfileSection.Type

/** What a section with no key in the jsonb shows: a later section may start hidden. */
export const defaultShown: Readonly<Record<ProfileSection, boolean>> = { badges: true, pet: true, streak: true, stats: true }

const sectionFields = {
  badges: Schema.optionalKey(Schema.Boolean),
  pet: Schema.optionalKey(Schema.Boolean),
  streak: Schema.optionalKey(Schema.Boolean),
  stats: Schema.optionalKey(Schema.Boolean),
} satisfies Record<ProfileSection, unknown>

/** A player's privacy, decoded: public or not, and a choice for each section they set one for. */
export const Privacy = Schema.Struct({ public: Schema.Boolean, ...sectionFields })
export interface Privacy extends Schema.Schema.Type<typeof Privacy> {}

/** The privacy of a player who never chose: private, every section at its default. */
export const privateProfile: Privacy = { public: false }

export const isProfileSection = (value: unknown): value is ProfileSection =>
  profileSections.some((section) => section === value)

/**
 * The privacy a stored `profile` jsonb says, from anything at all: public only for a literal `true`; a section's
 * boolean as it is, any other value hidden; keys this build doesn't know dropped. It never throws.
 */
export const privacyOf = (json: unknown): Privacy => {
  const stored = Predicate.isObject(json) ? (json as Record<string, unknown>) : {}
  const sections = profileSections.flatMap((section) =>
    Object.hasOwn(stored, section) ? [[section, stored[section] === true] as const] : []
  )
  return { public: stored["public"] === true, ...Object.fromEntries(sections) }
}

/** Whether the page shows `section`: only on a public page, and as the player set it, else as its default. */
export const isShown = (privacy: Privacy, section: ProfileSection): boolean =>
  privacy.public && (privacy[section] ?? defaultShown[section])

/** A change the player asks for: the whole page public or private, or one section hidden or shown. */
export const PrivacyChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["public", "private"]) }),
  Schema.Struct({ kind: Schema.Literals(["hide", "show"]), section: ProfileSection }),
])
export type PrivacyChange = typeof PrivacyChange.Type

/**
 * `POST /v1/account/profile`: a change as the mod sends it, with the section as the player typed it, so the server
 * alone says which sections there are (`changeOf`).
 */
export const ProfileChangeRequest = Schema.Struct({
  kind: Schema.Literals(["public", "private", "hide", "show"]),
  section: Schema.optionalKey(Schema.String),
})
export interface ProfileChangeRequest extends Schema.Schema.Type<typeof ProfileChangeRequest> {}

/** The change a request asks for, or null when it names no section to hide or show, or names one for the page. */
export const changeOf = (request: ProfileChangeRequest): PrivacyChange | null => {
  if (request.kind === "public" || request.kind === "private") {
    return request.section === undefined ? { kind: request.kind } : null
  }
  return isProfileSection(request.section) ? { kind: request.kind, section: request.section } : null
}

/** The sections, as the player reads them in a line. */
export const sectionsText = `the sections are ${profileSections.join(", ")}`

/**
 * The keys a change writes over the stored jsonb, so two changes to different keys never undo each other: a `show`
 * writes `true`, not a missing key, so the stored form says what the player chose.
 */
export const patchOf = (change: PrivacyChange): Partial<Privacy> => {
  switch (change.kind) {
    case "public":
      return { public: true }
    case "private":
      return { public: false }
    case "hide":
      return { [change.section]: false }
    case "show":
      return { [change.section]: true }
  }
}

/** The privacy after a change: the model the server's `profile || patch` must match. */
export const applyChange = (privacy: Privacy, change: PrivacyChange): Privacy => ({ ...privacy, ...patchOf(change) })

/** `GET` and `POST /v1/account/profile`: what the player shows, the sections there are, and the page's address. */
export const ProfileSettings = Schema.Struct({
  isPublic: Schema.Boolean,
  /** The sections the page leaves out even when public, in the page's order. */
  hidden: Schema.Array(ProfileSection),
  /** Every section there is, in the page's order: what the mod's usage line lists. */
  sections: Schema.Array(ProfileSection),
  /** The public page's address, or null while the server serves none. */
  url: Schema.NullOr(Schema.String),
})
export interface ProfileSettings extends Schema.Schema.Type<typeof ProfileSettings> {}

/** What the player hears of their privacy, from it and the page's address. */
export const settingsOf = (privacy: Privacy, url: string | null): ProfileSettings => ({
  isPublic: privacy.public,
  hidden: profileSections.filter((section) => !(privacy[section] ?? defaultShown[section])),
  sections: profileSections,
  url,
})

/** A player's public page at `origin`: the login lower-cased, so every spelling of it names one page. */
export const profileUrlOf = (origin: string, login: string): string =>
  `${origin}/u/${encodeURIComponent(login.toLowerCase())}`
