import { it as prop } from "@effect/vitest"
import type { ClientEvent } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { admit, maxAhead, maxAge, naturalKey } from "../src/index.ts"
import { commit, merged, minutesLater, start, turn } from "./fixtures.ts"

const hex = (char: string): string => char.repeat(64)

describe("admit", () => {
  it("admits a valid event as a client input with its natural key", () => {
    const event = commit("a")
    expect(admit(event, start)).toEqual({
      kind: "admitted",
      admitted: { id: event.id, input: { kind: "client", event }, naturalKey: `commit.made:acme/widgets@${"a".repeat(40)}` },
    })
  })

  it("tells a type from a newer mod apart from a malformed event, so the mod keeps the first queued", () => {
    expect(admit({ id: "x", type: "pet.danced" }, start)).toEqual({
      kind: "rejected",
      result: { id: "x", status: "rejected", reason: "unknown_type" },
    })
    expect(admit({ ...turn(), data: { durationMs: -1, toolCalls: 2 } }, start)).toMatchObject({
      result: { status: "rejected", reason: "invalid" },
    })
    expect(admit({ id: 7, type: 7 }, start)).toEqual({ kind: "rejected", result: { id: "", status: "rejected", reason: "invalid" } })
    expect(admit("not an event", start)).toMatchObject({ result: { id: "", reason: "invalid" } })
  })

  it("refuses a time that matches the pattern but names no real moment", () => {
    const event = { ...commit("a"), occurredAt: "2026-13-45T99:99:99Z" }
    expect(admit(event, start)).toEqual({ kind: "rejected", result: { id: event.id, status: "rejected", reason: "invalid" } })
  })

  it("refuses an event more than 7 days old", () => {
    const event = commit("a", minutesLater(-7 * 24 * 60 - 1))
    expect(admit(event, start)).toEqual({ kind: "rejected", result: { id: event.id, status: "rejected", reason: "too_old" } })
    expect(admit(commit("a", minutesLater(-7 * 24 * 60)), start).kind).toBe("admitted")
  })

  it("pulls an event from the future back to 5 minutes after receipt", () => {
    const admitted = admit(commit("a", minutesLater(60)), start)
    expect(admitted.kind === "admitted" && admitted.admitted.input).toMatchObject({ event: { occurredAt: minutesLater(5) } })
    const near = admit(commit("a", minutesLater(4)), start)
    expect(near.kind === "admitted" && near.admitted.input).toMatchObject({ event: { occurredAt: minutesLater(4) } })
  })
})

describe("an account's start", () => {
  const minutes = Schema.Int.check(Schema.isBetween({ minimum: -8 * 24 * 60, maximum: 60 }))

  prop.prop(
    "refuses an event from before an account was made, past a clock's drift, and changes nothing else",
    [minutes, minutes],
    ([occurred, made]) => {
      const event = commit("a", minutesLater(occurred))
      const since = minutesLater(made)
      const unbounded = admit(event, start)
      const bounded = admit(event, start, since)
      const isBefore = Date.parse(event.occurredAt) < Date.parse(since) - maxAhead
      if (unbounded.kind === "admitted" && isBefore) {
        expect(bounded).toEqual({ kind: "rejected", result: { id: event.id, status: "rejected", reason: "before_account" } })
      } else {
        expect(bounded).toEqual(unbounded)
      }
      // Nothing admitted happened before the account, and nothing past the window counts either way.
      if (bounded.kind === "admitted") expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(Date.parse(since) - maxAhead)
      if (Date.parse(event.occurredAt) < Date.parse(start) - maxAge) expect(bounded).toEqual(unbounded)
    },
  )
})

describe("naturalKey", () => {
  it("keys named work by kind, repo and number, so two reports from two machines count once", () => {
    const one = merged(212)
    const other: ClientEvent = {
      ...merged(212),
      data: { change: { type: "github", repo: "acme/widgets", number: 212, key: hex("c") } },
    }
    expect(naturalKey(one)).toBe("change.merged:acme/widgets#212")
    expect(naturalKey(other)).toBe(naturalKey(one))
  })

  it("keeps the kinds apart: opening and merging one change are two facts", () => {
    const opened: ClientEvent = { ...merged(212), type: "change.opened" }
    expect(naturalKey(opened)).not.toBe(naturalKey(merged(212)))
  })

  it("keys private work by its subject key", () => {
    const event: ClientEvent = { ...merged(1), data: { change: { type: "private", repo: hex("d"), key: hex("e") } } }
    expect(naturalKey(event)).toBe(`change.merged:${hex("e")}`)
  })

  it("leaves observations that are not a piece of work unkeyed", () => {
    expect(naturalKey(turn())).toBeNull()
  })
})
