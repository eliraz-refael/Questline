import { GitHubUnavailable } from "@pathofdev/schema"
import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Buffer } from "node:buffer"

// Who a GitHub token belongs to, as GitHub says, and whether GitHub issued it to Path of Dev: the one question the
// server asks with a player's GitHub token, which it then forgets. A service, so tests answer for GitHub and never reach
// the network.
//
// The question is GitHub's token check for OAuth apps, asked as the app, with its client id and secret:
//
//   POST https://api.github.com/applications/{client_id}/token   Basic client_id:client_secret   { access_token }
//     ├─ 200 ─────────────────────▶ issued to Path of Dev: the account it names signs in
//     ├─ 404, 422 ────────────────▶ none: another app's token, a revoked or expired one, or no token at all
//     ├─ 401 ─────────────────────▶ unavailable: GitHub turned down the server's own id and secret (logged)
//     └─ anything else, a timeout ▶ unavailable: GitHub is down, slow or limiting the server
//
// One request answers both questions, whose token it is and whether it is ours, so it replaces asking `GET /user` with
// the token: a token some other app got for the player never signs them in, even though it is theirs. It is asked as
// the app, so it counts against the app's rate limit, not the player's token's. GitHub's answer names the account but
// not always their profile name: a player it leaves unnamed is called by their login.

/** A GitHub account: the id is who they are, the login what they are called today. */
export const GithubUser = Schema.Struct({ id: Schema.Int, login: Schema.String, name: Schema.NullOr(Schema.String) })
export interface GithubUser extends Schema.Schema.Type<typeof GithubUser> {}

/** Path of Dev's OAuth app on GitHub: the mod's device flow runs under its client id, and only its tokens sign in. */
export interface GitHubApp {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
}

/** The client id of Path of Dev's OAuth app, which is public: the mod's device flow sends it too. */
export const publicClientId = "Ov23liaxznq5Qln0tRis"

/** The account in GitHub's answer to a token check, which may leave the name out. */
const Account = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/** What the server sends GitHub its requests with. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const unavailable = "GitHub can't check this sign-in right now: try again in a minute"

/** How long GitHub has to answer a sign-in. */
const timeout = Duration.seconds(10)

/** The URL GitHub checks a token of `app`'s at. */
export const checkUrlOf = (app: GitHubApp): string =>
  `https://api.github.com/applications/${encodeURIComponent(app.clientId)}/token`

/** The app's Basic credentials, client id and secret. */
const basicOf = (app: GitHubApp): Redacted.Redacted<string> =>
  Redacted.make(`Basic ${Buffer.from(`${app.clientId}:${Redacted.value(app.clientSecret)}`).toString("base64")}`)

export class GitHub extends Context.Service<
  GitHub,
  {
    /**
     * The account `token` signs in as, when GitHub issued it to Path of Dev's app; none when GitHub says it did not
     * (another app's token, a revoked one, not a token). It fails when GitHub can't say: it is down, slow, limiting
     * the server, turns down the app's own credentials, or answers something that names no account.
     */
    readonly user: (token: Redacted.Redacted<string>) => Effect.Effect<Option.Option<GithubUser>, GitHubUnavailable>
  }
>()("pathofdev/GitHub") {
  /** GitHub's REST API, over the network (or `fetch`, which a test answers for), asked as `app`. */
  static readonly layer = (app: GitHubApp, fetch: Fetch = globalThis.fetch) => {
    const url = checkUrlOf(app)
    const authorization = basicOf(app)
    return Layer.succeed(
      GitHub,
      GitHub.of({
        user: (token) =>
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise((signal) =>
              fetch(url, {
                method: "POST",
                headers: {
                  accept: "application/vnd.github+json",
                  authorization: Redacted.value(authorization),
                  "content-type": "application/json",
                  "user-agent": "path-of-dev",
                  "x-github-api-version": "2022-11-28",
                },
                body: JSON.stringify({ access_token: Redacted.value(token) }),
                signal,
              })
            )
            if (response.status !== 200) {
              // Drop the body unread, so the connection goes back to the pool rather than waiting on the GC.
              yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
              if (response.status === 404 || response.status === 422) return Option.none<GithubUser>()
              return yield* Effect.fail(
                response.status === 401
                  ? "GitHub turned down the server's client id and secret: check GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET"
                  : `GitHub answered ${response.status}`,
              )
            }
            // The answer repeats the token: only the account is read from it, and a failure to read it says no more
            // than that, so neither the log nor an error ever holds the rest.
            const body: unknown = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: () => "GitHub's answer was not JSON",
            })
            const named = typeof body === "object" && body !== null && "user" in body ? body.user : undefined
            const account = yield* Schema.decodeUnknownEffect(Account)(named).pipe(
              Effect.mapError(() => "GitHub's answer named no account"),
            )
            return Option.some<GithubUser>({ id: account.id, login: account.login, name: account.name ?? null })
          }).pipe(
            Effect.timeout(timeout),
            // The cause names the request at most, never its headers or body: the token and the secret stay out of
            // the log.
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
}
