import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber, Deferred } from "effect"
import { endpoint, prepare, secureSocket } from "./endpoint.js"
import { request } from "./client.js"
import { maxFrameBytes } from "./limits.js"

const fixture = Effect.fn("ClientTest.fixture")(function* (reply: (socket: Socket) => void) {
  const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-client-")))
  const paths = endpoint(join(directory, "run"))
  yield* prepare(paths)
  const server: Server = createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", () => reply(socket))
  })
  yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(paths.socket, resolve)))
  yield* Effect.promise(() => secureSocket(paths))
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
  )
  return paths
})

for (const [name, frame] of [
  ["invalid JSON", "not-json\n"],
  ["wrong shape", '{"_tag":"Success","value":{}}\n'],
  ["wrong operation", '{"_tag":"Success","value":{"stopping":true}}\n'],
  ["extra frame", '{"_tag":"Failure","message":"no"}\n{}\n'],
  ["oversized response", "x".repeat(maxFrameBytes + 1)]
] as const)
  it.live(`rejects ${name}`, () =>
    Effect.gen(function* () {
      const paths = yield* fixture((socket) => socket.end(frame))
      expect((yield* request(paths, { _tag: "Ping" }).pipe(Effect.exit))._tag).toBe("Failure")
    }).pipe(Effect.scoped)
  )

it.live("rejects oversized requests before connection and handles EOF and timeout", () =>
  Effect.gen(function* () {
    let contacted = false
    const paths = yield* fixture((socket) => {
      contacted = true
      socket.end()
    })
    const oversized = {
      _tag: "Append",
      root: paths.directory,
      agent: { runtime: "test", sessionId: "s", agentId: "root" },
      eventId: "e",
      kind: "note",
      text: "x".repeat(maxFrameBytes)
    } satisfies Parameters<typeof request>[1]
    expect((yield* request(paths, oversized).pipe(Effect.exit))._tag).toBe("Failure")
    expect(contacted).toBe(false)
    expect((yield* request(paths, { _tag: "Ping" }).pipe(Effect.exit))._tag).toBe("Failure")
    const stalled = yield* fixture((socket) => {
      socket.once("end", () => socket.destroy())
    })
    expect((yield* request(stalled, { _tag: "Ping" }, 10).pipe(Effect.exit))._tag).toBe("Failure")
  }).pipe(Effect.scoped)
)

it.live("interruption destroys a waiting socket without losing bounded transport ownership", () =>
  Effect.gen(function* () {
    const submitted = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const paths = yield* fixture((socket) => {
      socket.once("close", () => Effect.runSync(Deferred.succeed(closed, undefined)))
      Effect.runSync(Deferred.succeed(submitted, undefined))
    })
    const fiber = yield* request(paths, { _tag: "Ping" }).pipe(Effect.forkScoped)
    yield* Deferred.await(submitted)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(closed)
  }).pipe(Effect.scoped)
)
