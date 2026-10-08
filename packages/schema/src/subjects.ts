import { Schema } from "effect"
import { Count, GitHubRepo, GitSha } from "./primitives.ts"

// What a fact is about, without tying the fact to a provider. Work on a public repo is named, so the server can
// count it once and verify it; GitLab and others join as members of their own. Work on a private repo, sent to the
// public server, is opaque: the private member has no room for a name, number, sha or branch.

/**
 * HMAC-SHA256, in hex, made by the mod with a secret that never leaves the machine. Each machine has its own
 * secret, so keys match only for work reported from the same machine.
 */
export const SubjectKey = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)))

const subject = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("github"),
      repo: GitHubRepo,
      ...fields,
      /** The key the private form would carry, so work sent in both forms (a repo made public later) counts once. */
      key: SubjectKey,
    }),
    Schema.Struct({
      type: Schema.Literal("private"),
      /** The key over the repo alone, so events in one private repo can still be grouped. */
      repo: SubjectKey,
      /** The key over the repo and the subject's own fields. */
      key: SubjectKey,
    }),
  ])

/** A repository. */
export const RepoRef = subject({})
export type RepoRef = typeof RepoRef.Type

/** A working copy: a repository, plus branch and head where git has them (null when detached or before a commit). */
export const CheckoutRef = subject({ branch: Schema.NullOr(Schema.String), headSha: Schema.NullOr(GitSha) })
export type CheckoutRef = typeof CheckoutRef.Type

export const CommitRef = subject({ sha: GitSha })
export type CommitRef = typeof CommitRef.Type

/** A change (GitHub's pull request, GitLab's merge request) or an issue, by repo and number. */
export const WorkRef = subject({ number: Count })
export type WorkRef = typeof WorkRef.Type

/** A change or issue on GitHub as the server knows it: what the verifier confirms and what a claim waits on. */
export const GitHubWork = Schema.Struct({ type: Schema.Literal("github"), repo: GitHubRepo, number: Count })
export interface GitHubWork extends Schema.Schema.Type<typeof GitHubWork> {}
