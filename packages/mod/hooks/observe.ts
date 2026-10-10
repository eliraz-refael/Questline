import type { CheckoutRef, CommitRef, RepoRef, WorkRef } from '@questline/schema'
import { hmac } from './ids'

// What the mod reads off the work around it: which repo a session is in, and what a Bash call did. It only ever
// names a repo it can tell is on GitHub; anything else goes as opaque keys, so no path or remote leaves the machine.

/** The session's repo: named when its remote is on GitHub, else known only by its remote or folder. */
export type Repo = { kind: 'github'; name: string } | { kind: 'other'; id: string }

const githubRemote = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/

/** The repo a `git remote get-url origin` output names, or null when it isn't a GitHub remote. */
export const githubName = (remote: string): string | null => githubRemote.exec(remote.trim())?.[1] ?? null

export const repoOf = (remote: string | null, folder: string): Repo => {
  const name = remote === null ? null : githubName(remote)
  return name === null ? { kind: 'other', id: remote?.trim() || folder } : { kind: 'github', name }
}

/** The keys a subject carries: one over the repo alone, one over the repo and the subject's own fields. */
const keys = async (secret: string, repo: Repo, fields: string) => {
  const id = repo.kind === 'github' ? repo.name : repo.id
  return { repoKey: await hmac(secret, `repo|${id}`), key: await hmac(secret, `${fields}|${id}`) }
}

export const repoRef = async (secret: string, repo: Repo): Promise<RepoRef> => {
  const { repoKey, key } = await keys(secret, repo, 'repo')
  return repo.kind === 'github' ? { type: 'github', repo: repo.name, key } : { type: 'private', repo: repoKey, key }
}

export const commitRef = async (secret: string, repo: Repo, sha: string): Promise<CommitRef> => {
  const { repoKey, key } = await keys(secret, repo, `commit|${sha}`)
  return repo.kind === 'github' ? { type: 'github', repo: repo.name, sha, key } : { type: 'private', repo: repoKey, key }
}

export const workRef = async (secret: string, repo: Repo, number: number): Promise<WorkRef> => {
  const { repoKey, key } = await keys(secret, repo, `work|${number}`)
  return repo.kind === 'github' ? { type: 'github', repo: repo.name, number, key } : { type: 'private', repo: repoKey, key }
}

export const checkoutRef = async (secret: string, repo: Repo, branch: string | null): Promise<CheckoutRef> => {
  const { repoKey, key } = await keys(secret, repo, `checkout|${branch ?? ''}`)
  return repo.kind === 'github'
    ? { type: 'github', repo: repo.name, branch, headSha: null, key }
    : { type: 'private', repo: repoKey, key }
}

// A test command, as people type it: a runner on its own or behind a package manager.
const runners: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/, 'npm'],
  [/\b(?:npx\s+|pnpm\s+(?:exec\s+)?)?vitest\b/, 'vitest'],
  [/\b(?:npx\s+)?jest\b/, 'jest'],
  [/\bpytest\b|\bpython3?\s+-m\s+pytest\b/, 'pytest'],
  [/\bgo\s+test\b/, 'go'],
  [/\bcargo\s+(?:test|nextest)\b/, 'cargo'],
  [/\bmix\s+test\b/, 'mix'],
  [/\b(?:bundle\s+exec\s+)?rspec\b/, 'rspec'],
  [/\bsbt\s+(?:\S+\s+)*test\b/, 'sbt'],
  [/\b(?:mvn|\.\/mvnw)\s+(?:\S+\s+)*test\b/, 'maven'],
  [/\b(?:gradle|\.\/gradlew)\s+(?:\S+\s+)*test\b/, 'gradle'],
  [/\bdotnet\s+test\b/, 'dotnet'],
]

/** The test runner a Bash command runs, or null when it runs none. */
export const testRunner = (command: string): string | null => {
  for (const [pattern, runner] of runners) if (pattern.test(command)) return runner
  return null
}

/**
 * Whether the command's exit code is the test run's. A pipe hands back the last command's code (`vitest | tail`
 * exits 0 on a failure), as do `;` and a new line (`vitest; echo done`); `||` turns a failure into whatever its
 * right side answers (`vitest || true`), and a trailing `&` sends the run to the background. Any of these, and the
 * code says nothing about the tests. `&&` stops at the first failure, so its code stays a failure's; redirects
 * (`2>&1`, `&>`) are no separators.
 */
export const exitIsTheRuns = (command: string): boolean => !/[|;\n]|(?<![&>])&(?![&>])/.test(command)
