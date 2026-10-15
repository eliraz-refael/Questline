# Deploying the public server

The public server is `packages/server/src/public-main.ts`, built into an image by the [`Dockerfile`](../Dockerfile)
at the repo root. What is automated:

- **CI** (`image` job) builds the image on every pull request and push, boots it against Postgres 18, and checks
  `/healthz` answers 200 and `POST /v1/events` without a token answers 401.
- **Deploys** (`deploy` job) run on a push to `main` once `ci`, `postgres` and `image` pass: CI calls Coolify's deploy
  webhook. Coolify's own auto-deploy stays off, so nothing reaches production without passing CI. The job skips (and
  passes) until its secrets are set.
- **Restore drill** (`.github/workflows/restore-drill.yml`) runs on the 1st of every month and on demand: it restores
  the newest backup from R2 into Postgres 18, boots the server on it (which migrates it) and checks no rows were
  lost. It skips (and passes) until its secrets are set.

The server reads its settings from the environment at boot, and stops naming the first one that is missing or bad:

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | The Postgres URL. Migrations run at every boot. |
| `ALLOWED_LOGINS` | yes | The beta's GitHub logins, separated by commas or spaces, in any case. |
| `GITHUB_CLIENT_SECRET` | yes | The OAuth app's client secret: the server checks every sign-in's token was issued to the app. |
| `GITHUB_CLIENT_ID` | no | The OAuth app's client id; defaults to Path of Dev's, `Ov23liaxznq5Qln0tRis`. |
| `PORT` | no | Defaults to 3000. |

## What is left to do by hand

Each step is done once, in Coolify, Cloudflare or GitHub. The Postgres resource `pathofdev-db` (postgres:18-alpine,
on the `coolify` network) already exists.

### 1. The OAuth app's client secret

1. GitHub → Settings → Developer settings → OAuth Apps → Path of Dev (client id `Ov23liaxznq5Qln0tRis`).
2. Generate a new client secret and copy it: GitHub shows it once. It becomes `GITHUB_CLIENT_SECRET` below.
3. Keep "Enable Device Flow" on: the mod signs in with it.

### 2. The Coolify app

1. New resource in the project that holds `pathofdev-db`, on the same server: the GitHub repository
   `eliraz-refael/path-of-dev`, branch `main`.
2. Build pack **Dockerfile**, base directory `/`, Dockerfile location `/Dockerfile`. Ports exposes: `3000`.
3. Domain: `https://api.pathof.dev`.
4. **Auto deploy: off** (the app's Advanced settings). CI's webhook deploys instead.
5. **One replica.** The stream hub lives in the process (TODOS.md, "Postgres-backed stream hub"), so a second
   instance would deliver other instances' events late.
6. Health check: enable it, path `/healthz`, port `3000`. The image declares the same check.
7. Environment variables, none of them build variables (untick "Build Variable", so they never reach the image):
   - `DATABASE_URL`: `pathofdev-db`'s **internal** URL, from its page in Coolify.
   - `ALLOWED_LOGINS`: for example `eliraz-refael`.
   - `GITHUB_CLIENT_SECRET`: the secret from step 1.
8. Deploy once by hand, then check `https://api.pathof.dev/healthz` answers `ok` (after the DNS step).
9. Copy the app's deploy webhook URL (Webhooks), and create an API token with deploy permission (Keys & Tokens →
   API tokens), for the repo secrets below.

### 3. DNS and Cloudflare

1. An `A` record `api` → `159.195.10.36`, **proxied**, with the same SSL/TLS mode as `pathof.dev`.
2. A rate limiting rule (Security → WAF → Rate limiting rules) on
   `(http.host eq "api.pathof.dev" and starts_with(http.request.uri.path, "/v1/auth/"))`, counted per IP, blocking
   when exceeded. On the Free plan the period and the block are 10 seconds: 5 requests per 10 seconds is plenty for
   sign-ins.
3. Bot Fight Mode challenges clients that aren't browsers, and the mod is one. With Super Bot Fight Mode (Pro and up),
   add a custom rule `http.host eq "api.pathof.dev"` → Skip → all Super Bot Fight Mode rules. On the Free plan Bot
   Fight Mode can't be skipped per host: leave it off for the zone.
4. Nothing on the API is cached: Cloudflare caches no JSON by default, so no cache rule is needed. The stream holds a
   request for at most 25 seconds, well under Cloudflare's 100.

### 4. Backups to R2

1. Cloudflare → R2: create a bucket, for example `pathofdev-backups`.
2. R2 → Manage API tokens: a token with **Object Read & Write** on that bucket, for Coolify. Note its access key id,
   secret and the S3 endpoint `https://<account id>.r2.cloudflarestorage.com`.
3. A second token with **Object Read** only on the bucket, for the restore drill.
4. Coolify → S3 Storages: add the bucket with the first token (region `auto`), and validate it.
5. `pathofdev-db` → Backups: a scheduled backup, daily (for example `0 3 * * *`), saved to that S3 storage, keeping
   14 backups.

### 5. The repo's secrets

```sh
gh secret set COOLIFY_WEBHOOK       # the deploy webhook URL from step 2.9
gh secret set COOLIFY_TOKEN         # the Coolify API token from step 2.9
gh secret set R2_ACCESS_KEY_ID      # the read-only token from step 4.3
gh secret set R2_SECRET_ACCESS_KEY
gh secret set R2_ENDPOINT           # https://<account id>.r2.cloudflarestorage.com
gh secret set R2_BUCKET             # pathofdev-backups
```

Then run the drill once by hand, after the first backup exists: `gh workflow run restore-drill.yml`.

### Later (PR 6)

The `pathof.dev/u` profile routing (Traefik `PathPrefix(/u)` to this app, or `u.pathof.dev`) comes with profiles.
