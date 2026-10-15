import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { publicConfigOf, publicServer } from "./public.ts"

// Starts the public server in the foreground, as its container does: the settings from the environment, a missing one
// stopping it by name, then the migrations, then it listens until it is told to stop.

Layer.launch(Layer.unwrap(Effect.map(publicConfigOf(process.env), publicServer))).pipe(NodeRuntime.runMain)
