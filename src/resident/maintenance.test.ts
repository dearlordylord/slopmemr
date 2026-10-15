import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { activate } from "./maintenance.js"
import { endpoint, prepare, secureSocket, TransportError } from "./endpoint.js"
import { RuntimeSelection } from "../local-state/runtime-selection.js"
import { applicationName, applicationVersion } from "./identity.js"
import type { Ping } from "./identity.js"

const fixture = Effect.fn("Test.residentEndpoint")(function* (
  current: (selected: RuntimeSelection) => typeof Ping.Type,
  advance = false
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-activation-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )
  const paths = endpoint(join(directory, "run"))
  yield* prepare(paths)
  const selected = RuntimeSelection.make({
    application: "slopmemr",
    version: 1,
    launch: { executable: process.execPath, entrypoint: join(directory, "selected.mjs") },
    implementation: "a".repeat(64),
    dataDirectory: join(directory, "data")
  })
  let shutdowns = 0
  const next = ping(selected, 2)
  const original = current(selected)
  const server = createServer((socket) => {
    socket.once("data", (bytes) => {
      const shutdown = bytes.toString().includes('"Shutdown"')
      if (shutdown) shutdowns++
      const value = shutdown ? { stopping: true } : advance && shutdowns > 0 ? next : original
      socket.end(JSON.stringify({ _tag: "Success", value }) + "\n")
    })
  })
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(paths.socket, resolve)
        }),
      catch: () => new TransportError({ message: "Fixture bind failed" })
    }),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  yield* Effect.tryPromise({
    try: () => secureSocket(paths),
    catch: () => new TransportError({ message: "Fixture permissions failed" })
  })
  return { paths, selected, shutdowns: () => shutdowns }
})
const ping = (target: RuntimeSelection, pid: number): typeof Ping.Type => ({
  application: applicationName,
  version: applicationVersion,
  guardedShutdown: true,
  protocol: 1,
  implementation: target.implementation,
  ...target.launch,
  dataDirectory: target.dataDirectory,
  pid
})

it.live("rejects an unknown resident without sending shutdown", () =>
  Effect.gen(function* () {
    const f = yield* fixture((selected) => ({
      ...ping(selected, 1),
      implementation: "b".repeat(64),
      dataDirectory: "/other-data"
    }))
    const failure = yield* activate(f.paths, f.selected, true).pipe(Effect.flip)
    expect(failure).toMatchObject({ retryable: false })
    expect(f.shutdowns()).toBe(0)
  })
)

it.live("recognizes a selected resident started by a competing hook", () =>
  Effect.gen(function* () {
    const f = yield* fixture(
      (selected) => ({
        ...ping(selected, 1),
        implementation: "b".repeat(64),
        entrypoint: join(selected.dataDirectory, "previous.mjs")
      }),
      true
    )
    const current = {
      ...f.selected,
      implementation: "b".repeat(64),
      launch: { ...f.selected.launch, entrypoint: join(f.selected.dataDirectory, "previous.mjs") }
    }
    const result = yield* activate(f.paths, { ...f.selected, previous: current }, true)
    expect(result).toMatchObject({ serving: true, changed: true })
    expect(f.shutdowns()).toBe(1)
  })
)

it.live("restarts the identified selected resident with a new process identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture((selected) => ping(selected, 1), true)
    expect(yield* activate(f.paths, f.selected, true, true)).toMatchObject({ serving: true, changed: true })
    expect(f.shutdowns()).toBe(1)
  })
)

it.live("reports corrupt ownership storage through the typed failure channel", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-corrupt-owner-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
    )
    const paths = endpoint(join(directory, "run"))
    yield* prepare(paths)
    yield* Effect.promise(() => writeFile(join(paths.directory, "resident-owner.sqlite"), "not a SQLite database"))
    const selected = RuntimeSelection.make({
      application: "slopmemr",
      version: 1,
      launch: { executable: process.execPath, entrypoint: join(directory, "unstarted.mjs") },
      implementation: "a".repeat(64),
      dataDirectory: join(directory, "data")
    })
    const failure = yield* activate(paths, selected, true).pipe(Effect.flip)
    expect(failure).toMatchObject({
      _tag: "TransportError",
      retryable: false,
      message: "Cannot inspect resident ownership"
    })
  })
)

it.live("rejects foreign launch paths even with matching data and CLI digest", () =>
  Effect.gen(function* () {
    const f = yield* fixture((selected) => ({
      ...ping(selected, 1),
      executable: "/foreign-node",
      entrypoint: "/foreign.mjs"
    }))
    expect(yield* activate(f.paths, f.selected, true).pipe(Effect.flip)).toMatchObject({ retryable: false })
    expect(f.shutdowns()).toBe(0)
  })
)
