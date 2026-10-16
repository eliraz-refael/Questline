# What the online server keeps, and how to get it out or delete it

This covers the public server at `https://api.pathof.dev`. If you play on your own local save (the default), every
row below stays on your own disk, under `~/.pathofdev`, and nothing here applies.

## What is kept

When you sign in with `/pathofdev login`, the server asks GitHub once who you are. It keeps nothing of the GitHub
token, only your GitHub user id and login. One account per GitHub account:

| Table | What it holds |
| --- | --- |
| `players` | Your GitHub user id and login, your name on GitHub (or your login), when the account was made, your profile's privacy, and the seed your loot is rolled from |
| `player_state` | Your save: character, level, XP, pet, items, gold, missions, streak and stats |
| `event_log` | Everything the mod sent that the server took: each event and command, when it came, and what the game made of it |
| `server_events` | What the game sent back: XP, level-ups, drops, mission progress |
| `rolls` | Each loot roll and what it drew |
| `quarantine` | Any event the game failed on, kept to look into |
| `sessions` | Each Claude Code session the mod kept live: when it opened, was last heard from, and closed |
| `api_tokens` | A hash of each game token the mod holds, and when it was made. The hash signs nobody in |

The mod never sends a prompt's text, only Haiku's grades for it. It never sends a repo's name either, only opaque keys.
Slash-command names are counted in your stats.

## Your profile

Your profile is private until you make it public:

```text
/pathofdev profile                  # what it shows, and the sections there are
/pathofdev profile public           # anyone can see it
/pathofdev profile private          # nobody can
/pathofdev profile hide <section>   # leave a section out: pet, streak or stats
/pathofdev profile show <section>
```

A public profile shows your login, character name, level, title and XP, plus each section you haven't hidden. It never
shows your name on GitHub, your stats' command names, your items or your gold. The pages at `pathof.dev/u/<login>` go
live in a coming release; until then the setting only says what they will show.

## Export

```text
/pathofdev account export
```

The export writes everything above that is yours to files under `~/.pathofdev/exports/<login>-<time>/`, or under
`$PATHOFDEV_HOME/exports/` when that is set:

- `head.json`: your `players` row, your save, when each token was made, and how many rows each part has.
- One file per page of each part: `events-0001.json`, `serverEvents-0001.json`, and so on. A page holds at most a
  mebibyte.
- `complete.json`, written last. An export without it stopped part way; run it again.

Two things are left out: the loot seed, which would let anyone predict your drops, and the token hashes.

## Delete

```text
/pathofdev account delete <your-github-login>
```

This deletes every row of yours from the tables above, in one transaction, so it either all goes or none of it does.
Your tokens stop working, and the mod forgets its token, its queue and its explored repos for that server. Typing your
login is how the server knows you mean it. A wrong login deletes nothing.

What stays:

- **The beta list.** The admins keep it, so if your login is on it you can sign in again. That makes a new, empty
  account.
- **Backups.** The database is backed up daily, and each backup is kept for 14 days. A deleted account is gone from
  every backup within 14 days.

You can export, and delete, even after the admins take you off the beta, as long as the mod is still signed in.
Being taken off the beta deletes nothing.
