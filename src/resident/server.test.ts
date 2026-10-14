import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtemp, mkdir, rm, chmod, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection, createServer } from "node:net"
import type { Socket } from "node:net"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { Compactor } from "../compaction/compactor.js"
import { MemoryManager, layer as memoryLayer } from "../memory/manager.js"
import { layer } from "./server.js"
import { endpoint, prepare, secureSocket } from "./endpoint.js"
import { request } from "./client.js"
import { maxFrameBytes } from "./protocol.js"

const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const fixture = () =>
  Effect.promise(async () => {
    const path = await mkdtemp(join(tmpdir(), "sm-resident-"))
    fixtures.push(path)
    const root = join(path, "project")
    await mkdir(root)
    return { root, directory: join(path, "data"), endpoint: endpoint(join(path, "run")) }
  })
const fake = Layer.succeed(Compactor, Compactor.of({ compress: () => Effect.succeed("summary") }))

it.live("serves intake, exact snapshots and zoom; reopens persisted memory after shutdown", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const create = () =>
      ManagedRuntime.make(layer(options).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(fake)))))
    const first = create()
    try {
      yield* Effect.promise(() => first.runPromise(Effect.void))
      const append = {
        _tag: "Append" as const,
        root: options.root,
        agent: { runtime: "codex", sessionId: "s", agentId: "root" },
        eventId: "e",
        kind: "user",
        text: "a remembered fact"
      }
      const result = yield* request(options.endpoint, append)
      expect(result._tag).toBe("Success")
      expect(
        JSON.stringify(yield* request(options.endpoint, { _tag: "Snapshot", root: options.root, before: 1 }))
      ).toContain("a remembered fact")
      expect(
        JSON.stringify(yield* request(options.endpoint, { _tag: "Zoom", root: options.root, first: 0, count: 1 }))
      ).toContain("a remembered fact")
      expect((yield* request(options.endpoint, { _tag: "Zoom", root: options.root, first: 0, count: 3 }))._tag).toBe(
        "Failure"
      )
    } finally {
      yield* Effect.promise(() => first.dispose())
    }
    const second = create()
    try {
      yield* Effect.promise(() => second.runPromise(Effect.void))
      expect(JSON.stringify(yield* request(options.endpoint, { _tag: "Snapshot", root: options.root }))).toContain(
        "a remembered fact"
      )
    } finally {
      yield* Effect.promise(() => second.dispose())
    }
  })
)

it.live("keeps accepted memory and compression alive when the submitting agent disconnects", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const compactor = Layer.succeed(
      Compactor,
      Compactor.of({
        compress: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return "preserved summary"
          })
      })
    )
    const runtime = ManagedRuntime.make(
      layer(options).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(compactor))))
    )
    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void))
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const socket = createConnection(options.endpoint.socket)
            socket.on("error", reject)
            socket.on("connect", () => {
              socket.write(
                JSON.stringify({
                  _tag: "Append",
                  root: options.root,
                  agent: { runtime: "codex", sessionId: "s", agentId: "root" },
                  eventId: "e",
                  kind: "user",
                  text: "large source ".repeat(200)
                }) + "\n",
                () => {
                  socket.destroy()
                  resolve()
                }
              )
            })
          })
      )
      yield* Deferred.await(started)
      expect(JSON.stringify(yield* request(options.endpoint, { _tag: "Status", root: options.root }))).toContain(
        '"count":1'
      )
      yield* Deferred.succeed(release, undefined)
      const snapshot = yield* request(options.endpoint, { _tag: "Settle", root: options.root })
      expect(JSON.stringify(snapshot)).toContain("preserved summary")
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live("rejects malformed and oversized frames, and refuses a nonprivate endpoint", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const runtime = ManagedRuntime.make(
      layer(options).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(fake))))
    )
    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void))
      const raw = (frame: string) =>
        Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = createConnection(options.endpoint.socket)
              let result = ""
              socket.on("error", (error) => {
                if ("code" in error && error.code === "ECONNRESET") resolve(result)
                else reject(error)
              })
              socket.on("connect", () => socket.write(frame))
              socket.on("data", (chunk) => {
                result += chunk.toString()
              })
              socket.on("close", () => resolve(result))
            })
        )
      expect(yield* raw('{"_tag":"Append"}\n')).toContain("Invalid memory request")
      expect(yield* raw("x".repeat(maxFrameBytes + 1))).toBe("")
      yield* Effect.promise(() => chmod(options.endpoint.socket, 0o666))
      expect((yield* request(options.endpoint, { _tag: "Ping" }).pipe(Effect.flip))._tag).toBe("TransportError")
      yield* Effect.promise(() => chmod(options.endpoint.socket, 0o600))
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live("racing residents cannot unlink or replace a live endpoint", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const create = () =>
      ManagedRuntime.make(layer(options).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(fake)))))
    const first = create()
    const second = create()
    try {
      yield* Effect.promise(() => first.runPromise(Effect.void))
      const rejected = yield* Effect.promise(() => second.runPromiseExit(Effect.void))
      expect(rejected._tag).toBe("Failure")
      expect((yield* request(options.endpoint, { _tag: "Ping" }))._tag).toBe("Success")
    } finally {
      yield* Effect.promise(() => second.dispose())
      yield* Effect.promise(() => first.dispose())
    }
  })
)

