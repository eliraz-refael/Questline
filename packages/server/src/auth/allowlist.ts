import { Context, Layer } from "effect"

// The closed beta: only the GitHub logins in `ALLOWED_LOGINS` play on the public server. The list is checked at
// sign-in and again on every request, so taking a login off it locks that player out at once, token or not.

/** The logins `raw` lists, as `ALLOWED_LOGINS` writes them: separated by commas or white space, in any case. */
export const loginsOf = (raw: string): ReadonlySet<string> =>
  new Set(raw.split(/[\s,]+/u).flatMap((login) => (login === "" ? [] : [login.toLowerCase()])))

/** Whether `login` is on the list: GitHub logins are one account whatever their case. A player with none is not. */
export const isAllowed = (logins: ReadonlySet<string>, login: string | null): boolean =>
  login !== null && logins.has(login.toLowerCase())

export class Allowlist extends Context.Service<Allowlist, { readonly allows: (login: string | null) => boolean }>()(
  "pathofdev/Allowlist",
) {
  /** The logins `raw` lists, as `ALLOWED_LOGINS` writes them. An empty list lets nobody in. */
  static readonly layer = (raw: string) => {
    const logins = loginsOf(raw)
    return Layer.succeed(Allowlist, Allowlist.of({ allows: (login) => isAllowed(logins, login) }))
  }
}
