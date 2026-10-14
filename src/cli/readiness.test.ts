import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { endpoint, prepare, secureSocket } from "../resident/endpoint.js"
import { send } from "./lifecycle.js"

for (const loseFirstConnection of [false, true])
  it.live(`never transmits Append when ${loseFirstConnection ? "startup" : "existing"} endpoint refuses Ping`, () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-readiness-")))
      const paths = endpoint(join(directory, "run"))
      yield* prepare(paths)
      const methods: string[] = []
      const server = createServer((socket) => {
        socket.once("data", (frame) => {
          const input = JSON.parse(frame.toString())
          methods.push(input._tag)
          if (loseFirstConnection && methods.length === 1) socket.destroy()
          else socket.end(JSON.stringify({ _tag: "Failure", message: "Identity refused" }) + "\n")
        })
      })
      yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(paths.socket, resolve)))
      yield* Effect.promise(() => secureSocket(paths))
      try {
        const result = yield* send(
          paths,
          {
            _tag: "Append",
            root: directory,
            agent: { runtime: "test", sessionId: "s", agentId: "root" },
            eventId: "event",
            kind: "user",
            text: "Must never transmit"
          },
          { executable: "/bin/true", entrypoint: "/unused" }
        ).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(methods).toEqual(loseFirstConnection ? ["Ping", "Ping"] : ["Ping"])
      } finally {
        yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    })
  )
