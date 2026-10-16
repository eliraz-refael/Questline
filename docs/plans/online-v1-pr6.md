# Plan: PR 6a + 6b, accounts and profiles — final, after /review-plan-deep (2026-10-16)

Planned against main at bf0430c (#24–#35 merged; the public server live at https://api.pathof.dev, single replica,
Postgres 18; site/ a separate static Coolify app at pathof.dev). Parent plan: `docs/plans/online-v1.md` (PR 6). Built
with /create-plan (four agents: architecture, code design, tests, scope) and reviewed with /review-plan-deep; the
review's decisions are folded in below and listed in "Review decisions".

## Goal
Let each online player choose what of theirs is public and show it as a server-rendered, read-only page at
`pathof.dev/u/<login>`, plus account export and delete — all controlled from the mod. No sign-in on the web.

Two PRs, in order:
- **6a, account and privacy (no web):** privacy endpoint + `/pathofdev profile`, paged export
  (`/pathofdev account export`), delete (`/pathofdev account delete <login>`).
- **6b, profile pages:** `/u/<login>` on the public server, the pet sprite in `schema/sprites.ts`, the Coolify route.

## Review decisions (issue → choice)
1A  Account routes (privacy, export, delete) use a token-only `Authentication` (no beta-list check), so a player
    removed from the beta can still export and delete while their mod is signed in. `/u` shows a player only while
    they are on the beta list. Removing from the beta does not revoke tokens. Otherwise an admin does it, documented.
2A  One typed `PlayerGone` from a single `headOf(playerId)` in writer.ts, used by `lock`, `current`, `savedBy` and
    `guard`; presence's `INSERT INTO sessions` maps FK violation 23503 to `PlayerGone`. ModHandlers and
    AccountHandlers map `PlayerGone` to `Unauthorized("This account was deleted: sign in again")`, once each.
3A  `/u/<login>` can show a former holder after a GitHub rename or recycled login (cleared only when the new holder
    signs in). Accepted for the beta; TODO to re-check logins against GitHub.
4A  `edge.admit` refuses events with `occurredAt < player.createdAt` as `before_account` (beside `too_old`), so
    another machine's old queue never pours into a re-created account. The mod already drops rejected events.
5A  The delete confirmation is checked on the server only (`confirmed`): the mod stores no login. The mod sends what
    was typed and shows the server's 400 text.
6A  No section list in the mod. The server rejects an unknown section with 400 whose message lists the sections;
    `GET /v1/account/profile` returns `sections` for the mod's usage text. One list, in `schema/profile.ts`.
7A  `playerTables` drives export and delete through `sql(identifier)` only, never `sql.unsafe`. The meta-test checks
    every listed table and column exists, every table with `player_id` is listed, and `players` exports every
    column except `roll_seed`.
8A  Every diagram a PR makes stale is a checklist item in that PR (see "Diagrams").
9A  Model-based fast-check properties (command sequences) for the privacy endpoint and the account lifecycle,
    instead of a dozen separate DB-backed properties. Pure functions keep their own properties.
10A The mod's export loop is a pure `exportStep(state, answer)` reducer with properties; register.tsx only runs it.
11A Concurrency properties run on the Postgres leg only (`skipIf(!postgres)`, "passes trivially on PGlite"), each
    with a deterministic reduction (stale `CurrentPlayer`, a pre-set failing trigger) that runs on both legs.
12A No page cache in v1; `/u/*` per client IP goes into the server-side limiter TODO.
13A `sessions` and `quarantine` are paged export parts too; the head holds one-row data only, with a size property.
14A Delete is one transaction with a generous statement timeout; a lost answer is safe (the retry gets 401).

