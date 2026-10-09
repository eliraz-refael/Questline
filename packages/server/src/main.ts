import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { localServer } from "./local.ts"

// Starts the local server in the foreground. For the proof of concept the player starts it by hand; later the mod
// spawns it, detached, when nothing answers on the socket.

Layer.launch(localServer()).pipe(NodeRuntime.runMain)
