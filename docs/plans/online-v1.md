# Plan: Path of Dev online, v1 (closed beta) — final, after /review-plan-deep (2026-10-13)

Planned against main at 3696a0d. Source: the Path of Dev game design doc (kept outside the repo). Deferred work:
TODOS.md at the repo root. File and line references are as of that commit.

## Goal
Run Path of Dev as an online multiplayer closed beta: a Postgres-backed public server at https://api.pathof.dev (the
SAME server build as local), reached by the mod over HTTPS after GitHub device-flow sign-in, with read-only public
profiles at pathof.dev/u/:login, deployed on Coolify behind CI. Local PGlite play stays unchanged.

## Confirmed product decisions
- Closed beta: ALLOWED_LOGINS allowlist, checked at sign-in AND on every request (BearerAuth). One Cloudflare rate rule
  on api.pathof.dev/v1/auth/*. Server-side limiter deferred (TODOS).
- Online starts fresh at level 0; no local-save linking (TODOS).
- Profiles private by default (`/pathofdev profile public|private|hide <section>`); a missing section key = shown.
- Export + delete ship in v1.

## Facts found in the code (drive the design)
- http.ts:35 reads CurrentPlayer ONCE when the handler group is built -> every request = first player. Fix: per-request
  HttpApiMiddleware (`Authentication`, provides CurrentPlayer). Move CurrentPlayer + Authentication class to schema
  (avoids a schema<->server cycle).
- players.ts `local` = oldest player (ORDER BY created_at LIMIT 1); must never be wired in the public build.
- mod/hooks/observe.ts `repoOf` names ANY github.com remote (private repos too) -> online target must send the private
  form for every subject (`subjectFormOf("online") = "private"`).
- Mod $.store keys `queue`/`explored`/cursor are shared across servers -> per-target keys (`storeKey(target, name)`,
  default target keeps the old keys).
- The mod imports only TYPES from @pathofdev/schema (devDependency). No runtime sharing via schema.
- Time zone: server default is UTC -> sign-in carries the mod's timezone.
- writer.ts:208 writes engine_version unconditionally; migrations 0009/0010 reshape state jsonb -> version guard.
- register.tsx:240 keeps queued events only for reason 'unknown_type'; 5xx keeps the whole queue.
- Effect 4 `Random` default is Math.random; `Random.withSeed(s)` uses ISAAC CSPRNG.
- Site numbers are stale: level curve is now 100*L^1.66 (path should read 4,570 / 20,920 / 66,113 / 129,599 /
  208,929; band demo Lv7 2,528 -> 3,155).
- @effect/sql-pg@4.0.0 exists on npm (may need --registry=https://registry.npmjs.org; the user npmrc points at a mirror).

## Review decisions (issue -> choice)
1A mod runs the GitHub device flow directly (client_id only); server has ONE endpoint POST /v1/auth/github
   {githubToken, timezone}: GitHub's app token check (ours? whose?) -> allowlist -> findOrCreate -> mint game token;
   GitHub token discarded.
2A profiles at pathof.dev/u via Traefik PathPrefix(/u) (Coolify strip-prefix OFF), spike in PR5, fallback u.pathof.dev.
   Open: maybe move site/ into the server app later.
3A Coolify Postgres daily backups to Cloudflare R2, keep 14.
4A game token stored in mod $.store; never log Authorization; logout revokes; document in privacy note.
5A schema/sprites.ts = sprite source (the landing-page 14x12 pet); site copy guarded by site.test.ts; mod later gets
   pixels from the server snapshot/catalog.
6A keep DevMode; `Players.layer(prefix)` with prefix "local" | "online" (serverIdOf). Public build must refuse every dev
   command (property). TODO: dev mode out of the prod build.
7B isolation test = for interleaved two-player runs: each player's event_log holds exactly their input ids AND
   replay(own log, own roll seed from DB) == saved player_state. PLUS move roll seeds and ids (players.ts:82,84,
   writer.ts:232, presence.ts:81) to Effect `Random`, seeded once from node crypto at boot; game tokens stay on
   node:crypto.
8A allowlist check in BearerAuth on every request too (401 "not in the beta").
9A mod decodes GitHub JSON with pure total decoders (never throw) + 6 recorded GitHub fixtures in mod tests.
10A writer version guard: row.engine_version > ours -> fail request with 503 + Retry-After (no new status, no mod change).
11A new packages/mod/test with fast-check properties; `effect` as mod devDependency only.
12A monthly GitHub Action: pull latest R2 dump, restore into Postgres container, migrate, check row counts.
13A migration 0011 adds partial index server_events (player_id, at) WHERE type IN ('xp.granted','level.up').
14A api_tokens(token_hash PK, player_id, created_at) — no last_used_at.

## Architecture
```
mod (server=online, queue:online, token:online) --HTTPS+Bearer--> Cloudflare --> Traefik
  api.pathof.dev  -> public server (same build) -> Postgres 18 (Coolify) -> R2 daily
  pathof.dev/u/*  -> public server (profiles, s-maxage=60, CF cache rule)
  pathof.dev/*    -> static site/ (nginx)
mod --device flow--> github.com (client_id only) ; server --POST /applications/{client_id}/token--> api.github.com
local: mod --Unix socket--> local server (PGlite), unchanged
```
```
EVENT: hook -> event (private form when online) -> queue:<target> -> requestOf(target) -> Authentication
  401 -> signed out, queue kept | 5xx/503 -> offline, queue kept | ok -> admit -> PlayerWriter.apply
  apply: version guard(503) | dup input_id | dup natural_key | quarantine | commit -> StreamHub.notify
PROFILE: byLogin -> (none|private -> identical 404) -> snapshot(project) + xpDays + levelUps -> profileOf
  -> redact(privacy) -> profilePage(escapeHtml, spriteSvg)
```
Dependencies: schema <- engine <- server <- (local-main | public-main); mod -> schema (types only). No cycles.

## Components
- Reused unchanged: engine step/project/derive, edge.admit, writer.apply (+guard), hub, presence, quest-packs,
  migrations 0001-0010, subjects.ts private form.
- Generalized: local.ts services() -> services.ts core(database, stepper); players.ts create(NewPlayer),
  findOrCreate, relogin, Players.layer(prefix); http.ts per-request CurrentPlayer; schema http-api.ts
  (+Authentication, CurrentPlayer, AuthApi, AccountApi, ProfileApi); mod server.ts (Target, requestOf, headersOf,
  failureOf, storeKey), observe.ts (subjectFormOf), register.tsx (per-target keys, 401 -> signed out).
- New: db.ts (sqlLayer pglite|postgres), public.ts + public-main.ts (publicConfigOf, /healthz), auth/{github,tokens,
  middleware,routes}.ts, account.ts (export, delete across 8 tables, privacy), profile/{read,view,html}.ts,
  schema/sprites.ts, migration 0011_accounts (api_tokens, players.profile jsonb, unique lower(github_login),
  partial index), Dockerfile (pnpm deploy --prod), CI jobs, mod/hooks/login.ts.

## Implementation order (PRs)
0  Site numbers + guard (site/index.html, site.test.ts)                         [parallel]
1  Postgres parity: @effect/sql-pg, db.ts, services.ts core, Effect Random (7B), fixture DB switch
   (PATHOFDEV_TEST_DATABASE_URL), CI matrix pglite|postgres:18, per-file schema, 0009/0010 on PG with rows [parallel]
3  Mod transport: Target/requestOf/headersOf, per-target store keys, subjectFormOf, option server=online + url,
   packages/mod/test properties; prove $.http.fetch over HTTPS with headers         [parallel with 1-2]
2  Per-request identity: Authentication + CurrentPlayer in schema, LocalAuth, handlers read per request,
   Players.layer(prefix), findOrCreate/NewPlayer, isolation property (via HttpRouter.toWebHandler)
4  Accounts: 0011, POST /v1/auth/github, tokens (pod_ + base64url, sha256), BearerAuth + allowlist, relogin,
   mod /pathofdev login|logout (direct device flow, pure decoders, nextPoll)
5  Public entry + deploy: public.ts/public-main.ts, /healthz, writer guard -> 503, dev-command refusal property,
   Dockerfile, CI image smoke + deploy job (Coolify auto-deploy OFF, webhook), Coolify app + Postgres + R2 backups,
   monthly restore workflow, Cloudflare: proxied api record + rate rule /v1/auth/* + Bot Fight skip, /u routing spike,
   single replica
6  Account + profiles: export/delete, privacy endpoint + mod command, profile read/view/html, sprite, xp history,
   CF cache rule

## Test plan (properties, prop.prop / it.effect.prop with Effect FastCheck)
config round-trip / missing var named / mode total; migrate twice = once; whole suite on PGlite and Postgres;
Random: same seed => same ids/seeds, two boots differ; bad header on any endpoint => 401 + 0 rows; allowlist
membership case-insensitive; /v1/auth/github non-200 from GitHub => 401, nothing created; findOrCreate idempotent,
rename keeps player, injective, reused login cleared on old row; tokens codec round-trip, no plaintext in DB,
exact-only, revoke final; ISOLATION (7B); version guard => 503 + 0 rows; public build refuses all dev commands;
export ⊇ own rows, ∩ others = ∅; delete removes own rows only; redact hidden => absent, monotone, canaries never
leak; private vs missing profile => byte-identical 404; escapeHtml inverts, user strings can't change markup;
history ends at state XP, non-decreasing, buckets sum; sprite round-trip; site numbers = rules; mod: target total,
token only over https and only to its origin, queue per target, online payloads have no repo names, 401 never drops
an event, nextPoll interval monotone / terminal absorbing / no poll after expiry, GitHub decoders total.
Example tests (justified): 6 GitHub fixtures; concurrent first sign-in (PG leg only); image smoke (/healthz 200,
/v1/events no token => 401); monthly restore drill.

## Failure modes
Critical gaps: 0. Accepted risk: profile cache can serve a just-hidden section for <= 60 s (purge is a TODO).
Visible-not-silent: VPS disk full -> band offline.

## Diagrams to embed in code
public.ts (wiring + request path), auth/routes.ts (/v1/auth/github exchange), auth/middleware.ts (token branches +
allowlist), writer.ts (apply branches + version guard), profile/view.ts (privacy boundary), mod/hooks/login.ts
(device-flow state machine), mod/hooks/server.ts (target choice, 401/503/offline). Fix stale: players.ts:16,
local.ts single-player comments, hub.ts:5, site level path.

## Unresolved (user deferred)
- Where site/ lives (own app vs inside the server app) — decide before PR 6's page design.
- Dev mode in the prod build — config-off in v1; TODO to remove.
