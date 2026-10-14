# TODOs

Work deferred from the plan for Path of Dev online v1 (the closed beta), reviewed on 2026-10-13. Each entry says what
the work is, why it matters, where things stand and what it waits on.

## Before opening signup

### Server-side rate limiter

- **What:** a token-bucket limiter in the public server, keyed per client IP on `/v1/auth/*` and `/u/*`, and per
  player token on `/v1/events` and `/v1/commands`, answering 429 with the existing `ApiError.retryAfterMs`.
- **Why:** the closed beta leans on the `ALLOWED_LOGINS` allowlist and one Cloudflare rate rule on
  `api.pathof.dev/v1/auth/*`. With open signup anyone can create a player and flood writes or profile renders, and one
  Cloudflare rule can't tell players apart.
- **Context:** keep the decision pure: `take(rule, bucket, now) => { allowed, bucket, retryAfterMs }` plus
  `prune(buckets, now, rule)`, held in a `Ref` and wrapped by a `RateLimiter.check(key, rule)` service. The client IP
  comes from a pure `clientIpOf(trust, headers, remote)`: trust `CF-Connecting-IP` only when the peer is in
  Cloudflare's published ranges (configure Traefik's `trustedIPs` to match), otherwise use the socket address. Never
  take the leftmost `X-Forwarded-For` entry, which the client controls. Properties: the number allowed in any window is
  at most capacity plus refill × window; a forged header from an untrusted peer never changes the key.
- **Depends on:** the public server entry (PR 5).

### Open signup

- **What:** drop the `ALLOWED_LOGINS` check from sign-in and from `BearerAuth`, and add a per-player cap on events per
  minute.