Synthesis choices (from the agents' conflicts):
- Export is paged (pages ≤ 1 MiB): the mod's `$.fs.write` rejects over 4 MiB, and `event_log` keeps each input as jsonb.
- `Cache-Control: no-store` on `/u`, no Cloudflare cache rule, no purge hook: a hide or delete takes effect at once.
- Sections: `pet`, `streak`, `stats`. The header (login, character name, level, title, glyph, XP, prestige) is the
  profile itself: hiding it is `private`. History, achievements (the engine never unlocks one), inventory and gold
  are out.
- `profileOf(snapshot, privacy)` builds an allow-listed `PublicProfile` with only the visible sections: the privacy
  boundary. No separate redact step.
- Server files: `account.ts`, `profile.ts`, `html.ts`. `html.ts` is the XSS boundary (an `Html` brand and an `html`
  tagged template).
- `PROFILE_ORIGIN` env var, default `https://pathof.dev`; the `u.pathof.dev` fallback then needs no code change.
- No redirects for a recased login or the `api.` host: lookup is case-insensitive and the page has
  `<link rel="canonical">` to the lowercase `pathof.dev` URL.
- `site/` stays its own static Coolify app (decided; close the TODO). Moving it in would tie landing-page edits to
  server restarts and outages; the sprite is shared through `schema/sprites.ts` and a site guard test.

## Facts found in the code (drive the design)
- Migration 0012 already has `players.profile jsonb DEFAULT '{"public": false}'`, the unique `lower(github_login)`
  index and `server_events_progress`. **No migration.**
- Per-player tables, all `REFERENCES players (id)` with no `ON DELETE`: `players`, `player_state`, `event_log`,
  `server_events`, `rolls`, `quarantine`, `sessions`, `api_tokens`. `beta_logins` and `quest_packs` are not.
- `event_log`, `server_events` and `rolls` are append-only (no `UPDATE` outside migrations); every quarantine row has
  an `event_log` row (writer.ts ~197–205). `sessions` rows change (`last_heard_at`, `closed_at`).
- writer.ts `lock` (~96), `current` (~255), `savedBy` (~274) use `SqlSchema.findOne`: a missing row is a defect (500).
  presence.ts calls `writer.guard` before each session change (~121, 133, 146, 177) and inserts `sessions` outside
  the lock (~92).
- `BearerAuth` (auth/middleware.ts) checks the beta list on every request; sign-in checks it too.
- `edge.ts` ~49 refuses `too_old` events; the mod drops rejected events.
- `Players.snapshot` (players.ts ~192) runs `project()`: level, title, glyph, XP, prestige, streak, pet (species,
  name, form, mood), stats. `displayName` is the GitHub real name; `stats.commands` holds slash-command names
  (possibly private); `claims` name repos; `roll_seed` predicts loot. None of them ever leave in a page; `roll_seed`
  and `api_tokens.token_hash` never leave in an export.
- The mod: `$.fs.write(path, text)` creates folders, rejects over 4 MiB; a relative path lands in the session's cwd
  (often a repo), so exports go under `$PATHOFDEV_HOME` or `~/.pathofdev/exports/`. The mod imports only types from
  `@pathofdev/schema` and stores no GitHub login. `accountAskOf` (login.ts) already parses `login|logout`.
- Plain HTML routes go through `HttpRouter.use(router => router.add(...))` like `Healthz` (public.ts ~138).
- The pet: 14x12 grid + palette only in `site/index.html` (~416–432); `engine/test/site.test.ts` reads the site.

## Architecture

### 6a, privacy
```
/pathofdev profile [public|private|hide <s>|show <s>]
  mod profileAskOf ─▶ profileRouteOf ─▶ askOnline
  bare   ─▶ GET  /v1/account/profile            ─▶ {settings, sections, url}
  change ─▶ POST /v1/account/profile {change}
    AccountAuth (token only) ── 401 ─▶ signed out
    decode PrivacyChange ── unknown section / bad ─▶ 400 "… sections: pet, streak, stats"
    patchOf(change)                                       pure: {"public":true} | {"pet":false} | {"pet":true}
    UPDATE players SET profile = profile || $patch WHERE id = $1 RETURNING profile      atomic
      0 rows ─▶ PlayerGone ─▶ 401
    privacyOf(returned) ─▶ settingsOf(privacy, url)       pure, fails closed
  ◀── ProfileSettings {isPublic, hidden, sections, url}  (url null until 6b) ─▶ profileTextOf
```

### 6a, export
```
/pathofdev account export   (online only, signed in)
  GET /v1/account/export ─▶ AccountData.head(id)   one tx, one-row data only (13A):
      players row minus roll_seed · profile · player_state.state as raw JSON (works on a newer engine's save)
      · tokens [{createdAt}] · onBetaList · counts per part · upto = {logSeq, serverSeq} from that player_state row
  mod: exportStep ─▶ write <dir>/head.json        dir = $PATHOFDEV_HOME|~/.pathofdev /exports/<login>-<date>
  for part of exportParts:
      events        event_log      key log_seq             ≤ upto.logSeq
      serverEvents  server_events  key seq                 ≤ upto.serverSeq
      rolls         rolls          key number              log_seq ≤ upto.logSeq
      quarantine    quarantine     key log_seq (via event_log join on input_id)  ≤ upto.logSeq
      sessions      sessions       key session_id (ULID)   as of the read (sessions change; noted in head)
    loop GET /v1/account/export/<part>?after=<k>&upto=<u>
      server: WHERE player_id = me AND key > after [AND ≤ upto] ORDER BY key LIMIT 1000 ─▶ pageOf(rows, 1 MiB)
      401 / 5xx / none ─▶ stop: "incomplete export in <dir>" (no complete.json)
      200 ─▶ write <part>-NNNN.json; next = null ─▶ next part
  write complete.json (counts checked against the head) ─▶ "exported to <dir>"
```
The append-only tables never change at or below `upto`, so pages read later still match the head without a long
transaction.

### 6a, delete
```
/pathofdev account delete <login>
  mod: no <login> ─▶ warning + "export first with /pathofdev account export" (no request)
  POST /v1/account/delete {login}
    AccountAuth ── 401 ─▶ mod clears its token only
    confirmed(CurrentPlayer, login) ── no ─▶ 400 ConfirmMismatch "type your GitHub login", nothing written
    erase(id): ONE tx, generous statement timeout (14A)
      lockPlayer            player_state FOR UPDATE: waits for an apply in flight
      players FOR UPDATE    blocks the FK checks of mint, sessions insert, findOrCreate's rename
      DELETE in playerTables order: api_tokens, sessions, quarantine, rolls, server_events, event_log,
                                    player_state, players
      an unlisted child table ─▶ FK error ─▶ rollback ─▶ 500, nothing deleted (fails closed)
    COMMIT ─▶ StreamHub.notify(id)   held polls wake, read PlayerGone, answer 401
  ◀── Deleted {deleted: true, onBetaList}
  mod 2xx       ─▶ $.store.delete token, queue, explored, cursor @origin ─▶ "deleted"
  mod none/5xx  ─▶ keep everything: "not sure it went through: run it again, or sign in to check"
```
Lock order: delete takes `player_state` then `players`; apply takes `player_state`, then KEY SHARE on `players`
through its inserts' FK checks; `findOrCreate` locks `players` only; presence and mint autocommit. No cycle.
`beta_logins` is the admins' list and stays; the answer says whether the login is still on it.

### 6b, profile page
```
GET pathof.dev/u/<raw> ─▶ Cloudflare (no-store: not cached) ─▶ Traefik Host(pathof.dev) && PathPrefix(/u), no strip
  ProfilePages  GET /u/:login
    !isGithubLogin(raw) ─────────────────────────────────────▶ NOT_FOUND
    Profiles.byLogin(raw)   one query on lower(github_login): player columns + profile
      none ──────────────────────────────────────────────────▶ NOT_FOUND
      !privacyOf(profile).public ────────────────────────────▶ NOT_FOUND   checked BEFORE any state read
      !Allowlist.allows(player) (1A) ────────────────────────▶ NOT_FOUND
      public ─▶ Players.snapshot(player)
                  defect / ServerBehind / PlayerGone / DB down ─▶ 503 no-store + Retry-After (never the 404)
                profileOf(snapshot, privacy) ─▶ PublicProfile   allow-list; hidden sections absent
                profilePage(view, canonicalUrl) ─────────────▶ OK
NOT_FOUND = 404, notFoundPage (a constant; never echoes the login), pageHeaders     byte-identical for every cause
OK        = 200, profilePage(view),                              pageHeaders
pageHeaders: content-type text/html; charset=utf-8 · cache-control: no-store · x-content-type-options: nosniff
  · referrer-policy: no-referrer · content-security-policy: default-src 'none'; style-src 'sha256-<css>';
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'   (inline SVG sprite: no img-src needed)
```

### Dependency graph (→ imports)
```
schema/profile.ts ─┐                         schema/sprites.ts ◀── engine/test/site.test.ts
schema/api.ts ─────┼─▶ schema/http-api.ts (AccountApi ⊂ OnlineApi only; PlayerGone/ConfirmMismatch texts here)
                   ▲ type-only
mod/hooks/profile.ts, account.ts ─┐
mod/hooks/server.ts ◀─────────────┴── mod/hooks/register.tsx

server/html.ts ──▶ schema/sprites.ts                                      (pure)
server/account.ts ─▶ schema, writer.ts (lockPlayer, PlayerGone), hub.ts, effect/sql
server/profile.ts ─▶ html.ts, players.ts (snapshot), auth/allowlist.ts, schema, effect/sql
server/auth/middleware.ts ─▶ tokens.ts, allowlist.ts       (BearerAuth + AccountAuth)
server/auth/routes.ts ─▶ account.ts (OnlineRoutes += AccountHandlers)
server/public.ts ─▶ auth/routes.ts, profile.ts, services.ts
```
No cycles. `account.ts` must not import `auth/middleware.ts` (auth/routes.ts imports account.ts): shared texts live
in schema `http-api.ts` beside `Unauthorized`. `players.ts` never imports `profile.ts`.

Side effects: SQL only in `account.ts` (`AccountData`) and `profile.ts` (`Profiles`); `notify` only after commit in
the account handlers; `$.fs`, `$.store`, `$.http` only in `register.tsx`. Everything that decides is pure.

### `AccountApi` (schema http-api.ts, on `OnlineApi` only, middleware `AccountAuth`)
| Endpoint | Payload | Success | Errors |
|---|---|---|---|
| `GET /v1/account/profile` | — | `ProfileSettings` | Unauthorized |
| `POST /v1/account/profile` | `{change: PrivacyChange}` | `ProfileSettings` | Unauthorized, 400 (decode) |
| `GET /v1/account/export` | — | `ExportHead` | Unauthorized |
| `GET /v1/account/export/:part` | query `after`, `upto` | `ExportPage {rows, next}` | Unauthorized |
| `POST /v1/account/delete` | `{login}` | `Deleted {deleted, onBetaList}` | Unauthorized, `ConfirmMismatch` (400) |

`AccountAuth` is a second `HttpApiMiddleware` like `Authentication`: `Tokens.playerOf` only, no allowlist. Delete is
a POST (it carries a body); the mod's `Route.method` (`'DELETE' | 'POST'`, GET = no body) needs no change.

## Function design

### Composition
```
privacy: args ─▶ profileAskOf ─▶ profileRouteOf ─▶ askOnline ─▶ [patchOf ─▶ UPDATE … || ─▶ privacyOf ─▶ settingsOf] ─▶ profileTextOf
export:  exportStep(init) ─▶ (ask ─▶ fetch ─▶ [SELECT ─▶ pageOf] ─▶ answer ─▶ exportStep ─▶ write)* ─▶ done
delete:  dataAskOf ─▶ askOnline ─▶ [confirmed ─▶ erase(lockPlayer ─▶ playerTables.forEach DELETE) ─▶ notify] ─▶ keysAfterDelete ─▶ $.store.delete
page:    raw ─▶ isGithubLogin ─▶ byLogin ─▶ privacyOf.public ─▶ allows ─▶ snapshot ─▶ profileOf ─▶ profilePage(html``) ─▶ response(pageHeaders)
edge:    event ─▶ … ─▶ tooOld? ─▶ beforeAccount(event, player.createdAt)? ─▶ admit
```

### Function inventory
| Name | Signature | Responsibility | File |
|---|---|---|---|
| `profileSections` | `["pet","streak","stats"] as const` | The one section list | schema/profile.ts |
| `ProfileSection`, `Privacy`, `PrivacyChange`, `ProfileSettings` | Schemas; `Privacy = {public, ...optional booleans}` built from the list with `satisfies` | Types shared by server and mod (types only in the mod) | schema/profile.ts |
| `defaultShown` | `Record<ProfileSection, boolean>` (all `true` in v1) | A missing key's value; later sections may default hidden | schema/profile.ts |
| `privacyOf` | `(json: unknown) => Privacy` | Decodes stored jsonb; public only for literal `true`; total, fails closed | schema/profile.ts |
| `isShown` | `(p, s) => boolean` | `p.public && (p[s] ?? defaultShown[s])` | schema/profile.ts |
| `patchOf` | `(c: PrivacyChange) => Partial<Privacy>` | Change → jsonb patch; `show` writes `true` (normal form) | schema/profile.ts |
| `applyChange` | `(p, c) => Privacy` | `({...p, ...patchOf(c)})`: the model the SQL must match | schema/profile.ts |
| `settingsOf` | `(p, url: string \| null) => ProfileSettings` | `{isPublic, hidden, sections, url}` | schema/profile.ts |
| `profileUrlOf` | `(origin, login) => string` | `${origin}/u/${encodeURIComponent(login.toLowerCase())}` | schema/profile.ts |
| `ExportHead`, `ExportPage`, `ExportPart`, `DeleteRequest`, `Deleted` | Schemas | Export and delete wire format | schema/api.ts |
| `PlayerGone` | tagged error | The player's rows are gone | server/writer.ts |
| `headOf` | `(id) => Effect<Head, PlayerGone>` | The one head read behind `lock`, `current`, `savedBy`, `guard` | server/writer.ts |
| `lockPlayer` | `(sql, id) => Statement` | The writer's `FOR UPDATE OF s`, exported for `erase` | server/writer.ts |
| `beforeAccount` | `(occurredAt, createdAt) => boolean` | The 4A edge rule | server/edge.ts |
| `AccountAuth` | `Layer<Authentication-like>` | Token only, no allowlist | server/auth/middleware.ts |
| `playerTables` | `ReadonlyArray<{name, owner: "player_id"\|"id", columns, part: ExportPart \| null, key}>` | Delete order, exported columns (no `roll_seed`, no `token_hash`), page key; identifiers only | server/account.ts |
| `pageOf` | `(rows, budget, limit) => {rows, next: number \| string \| null}` | Takes rows while the running JSON size ≤ budget (at least one); a `reduce` | server/account.ts |
| `confirmed` | `(p: Player, login: string) => Effect<void, ConfirmMismatch>` | Case-insensitive match on `githubLogin` | server/account.ts |
| `AccountData` | service `{settings, change, head, page, erase}` | The account's SQL edge | server/account.ts |
| `AccountHandlers` | `HttpApiBuilder.group(OnlineApi, "account", …)` | Maps `PlayerGone` → 401 once; `notify` after delete | server/account.ts |
| `Html`, `html`, `raw` | brand + tagged template | Strings escaped by construction; `raw` only for compile-time constants | server/html.ts |
| `escapeHtml` | `(s) => string` | `& < > " '` | server/html.ts |
| `Sprite`, `petSprite` | Schema + value | The 14x12 pet and palette: the single source | schema/sprites.ts |
| `spriteRuns` | `(s: Sprite) => {x, y, w, color}[]` | Horizontal runs of one colour | schema/sprites.ts |
| `spriteSvg` | `(s, scale) => Html` | Static `<svg>`, `shape-rendering: crispEdges` | server/html.ts |
| `sectionHtml` | `{[S in ProfileSection]: (v) => Html}` | One renderer per section, exhaustive by type | server/html.ts |
| `profilePage`, `notFoundPage`, `pageHeaders` | `(v, canonical) => Html`, `Html`, record | The document, the one 404, the shared headers | server/html.ts |
| `Profiles.byLogin` | `(login) => Effect<Option<{player, privacy}>>` | One query, reusing `playerColumns(sql)` | server/profile.ts |
| `profileOf` | `(s: Snapshot, p: Privacy) => PublicProfile` | Allow-list: header + visible sections; never spreads the snapshot | server/profile.ts |
| `ProfilePages` | `HttpRouter.use(…"/u/:login"…)` | The route, merged into `PublicRoutes` | server/profile.ts |
| mod `printable`, `wordsOf`, `commonTextOf` | pure | Shared helpers (replace beta.ts `shown`, login.ts's two copies, each `*AskOf`'s split) | mod/hooks/server.ts |
| mod `askOnline` | `($, what, route, textOf) => Promise<string>` | Online-only check, token, request, `noteSignedOut`, text; `keepBeta` moves onto it | mod/hooks/register.tsx |
| mod `profileAskOf/RouteOf/TextOf` | `beta.ts` shapes | `/pathofdev profile …`; any section word passes to the server (6A) | mod/hooks/profile.ts |
| mod `dataAskOf` | `(args) => DataAsk \| string \| null` | `/pathofdev account export\|delete <login>` | mod/hooks/account.ts |
| mod `exportStep` | `(state, answer) => {state, write?, ask?, done?}` | The export state machine (10A) | mod/hooks/account.ts |
| mod `exportDirOf`, `keysAfterDelete` | pure | Where files go (never cwd); which per-origin keys delete forgets | mod/hooks/account.ts |

FP rules: the `html` tag, never string concatenation; a `sectionHtml` record, not a `switch`; `pageOf`, `spriteRuns`
and `exportStep` as reductions; no new module state in the mod (the export cursor lives in `exportStep`'s state).

## Test plan
Every server property runs on PGlite and Postgres through `freshDatabase` with `serverRuns`, except the
concurrency ones (11A). Extend the existing "401 on every route, writes nothing" `Endpoint` literal in
accounts.test.ts with the new endpoints.

### Coverage map
```
6a
 privacy rules (pure)     idempotent · commutes on different keys · frame · privacyOf total & fails closed
                          · patchOf/applyChange round-trip through jsonb
 privacy endpoint (9A)    MODEL: commands [two players × PrivacyChange | unknown section | GET] ─▶ after each step:
                          DB profile and answer = applyChange model; unknown ─▶ 400 listing sections, dump unchanged;
                          the other player's row untouched
                          PG-only: concurrent hides all kept (proves `profile || patch`) + reduction on both legs
 AccountAuth (1A)         removed-from-beta token: account routes answer, mod routes 401 "not in the beta"
 export                   pageOf: every page ≤ budget or one row; pages concatenate to the input
                          head encodes ≤ a fixed budget whatever the counts (13A)
                          equals own rows per playerTables projection, none of others'; no roll_seed / token_hash
                          decodes; Postgres bigint safe
                          PG-only: consistent with the head under concurrent writes + reduction
 delete                   wrong login ─▶ 400, dump unchanged (5A)
 lifecycle (9A)           MODEL: commands [play | export | delete(right/wrong login) | sign in again | privacy]
                          ─▶ export = own rows; delete removes exactly own rows, every token 401, beta_logins kept;
                          sign in again ─▶ fresh id, private, level 0, old input ids accepted as new
                          PG-only: atomic under a failing table trigger; delete during writes ─▶ only 200/401,
                          no orphans; a held stream returns and the next poll is 401 — each with a reduction
 PlayerGone (2A)          a stale CurrentPlayer on every entry (events, command, open, close, privacy, export)
                          ─▶ 401, never 500, writes nothing
 edge (4A)                no event with occurredAt < player.createdAt is admitted; others unchanged
 meta (7A)                tables with player_id ∪ {players} = playerTables; every listed column exists;
                          players exports every column but roll_seed
 mod (pure)               profileAskOf / dataAskOf total; ask ─▶ say ─▶ parse round-trip; the parsers
                          (account, beta, profile, data, server, dev) are disjoint; routes decode under the server's
                          schemas; texts printable for any answer; keysAfterDelete: only that origin, only on 2xx;
                          exportDirOf never in cwd
 exportStep (10A)         files in order; complete.json only once every part ended with next = null;
                          any interruption ─▶ no complete.json; terminates for any answer sequence
6b
 sprite                   spriteRuns/spriteSvg round-trip to the grid; viewBox and palette-only fills
 html                     escapeHtml round-trips; output inert; markup skeleton independent of user strings;
                          no <script, on…=, javascript:
 profileOf                sections drawn iff isShown; canaries in hidden sections never in the page; canaries in
                          never-shown fields (displayName, claims, commands, roll_seed, timezone) never in the page;
                          shown numbers = the snapshot's
 /u route                 public & on the list ─▶ 200 html with own numbers
                          private ≡ missing ≡ deleted ≡ recycled login ≡ bad login ≡ off the beta list ─▶ the same
                          404, byte for byte (minus Date)
                          private + newer or corrupt save ─▶ still the 404; DB down ─▶ 503 no-store
                          shows only the account holding the login now (SignIns model)
                          bytes independent of viewer headers; no Set-Cookie, no Vary on auth; no /v1 answer
                          cacheable; read-only for any method; the local build has no /u or /v1/account
```

### Justified example tests
1. The site sprite guard in `engine/test/site.test.ts`: one fixed file, no input domain.
2. The meta-test (7A): the migration set is fixed; nothing to draw.
3. Plugin glue in `pathofdev.test.ts` (`claude plugin test` has no fast-check): profile, export, delete end to end
   on `fakeServer`; signed out sends nothing; on a local server the commands say the save has none.
4. Deploy smoke: CI's image job curls `/u/nobody` (404, the constant body, `no-store`); after the 6b deploy,
   `pathof.dev/u/<public login>` is 200 and `pathof.dev/` is still the site.
No HTML snapshot test: the properties pin the shape that matters.

### Arbitraries
`StoredProfile` (junk jsonb), `PrivacyChange` (including unknown sections), `Canary` (`/^zq[a-z0-9]{10}zq$/`),
`Hostile` (markup-breaking strings, minus `\u0000` and lone surrogates for Postgres), `Grid`, `LoginPath`
(recased, empty, `..`, `%2e`, too long, non-ASCII), `ViewerHeaders`, `SignIns` + `PublicFlags` (from identity.test),
`Play` (from identity.test), `Race`, `FailingTable`.

## Failure modes
| Codepath | Failure | Test | Handling | User sees |
|---|---|---|---|---|
| Account routes after removal from the beta | locked out of own data | AccountAuth property | token-only auth (1A) | export, delete work |
| A write for a deleted player (5 entries) | 500 | PlayerGone property | `PlayerGone` → 401 (2A) | "account deleted: sign in again" |
| Another machine's old queue | XP from before the account | edge property | `before_account` (4A) | — |
| Delete vs apply in flight | race | PG-only + reduction | lock order | the next request 401 |
| Delete vs sign-in elsewhere | FK at mint | PG-only | `players FOR UPDATE`; one 500, the retry makes a fresh account | one retry |
| Delete vs a held long poll | wait on a gone head | PG-only + reduction | `notify` after commit ─▶ 401 | signed out |
| Delete answer lost or slow | the mod isn't sure | glue | atomic + timeout (14A); retry gets 401 | "not sure: run it again" |
| An unlisted per-player table | export or delete misses it | meta-test | FK error rolls back | 500 on delete (fails closed) |
| Export over 4 MiB | `$.fs.write` refuses | pageOf + head-size | parts ≤ 1 MiB, head bounded (13A) | — |
| Export during play | torn | PG-only + reduction | `upto` | — |
| Export interrupted | partial files | exportStep | no complete.json | "incomplete export in <dir>" |
| Two machines change privacy | lost update | PG-only | `profile \|\| patch` | — |
| Junk or future `profile` jsonb | a section shown | privacyOf | fails closed | 404 |
| Private + newer save | 503 tells private from missing | /u property | privacy before the snapshot | 404 |
| DB down while rendering | an error page looking like 404 | /u property | 503 no-store | "try later" |
| User strings in HTML | XSS | html properties | `html` tag + CSP, no script | — |
| Private fields on the page | leak | canary properties | `profileOf` allow-list | — |
| Renamed / recycled login | a former holder's page | SignIns model | accepted (3A), TODO | stale page until the next sign-in |
| Scraping `/u` | load | — | accepted (12A), limiter TODO | — |
| Coolify Strip Prefixes back on | every profile 404s | deploy smoke | fails closed | 404 |
No critical gaps (no row lacks a test, handling and a visible result all at once).

## Implementation order
### 6a (one PR)
1. Mod refactor, no behaviour change: `printable`, `wordsOf`, `commonTextOf` in server.ts; `askOnline` out of
   `keepBeta`; beta moves onto them. Existing tests stay green.
2. `schema/profile.ts`, the `api.ts` types, `AccountApi` on `OnlineApi`, `PlayerGone` / `ConfirmMismatch` texts.
3. `writer.ts`: `headOf` → `PlayerGone`, `lockPlayer` exported; presence maps the sessions FK; ModHandlers map
   `PlayerGone` → 401. `edge.ts`: `beforeAccount`. Their properties.
4. `auth/middleware.ts`: `AccountAuth`. Its property.
5. `server/account.ts`, pure half (`playerTables`, `pageOf`, `confirmed`) and properties; then `AccountData` and
   `AccountHandlers`, wired into `OnlineRoutes` and `publicServices`. The two model-based properties, the PG-only
   ones with reductions, the meta-test.
6. Mod `profile.ts`, `account.ts` (`exportStep`), their properties; the `register.tsx` branches; glue tests.
7. Docs: `docs/deploy.md`; `docs/privacy.md` (what is stored, export, delete, backups kept 14 days, `beta_logins`
   kept, removal from the beta doesn't delete); the `/pathofdev` help text; TODOS.md (below).
Steps 5 and 6 can run in parallel once 2 is in.

### 6b (one PR, after 6a merges)
1. `schema/sprites.ts` and the `site.test.ts` guard.
2. `server/html.ts` and its properties.
3. `server/profile.ts`, `PROFILE_ORIGIN` in the public config; its properties.
4. Fill `ProfileSettings.url`, so `/pathofdev profile` shows the link.
5. Infra (the user): add `https://pathof.dev/u` to the server app's domains in Coolify with **Strip Prefixes off**;
   deploy; run the smoke check. Fallback: `PROFILE_ORIGIN=https://u.pathof.dev` plus a Cloudflare redirect.
6. `docs/plans/online-v1.md`: record "site/ stays separate", the no-store choice and 2A's outcome; close the TODO.
Steps 1 and 2 can run in parallel.

## NOT in scope
1. Cloudflare cache rule and purge: `no-store` removes the stale-privacy window; a render is two indexed queries.
2. XP history: carried XP (0009) and prestige break "ends at state XP"; the index exists, so it is cheap later.
3. Achievements section: the engine never unlocks one.
4. Inventory, gold, looks, command names, `displayName`: leak risk for little value.
5. Sprite variants and animation: a static SVG allows a CSP with no script; variants are a TODO already.
6. Soft delete or a grace period: a `deleted_at` filter on every read; hard delete in one tx is simpler.
7. Export as a browser download: no web sign-in.
8. `ON DELETE CASCADE`: it would silently cover tables export doesn't know.
9. Export, delete and profiles on the local server: the local save is the player's own disk.
10. Removing `beta_logins` on delete: the admins' list; the answer reports it.
11. Moving `site/` into the server app: ties landing-page edits to server restarts and outages.
12. A Cloudflare rate rule on `/u/*`: the free plan's one rule is on `/v1/auth/*`.
13. OG cards, sitemap, README badge, JSON profile API.
14. Redirects for recased logins and the `api.` host: a canonical link instead.
15. Re-checking logins against GitHub (3A): nothing private leaks; it costs GitHub calls.
16. An in-process page memo (12A): no measured need.
17. Batched deletes (14A): they lose atomicity.

## TODOS.md (written in 6a)
1. **XP history on profiles.** What: a per-day XP chart, a hideable `history` section (`defaultShown: false`). Why:
   progress over time; v1 shows only where a player stands. Context: `server_events_progress` (0012) serves the
   query; `xp.granted.totalAfter` gives each local day's last value; 0009's carried XP writes no server event and
   prestige lowers the total, so the series must not claim to equal state XP. Depends on: profiles in use.
2. **Cache profile pages at Cloudflare, with purge** (replaces "Purge Cloudflare's cache when a profile changes").
   What: a cache rule on `pathof.dev/u/*` with `s-maxage=60`, plus an API purge of `pathof.dev/u/<login>` after a
   privacy change or delete commits. Why: load once traffic is real; v1 sends `no-store`. Context: needs a
   purge-scoped Cloudflare token as a server secret; ship the rule and the purge together, never the rule alone;
   a failed purge only logs. Depends on: open signup.
3. **Re-check logins against GitHub.** What: stop `/u/<login>` showing a former holder after a GitHub rename or a
   recycled login. Why: today the old row keeps the login until the new holder signs in (3A). Context: options are
   a periodic `GET /user/{id}` for public players, or showing a page only for a recent sign-in; nothing private
   leaks today. Depends on: open signup.
4. **`/u/*` in the server-side limiter** (extend the existing entry). What: per client IP on `/u/*`. Why: v1 renders
   a snapshot per view with no cache (12A). Context: trust CF-Connecting-IP only from Cloudflare's ranges, as the
   entry says. Depends on: the limiter.
Also: mark "Decide where the landing page lives" decided (separate).

## Diagrams (8A checklist: each updated in the PR that touches it)
6a:
- `server/auth/middleware.ts`: the token-only `AccountAuth` branch beside `BearerAuth`.
- `server/edge.ts`: the admit branches with `before_account`.
- `server/writer.ts`: `headOf` → `PlayerGone`; the lock delete shares.
- `server/presence.ts`: `PlayerGone` on guard and the sessions insert.
- `server/public.ts`: the request path with `/v1/account/*`.
- `server/account.ts` (new): export head/parts/`upto`; delete lock order and table order; privacy `||`.
- `schema/profile.ts` (new): privacy evaluation (`public`, then the key, then `defaultShown`).
- `mod/hooks/account.ts` (new): the `exportStep` states; what delete forgets.
6b:
- `server/public.ts`: `/u/:login` in the request path.
- `server/profile.ts` (new): the branches to the one 404; privacy checked before the snapshot.
- `server/html.ts` (new): the `Html` brand (strings escaped, `Html` passes, `raw` only for constants).
- `docs/plans/online-v1.md`: cache line and decision 2A.
Stale already (fix when touched): `players.ts` ~16, `local.ts` single-player comments, `hub.ts` ~5.

## As built (6a)
Where the code differs from the plan above, and why:
- `POST /v1/account/profile` takes `{kind, section?}` flat (`ProfileChangeRequest`), and `changeOf` checks the section
  in the handler, so an unknown one gets a 400 (`InvalidSection`) whose message lists the sections, not the HttpApi's
  generic decode error.
- `before_account` applied only to GitHub accounts (`githubUserId !== null`), with the same 5-minute slack as a future
  event. The local save is never deleted, so a queue filled before its first start still counts. Without the slack, a
  client clock a minute behind would lose its first minute of play after sign-in. (Removed since: see the follow-up.)
- `Presence.close` runs the guard before it looks for the session, so a close for a deleted player is a 401 like every
  other route (it used to answer `closed: false` for an unknown session before any read of the player).
- `Players.snapshot` and `streamAfter` answer `PlayerGone` too, not only the writer's reads: the held poll a delete
  wakes reads the stream next.
- A 401 on delete makes the mod forget the token only. A 5xx (a gateway's 502/504 may follow a commit) or no answer
  keeps everything, and says "not sure".
- The export's head lists each part with its `rows` and `upto` (null for `sessions`), so the mod's `exportStep` sends
  back whatever the head says, without knowing which counter bounds which part. Page cursors are strings
  (`next`), and the server reads them by the part's key type (`cursorOf`, 400 `InvalidCursor` otherwise).
- Delete's statement timeout is `SET LOCAL statement_timeout = '60s'`, and covers lock waits.
- Plugin version 0.3.0.

## Follow-up: the queue's owner (0.3.1)
4A moved into the mod, and the server's `before_account` rule is gone (`isBeforeAccount`, `admit`'s `since`, the
literal in `EventResult.reason`). Why:
- It lost a new player's first work: what they queued signed out more than 5 minutes before their first sign-in was
  older than the account, so it was turned away.
- It didn't cover a queue kept across a logout: signing in as another GitHub account sent account A's queue to B.

Now the mod keeps the player id a sign-in answers under `player@<origin>`, and `queueAfterSignIn` (login.ts) decides
at each sign-in, before `connect` flushes: no owner stored (a first sign-in here, or a store from before 0.3.1) or the
same id keeps the queue; another id (another account, or the account deleted and made again) drops the queue, through
`changeQueue`, and `explored@<origin>`. `signInOf` turns an answer without a printable player id away as unexpected. A
delete forgets `player@<origin>` too (only the owner it was sent for, like the token), so the next sign-in there is a
first one, with an empty queue. Another machine's old queue meets the same check when that machine signs in again: its
stored owner is the deleted account's id.

From the review of #37:
- A mod from before 0.3.1 kept no owner. Each snapshot now teaches the mod its player when none is stored
  (`learnOwner`, from `character.playerId`), so a machine signed in on 0.3.0 learns its owner at its first connect.
- A flush reads its batch before its token. A sign-in that drops the queue moves `ownerEpoch` on, and `call` refuses
  to send a batch read before it, so the last player's events never go with the new player's token. A server switch
  doesn't count (`generation` is separate): a batch that set out for a server still goes there.
- `/pathofdev login` refuses while a token the server takes is held, so a queue is dropped only once the last
  player's token is dead: none of it could have gone anyway.
- Mods older than 0.3.1 lose the server's `before_account` check. In the closed beta that is only the owner's own
  machines.
- Plugin version 0.3.1.
