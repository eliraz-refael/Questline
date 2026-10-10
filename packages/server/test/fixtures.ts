import type {
  ChangeMerged,
  CommandUsed,
  CommitMade,
  ContextMeasured,
  PetHatch,
  PromptGraded,
  TurnCompleted,
} from "@questline/schema"
import { QuestlineApi } from "@questline/schema"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { TestClock } from "effect/testing"
import type { LocalProfile, Stepper } from "../src/index.ts"
import { ModHandlers, services } from "../src/index.ts"

// Test inputs and a server over an in-memory PGlite, fresh for every test.

export const start = "2026-10-09T08:00:00.000Z"
export const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
export const profile: LocalProfile = { displayName: "Player", characterName: "Player", timezone: "UTC" }

const key = (char: string): string => char.repeat(64)

let ids = 0
/** ULIDs in order: the time part fixed, the counter in the random part. */
export const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

export const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

export const commit = (sha: string, occurredAt = start, id = nextId()): typeof CommitMade.Type => ({
  id,
  type: "commit.made",
  occurredAt,
  sessionId: session,
  data: { commit: { type: "github", repo: "acme/widgets", sha: sha.repeat(40), key: key("a") } },
})

export const merged = (number: number, id = nextId()): typeof ChangeMerged.Type => ({
  id,
  type: "change.merged",
  occurredAt: start,
  sessionId: session,
  data: { change: { type: "github", repo: "acme/widgets", number, key: key("b") } },
})

export const turn = (id = nextId()): typeof TurnCompleted.Type => ({
  id,
  type: "turn.completed",
  occurredAt: start,
  sessionId: session,
  data: { durationMs: 1000, toolCalls: 2 },
})

/** A prompt graded `score` on every dimension, regret included. */
export const prompt = (score: number, id = nextId()): typeof PromptGraded.Type => ({
  id,
  type: "prompt.graded",
  occurredAt: start,
  sessionId: session,
  data: {
    scores: {
      clarity: score,
      grammar: score,
      specificity: score,
      instructive: score,
      context: score,
      doneCriteria: score,
      focus: score,
      regret: score,
    },
    rubricVersion: 1,
    words: 12,
    grader: "haiku",
  },
})

export const commandUsed = (command: string, id = nextId()): typeof CommandUsed.Type => ({
  id,
  type: "command.used",
  occurredAt: start,
  sessionId: session,
  data: { command },
})

export const contextMeasured = (pct: number, id = nextId()): typeof ContextMeasured.Type => ({
  id,
  type: "context.measured",
  occurredAt: start,
  sessionId: session,
  data: { pct },
})

export const hatch = (id = nextId()): typeof PetHatch.Type => ({ id, type: "pet.hatch", data: { species: "fox", name: "Pixel" } })

/** The services behind the routes, over a fresh in-memory database, with the clock at `start`. */
export const testServices = (stepper?: Stepper) =>
  Layer.mergeAll(services({}, profile, stepper), HttpServer.layerServices).pipe(
    Layer.provideMerge(Layer.effectDiscard(TestClock.setTime(Date.parse(start)))),
  )

/** A typed client wired straight to the handlers, with no socket in between. */
export const client = HttpApiTest.groups(QuestlineApi, ["mod"])

/** Runs a test against a fresh server: the handlers and the services behind them, over one database. */
export const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>, stepper?: Stepper) =>
  effect.pipe(Effect.provide(ModHandlers.pipe(Layer.provideMerge(testServices(stepper)))))
