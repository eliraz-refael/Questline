# Path of Dev

An RPG layer for your coding sessions with Claude Code. Every prompt you type is graded on seven qualities, from
clarity to done criteria, and the grade earns XP, levels and loot. A pixel-art pet keeps you company in the terminal,
and quests point you at better habits. Real outcomes pay the big bonuses: a merged pull request is worth 250 XP, an
opened one nothing, and only work confirmed on GitHub ranks.

> **Status:** early development. Nothing is playable yet.

## How it fits together

- **The mod** is a thin Claude Code plugin. It reports what happened in a session (a turn finished, tests went
  green, a PR merged) and draws the band, the pane and the pet. It never computes a score.
- **The server** owns the rules: XP, levels, loot rolls, quests and the event log. The same build runs locally
  for solo play, over a Unix socket with an embedded Postgres ([PGlite](https://pglite.dev)), or as the public
  server on Postgres, with GitHub sign-in and leaderboards.

## Packages

| Package | What it holds |
| --- | --- |
| [`@pathofdev/schema`](packages/schema) | The wire format: [Effect Schema](https://effect.website) definitions for every API object, event and command |
| [`@pathofdev/engine`](packages/engine) | The rules engine: pure functions, no I/O, no clock, no randomness of its own |
| [`@pathofdev/server`](packages/server) | The game server: the HTTP API, the write path and storage around the rules engine |
| [`@pathofdev/mod`](packages/mod) | The Claude Code mod: grades prompts, reports work to the server and draws the band |

The landing page for [pathof.dev](https://pathof.dev) lives in [`site/`](site): one static HTML file, no build step.

Path of Dev was called Questline. The local server moves a save from `~/.questline` to `~/.pathofdev` (and
`~/.questline-dev` to `~/.pathofdev-dev`) on its first start, and `/questline`, `QUESTLINE_DEV` and `QUESTLINE_HOME`
still work for now.

## Development

Needs Node 22.12+ and pnpm.

```sh
pnpm install
pnpm typecheck   # packages and tests
pnpm test
pnpm build       # emits dist/ for each package
```

## License

[MIT](LICENSE)
