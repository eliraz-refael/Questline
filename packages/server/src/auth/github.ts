import { GitHubUnavailable } from "@pathofdev/schema"
import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"

// Who a GitHub token belongs to, as GitHub says: the one question the server asks with a player's GitHub token, which
// it then forgets. A service, so tests answer for GitHub and never reach the network.

/** A GitHub account: the id is who they are, the login what they are called today. */
export const GithubUser = Schema.Struct({ id: Schema.Int, login: Schema.String, name: Schema.NullOr(Schema.String) })
export interface GithubUser extends Schema.Schema.Type<typeof GithubUser> {}

const unavailable = "GitHub can't check this sign-in right now: try again in a minute"

/** How long GitHub has to answer a sign-in. */
const timeout = Duration.seconds(10)

export class GitHub extends Context.Service<
  GitHub,
  {
    /**
     * The account `token` signs in as; none when GitHub turns it down (401). It fails when GitHub can't say: it is
     * down, slow, limiting the server, or answers something that isn't an account.
     */
    readonly user: (token: Redacted.Redacted<string>) => Effect.Effect<Option.Option<GithubUser>, GitHubUnavailable>
  }
>()("pathofdev/GitHub") {
  /** GitHub's REST API, over the network. */
  static readonly layer = Layer.succeed(
    GitHub,
    GitHub.of({
      user: (token) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise((signal) =>
            fetch("https://api.github.com/user", {
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${Redacted.value(token)}`,
                "user-agent": "path-of-dev",
                "x-github-api-version": "2022-11-28",
              },
              signal,
            })
          )
          if (response.status !== 200) {
            // Drop the body unread, so the connection goes back to the pool rather than waiting on the GC.
            yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
            if (response.status === 401) return Option.none<GithubUser>()
            return yield* Effect.fail(`GitHub answered ${response.status}`)
          }
          const body = yield* Effect.tryPromise(() => response.json())
          return Option.some(yield* Schema.decodeUnknownEffect(GithubUser)(body))
        }).pipe(
          Effect.timeout(timeout),
          // The cause names the request at most, never its headers: the token stays out of the log.
          Effect.catchCause((cause) =>
            Effect.andThen(
              Effect.logWarning("Could not ask GitHub who signed in", cause),
              Effect.fail(new GitHubUnavailable({ message: unavailable })),
            )
          ),
        ),
    }),
  )
}
