# Questline

An RPG layer for your coding sessions with Claude Code. Your work earns XP, levels and loot, a pixel-art pet keeps
you company in the terminal, and quests point you at things worth doing. Outcomes count more than activity: a
merged pull request is worth more than an opened one, and only work confirmed on GitHub ranks.

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
| [`@questline/schema`](packages/schema) | The wire format: [Effect Schema](https://effect.website) definitions for every API object, event and command |
| [`@questline/engine`](packages/engine) | The rules engine: pure functions, no I/O, no clock, no randomness of its own |

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
