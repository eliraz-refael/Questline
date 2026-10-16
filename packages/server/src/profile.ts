import type { Player as PlayerType, Privacy, ProfileSection, QualityDimension, Snapshot } from "@pathofdev/schema"
import { happyBonusPct } from "@pathofdev/engine"
import { isGithubLogin, isShown, Player, privacyOf, profileUrlOf } from "@pathofdev/schema"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Allowlist } from "./auth/allowlist.ts"
import { rules } from "./game.ts"
import { notFoundPage, pageContentType, pageHeaders, profilePage, unavailablePage } from "./pages.ts"
import { playerColumns, Players } from "./players.ts"

// A player's public page, `pathof.dev/u/<login>`: read-only, no sign-in, rendered from their snapshot. Traefik sends
// `/u/*` on pathof.dev to the public server, its prefix kept; everything else there is the landing page.
//
//   GET /u/<anything deeper> ────────────────────▶ 404
//   GET /u/:login
//     ├─ not a GitHub login ─────────────────────▶ 404
//     ├─ Profiles.byLogin: no player holds it ───▶ 404   one query, on lower(github_login)
//     ├─ privacyOf(profile) is not public ───────▶ 404   checked before the save is read, so a private player's
//     ├─ not on the beta list (Allowlist) ───────▶ 404     save, newer or broken, never shows through a 503
//     └─ Players.snapshot
//          ├─ PlayerGone: deleted since ─────────▶ 404
//          ├─ anything else fails ───────────────▶ 503, logged: a database down never looks like a missing page
//          └─▶ profileOf(snapshot, privacy) ─────▶ 200 profilePage   only the sections shown, allow-listed
//
// Every 404 is the same constant page with the same headers, whatever the reason. Pages are never cached
// (`no-store`), so a hide, a private or a delete takes effect on the next view.

/** Where the public pages live: `${origin}/u/<login>`. */
export class ProfileOrigin extends Context.Service<ProfileOrigin, { readonly origin: string }>()(
  "pathofdev/ProfileOrigin",
) {
  static readonly layer = (origin: string) => Layer.succeed(ProfileOrigin, ProfileOrigin.of({ origin }))
}

export const defaultProfileOrigin = "https://pathof.dev"

/** `raw` as an origin the pages can live at (http or https, no path, no trailing slash), or null. */
export const profileOriginOf = (raw: string): string | null => {
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === raw ? raw : null
}

/**
 * What a public page shows, and nothing else: the header, and each section the player shows. A hidden section has no
 * key at all. Built only by `profileOf`, field by field, so a field the snapshot gains never reaches a page unnamed.
 */
export interface PublicProfile {
  readonly login: string
  readonly character: {
    readonly name: string
    readonly level: number
    readonly title: string
    readonly glyph: string
    readonly prestige: number
    readonly xp: { readonly total: number; readonly intoLevel: number; readonly forNextLevel: number }
  }
  readonly badges?: ReadonlyArray<{ readonly id: string; readonly unlockedAt: string }>
  /** Null while it is an egg. */
  readonly pet?: {
    readonly name: string
    /** As the rules name it: "Fox". */
    readonly species: string
    readonly form: number
    readonly mood: number
    /** The XP bonus its mood gives now: 0 unless it is happy. */
    readonly xpBonusPct: number
  } | null
  readonly streak?: { readonly days: number; readonly best: number; readonly restDaysLeftThisWeek: number }
  readonly stats?: {
    readonly graded: number
    readonly averageScore: number
    readonly best: number
    readonly dimensions: Readonly<Record<QualityDimension, number>>
    /** The average context peak, in percent. */
    readonly contextPeak: number
  }
}

const speciesName = (species: string): string => rules.pet.species.find((one) => one.id === species)?.name ?? species

/** What `login`'s page shows of `snapshot` under `privacy`: the allow-list between a save and the web. */
export const profileOf = (login: string, snapshot: Snapshot, privacy: Privacy): PublicProfile => {
  const { character, pet, stats } = snapshot
  const shown = (section: ProfileSection) => isShown(privacy, section)
  return {
    login,
    character: {
      name: character.name,
      level: character.level,
      title: character.title,
      glyph: character.glyph,
      prestige: character.prestige,
      xp: { total: character.xp.total, intoLevel: character.xp.intoLevel, forNextLevel: character.xp.forNextLevel },
    },
    ...(shown("badges") ? { badges: snapshot.achievements.map((one) => ({ id: one.id, unlockedAt: one.unlockedAt })) } : {}),
    ...(shown("pet")
      ? {
        pet: pet === null ? null : {
          name: pet.name,
          species: speciesName(pet.species),
          form: pet.form,
          mood: pet.mood,
          xpBonusPct: happyBonusPct(pet.mood, rules),
        },
      }
      : {}),
    ...(shown("streak")
      ? {
        streak: {
          days: character.streak.days,
          best: character.streak.best,
          restDaysLeftThisWeek: character.streak.restDaysLeftThisWeek,
        },
      }
      : {}),
    ...(shown("stats")
      ? {
        stats: {
          graded: stats.prompts.graded,
          averageScore: stats.prompts.averageScore,
          best: stats.grades.best,
          dimensions: { ...stats.grades.dimensions },
          contextPeak: stats.contextPeak.average,
        },
      }
      : {}),
  }
}

const Found = Schema.Struct({ ...Player.fields, profile: Schema.Unknown })

export class Profiles extends Context.Service<
  Profiles,
  {
    /** The player who holds `login` now, in any case, and their stored profile. */
    readonly byLogin: (login: string) => Effect.Effect<
      Option.Option<{ readonly player: PlayerType; readonly profile: unknown }>,
      Schema.SchemaError | SqlError
    >
  }
>()("pathofdev/Profiles") {
  static readonly layer = Layer.effect(
    Profiles,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const find = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Found,
        execute: (login) => sql`SELECT ${playerColumns(sql)}, profile FROM players WHERE lower(github_login) = lower(${login})`,
      })
      return Profiles.of({
        byLogin: (login) => Effect.map(find(login), Option.map(({ profile, ...player }) => ({ player, profile }))),
      })
    }),
  )
}

const page = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, contentType: pageContentType, headers: pageHeaders })

const notFound = page(notFoundPage, 404)

/** `GET /u/:login`, on the public server only. */
export const ProfilePages = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles
    const players = yield* Players
    const allowlist = yield* Allowlist
    const { origin } = yield* ProfileOrigin

    const pageOf = (raw: string) =>
      Effect.gen(function* () {
        if (!isGithubLogin(raw)) return notFound
        const found = yield* profiles.byLogin(raw)
        if (Option.isNone(found)) return notFound
        const { player, profile } = found.value
        const privacy = privacyOf(profile)
        const login = player.githubLogin
        if (!privacy.public || login === null || !(yield* allowlist.allows(player))) return notFound
        const snapshot = yield* players.snapshot(player)
        return page(profilePage(profileOf(login, snapshot, privacy), profileUrlOf(origin, login)), 200)
      }).pipe(
        Effect.catchTag("PlayerGone", () => Effect.succeed(notFound)),
        // A request cut short (the viewer left, the server stopping) stays interrupted: no 503, nothing logged.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.as(Effect.logWarning("A profile page could not be read", cause), page(unavailablePage, 503))
        ),
      )

    yield* router.add("GET", "/u/:login", Effect.flatMap(HttpRouter.params, ({ login }) => pageOf(login ?? "")))
    // Any other path under /u (`/u`, `/u/a/b`) is the same 404 page, not the router's bare one.
    yield* router.add("GET", "/u/*", Effect.succeed(notFound))
  })
)