- **Why:** to let anyone play once abuse and growth are bounded.
- **Context:** the allowlist is checked in two places on purpose (sign-in and every request), so removing someone locks
  them out at once. Opening up removes both checks. Publish the privacy note (what's stored, export, delete, the game
  token at rest in the mod's `$.store`) before opening.
- **Depends on:** the server-side rate limiter; export and delete (PR 6).

## Known gaps from the review

### Dev mode out of the production build

- **What:** make dev mode impossible in the public build, not just switched off: the public entry should not wire the
  dev command handlers at all, or the build should leave them out.
- **Why:** today the public server forces `DevMode` off and the engine refuses dev commands without it, but the code
  paths still ship in production, one config mistake away from being reachable.
- **Context:** PR 5 adds a property that a public build refuses every dev command. Dev commands live in the engine
  (refused without dev mode, even in a replay) and in the server's command routing. `PATHOFDEV_DEV=1` only selects the
  local dev home. Decide between a separate command group the public entry never mounts, and removing dev mode from the
  server package into a local-only module.
- **Depends on:** the public server entry (PR 5).

### Turn away strings Postgres can't store

- **What:** have the edge reject (as `invalid`) an event or command holding a string with a NUL character or a lone
  UTF-16 surrogate, before the write path sees it.
- **Why:** `jsonb` stores neither, so such an input fails its whole write with a 500, on PGlite and Postgres alike. A
  command is answered 500; an event fails its batch, and the mod keeps the whole queue on a 5xx, so one bad string
  would hold every later event back for good.
- **Context:** found by PR 5's dev-command property, which draws arbitrary strings; it skips those for now. A check on
  the decoded input's JSON (`\u0000`, or `\ud800`-`\udfff` not in a pair) is enough; names already have patterns.
- **Depends on:** nothing.

### Change a session and log its event in one transaction

- **What:** in `presence.ts`, opening, closing and lapsing a session should change the `sessions` row and log its
  `session.*` event in one transaction, with the version guard inside it.
- **Why:** today `writer.guard` runs first, then the `sessions` change commits, then `apply` logs the event. If a newer
  build writes the player in between (a deploy rolling out), the event fails with `ServerBehind` after the row has
  committed: a new session is kept but `session.opened` is never logged, and the mod's retry finds it already heard.
- **Context:** wrapping both in one outer transaction nests `apply`'s, so `StreamHub.notify` would fire before the real
  commit and wake waiters early. Notify has to move after the outer commit. Found in the review of PR #32; a single
  replica makes the window small.

### Purge Cloudflare's cache when a profile changes

- **What:** when a player hides a section, makes their profile private or deletes their account, purge
  `pathof.dev/u/<login>` from Cloudflare's cache through its API.
- **Why:** profile pages are cached for 60 seconds (`s-maxage=60`), so a hidden section or a deleted account can still
  be served for up to a minute, without any sign of it.
- **Context:** needs a Cloudflare API token scoped to cache purge on the pathof.dev zone, stored as a server secret.
  Purge after the settings transaction commits; a failed purge only logs, because the TTL still bounds staleness.
- **Depends on:** profiles and account settings (PR 6).

### Decide where the landing page lives

- **What:** decide whether `site/` stays its own static Coolify app beside the server's `pathof.dev/u` route, or moves
  into the server app so one app owns `pathof.dev`.
- **Why:** two apps share the apex today through Traefik path routing (the server takes `PathPrefix(/u)`). If profile
  pages need the site's styles, navigation or shared assets, keeping them in two apps gets awkward.
- **Context:** the plan picked `pathof.dev/u/:login` with a routing spike in PR 5 and `u.pathof.dev` as the fallback.
  Moving the site into the server ties landing-page deploys to server deploys, but gives one origin and one template.
- **Depends on:** the `/u` routing spike (PR 5). Decide before designing the profile page in PR 6.

## Later features

### Link a local save to an online account

- **What:** import a local save into the player's online account.
- **Why:** the design doc (2026-10-12) says players can link their local save when accounts arrive. v1 starts every
  online character fresh, since the only player today is the developer.
- **Context:** what carries over is still an open question in the design doc. Local logs name repos, so an import has
  to rewrite every subject into the private form, and an editable local save needs an anti-cheat policy (carry it over
  as reported XP only?). Entries marked `dev` are already labelled so an import can drop them.
- **Depends on:** a decision on what carries over.

### Postgres-backed stream hub

- **What:** a `StreamHub` implementation over Postgres `pg_notify`, sent after commit, so stream wakeups reach every
  instance.
- **Why:** v1 runs a single replica, and `StreamHub` is in-process. A second instance would see other instances'
  writes only when a long-poll times out (at most 25 seconds), never instantly.
- **Context:** keep the `StreamHub` interface, so the Postgres hub drops in without touching handlers. `server_events`
  stays the source of truth; a missed notify only delays. Pin Coolify to 1 replica until then.
- **Depends on:** needing a second instance.

### Named public subjects and the verifier

- **What:** send the named form (`type: "github"`) for repos confirmed public through the GitHub API, and build the
  verifier that resolves claims into verified XP.
- **Why:** in v1 the online server always gets the private form, so nothing is verifiable and nothing can rank.
  Leaderboards need verified XP.
- **Context:** the design doc's verification section describes a polling worker with ETags and claims that expire
  after 30 days. `ClaimDraft` and claims are stubbed in the engine and the writer. The mod's `repoOf` names any
  github.com remote today. The online target overrides that through `subjectFormOf`.
- **Depends on:** the public server; a GitHub App installation token for the API.

### Species sprites, with the mod drawing pixels from the server

- **What:** pixel art for the starter species and their evolution forms, served as data so the website and the mod
  draw the same pixels.
- **Why:** v1 draws the landing page's single 14x12 sprite for every pet. The design doc wants "the pet looks
  identical everywhere", and the mod hard-codes no art.
- **Context:** `schema/sprites.ts` is the source (site copy checked by `site.test.ts`). The mod imports only types from
  schema, so it has to receive pixel data in the snapshot or catalogue rather than importing it. Art is an open
  question in the design doc (commissioned or generated).
- **Depends on:** the art decision.

### Open Graph cards and a sitemap for profiles

- **What:** per-profile Open Graph images and tags, and a sitemap of public profiles.
- **Why:** shared profile links render as bare URLs today.
- **Context:** profiles are server-rendered HTML from `profilePage`, so the tags go in that template. A card image can
  reuse `spriteSvg`.
- **Depends on:** profiles in use.

### Token expiry and a devices list

- **What:** expire game tokens after a period without use, and list a player's signed-in devices so they can revoke
  one.
- **Why:** v1 tokens never expire, and logout revokes only the current device's token.
- **Context:** v1's `api_tokens` has `(token_hash, player_id, created_at)` only, with no `last_used_at`, so nothing is
  written per request. Add `last_used_at` (written at most hourly) and a label when this lands.
- **Depends on:** the accounts work (PR 4).