it.live("rejects invalid connection limits and unsafe or already-live foreign endpoints", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const activate = (extra: Partial<Parameters<typeof layer>[0]> = {}) => {
      const runtime = ManagedRuntime.make(
        layer({ ...options, ...extra }).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(fake))))
      )
      return Effect.acquireUseRelease(
        Effect.succeed(runtime),
        (value) => Effect.promise(() => value.runPromiseExit(Effect.void)),
        (value) => Effect.promise(() => value.dispose())
      )
    }
    expect((yield* activate({ maxConnections: 0 }))._tag).toBe("Failure")
    yield* prepare(options.endpoint)
    yield* Effect.promise(() => writeFile(options.endpoint.socket, "foreign file"))
    expect((yield* activate())._tag).toBe("Failure")
    expect(yield* Effect.promise(() => readFile(options.endpoint.socket, "utf8"))).toBe("foreign file")
    yield* Effect.promise(() => rm(options.endpoint.socket))
    const foreign = createServer((socket) => socket.destroy())
    yield* Effect.promise(() => new Promise<void>((resolve) => foreign.listen(options.endpoint.socket, resolve)))
    yield* Effect.promise(() => secureSocket(options.endpoint))
    try {
      expect((yield* activate())._tag).toBe("Failure")
    } finally {
      yield* Effect.promise(() => new Promise<void>((resolve) => foreign.close(() => resolve())))
    }
  })
)

it.live("bounds open connections, enforces absolute frame deadlines, and rejects multiple frames", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const runtime = ManagedRuntime.make(
      layer({ ...options, maxConnections: 1 }).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(fake))))
    )
    yield* Effect.promise(() => runtime.runPromise(Effect.void))
    try {
      const connect = () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = createConnection(options.endpoint.socket)
          socket.once("error", reject)
          socket.once("connect", () => resolve(socket))
        })
      const first = yield* Effect.promise(connect)
      first.resume()
      const closed = new Promise<void>((resolve) => first.once("close", () => resolve()))
      const second = yield* Effect.promise(connect)
      const secondClosed = new Promise<void>((resolve) => second.once("close", () => resolve()))
      second.resume()
      yield* Effect.promise(() => secondClosed)
      first.write("{")
      yield* Effect.promise(() => closed)
      const third = yield* Effect.promise(connect)
      let result = ""
      const done = new Promise<void>((resolve) => third.once("close", () => resolve()))
      third.on("data", (chunk) => {
        result += chunk.toString()
      })
      third.write('{"_tag":"Ping"}\n{}\n')
      yield* Effect.promise(() => done)
      expect(result).toContain("Invalid memory request")
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live("contains defects at the socket boundary without exposing their messages", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const base = memoryLayer(options).pipe(Layer.provide(fake))
    const failing = Layer.effect(
      MemoryManager,
      Effect.gen(function* () {
        const original = yield* MemoryManager
        return MemoryManager.of({ ...original, snapshot: () => Effect.die("private-provider-source") })
      })
    ).pipe(Layer.provide(base))
    const runtime = ManagedRuntime.make(layer(options).pipe(Layer.provide(failing)))
    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void))
      const result = yield* request(options.endpoint, { _tag: "Snapshot", root: options.root })
      expect(result).toEqual({ _tag: "Failure", message: "Resident operation failed" })
      expect(JSON.stringify(result)).not.toContain("private-provider-source")
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live("returns a bounded failure when a permitted custom memory policy produces an oversized snapshot", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const memory = memoryLayer({
      ...options,
      policy: {
        nodeBytes: maxFrameBytes * 2,
        recordBytes: maxFrameBytes * 2,
        mainHigh: maxFrameBytes * 4,
        mainLow: maxFrameBytes * 3,
        compactionHigh: maxFrameBytes * 4,
        compactionLow: maxFrameBytes * 3
      }
    }).pipe(Layer.provide(fake))
    const runtime = ManagedRuntime.make(layer(options).pipe(Layer.provideMerge(memory)))
    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void))
      yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(MemoryManager, (manager) =>
            manager.append({
              root: options.root,
              agent: { runtime: "test", sessionId: "s", agentId: "root" },
              eventId: "large",
              kind: "source",
              text: "x".repeat(maxFrameBytes + 1)
            })
          )
        )
      )
      expect(yield* request(options.endpoint, { _tag: "Snapshot", root: options.root })).toEqual({
        _tag: "Failure",
        message: "Response exceeds transport limit"
      })
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live("recovers an OS-owned stale socket after its process dies", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    yield* prepare(options.endpoint)
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/socket.mjs", import.meta.url)), options.endpoint.socket],
      { stdio: ["ignore", "pipe", "ignore"] }
    )
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject)
          child.stdout?.once("data", () => resolve())
        })
    )
    yield* Effect.promise(() => secureSocket(options.endpoint))
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGKILL")
    yield* Effect.promise(() => exited)
    const runtime = ManagedRuntime.make(
      layer(options).pipe(Layer.provide(memoryLayer(options).pipe(Layer.provide(fake))))
    )
    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void))
      expect((yield* request(options.endpoint, { _tag: "Ping" }))._tag).toBe("Success")
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)
