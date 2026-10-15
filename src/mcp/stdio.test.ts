import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema, Sink, Stream } from "effect"
import * as Stdio from "effect/Stdio"
import { AvailableSnapshot, MemoryReadError } from "../memory/reading.js"
import { Reader } from "./reader.js"
import { run } from "./stdio.js"

const snapshot = AvailableSnapshot.make({
  text: "old available fact",
  bytes: 18,
  view: [{ level: 0, index: 0 }],
  requestedThrough: 2,
  coveredThrough: 1,
  totalRecords: 2,
  coverage: "behind",
  freshness: { latestRecordAt: "2026-10-14T00:00:01.000Z", coveredRecordAt: "2026-10-14T00:00:00.000Z" },
  processing: { state: "updating", active: 1, pending: 1, failed: [], storageAvailable: true }
})
const Reply = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown)
})
const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown, outputSchema: Schema.Unknown }))
})

const transport = (frames: ReadonlyArray<unknown>, output: string[]) =>
  Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromIterable(frames.map((value) => Buffer.from(JSON.stringify(value) + "\n"))),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
          })
        ),
      stderr: () => Sink.drain
    })
  )
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" }, capabilities: {} }
}
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" }
const call = (id: number, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "slopmemr_snapshot", arguments: args }
})
const replies = (output: ReadonlyArray<string>) =>
  output
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(Reply)(JSON.parse(line)))

it.effect("publishes direct schemas and flushes pending-memory results after immediate EOF", () =>
  Effect.gen(function* () {
    const output: string[] = []
    const reader = Layer.succeed(Reader, Reader.of({ read: Effect.fn("Test.read")(() => Effect.succeed(snapshot)) }))
    yield* run(
      transport(
        [initialize, initialized, { jsonrpc: "2.0", id: 2, method: "tools/list" }, call(3, { root: "/project" })],
        output
      )
    ).pipe(Effect.provide(reader))
    const messages = replies(output)
    const listed = Schema.decodeUnknownSync(ToolList)(messages.find(({ id }) => id === 2)?.result)
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "slopmemr_snapshot",
      "slopmemr_zoom",
      "slopmemr_status",
      "slopmemr_roots"
    ])
    expect(listed.tools[0]?.inputSchema).toMatchObject({ type: "object", required: ["root"] })
    expect(listed.tools[0]?.outputSchema).toMatchObject({ type: "object", required: ["result"] })
    expect(messages.find(({ id }) => id === 3)?.result).toMatchObject({
      isError: false,
      structuredContent: { result: snapshot }
    })
  })
)

it.effect("drains an admitted tool call through EOF without interrupting its reader", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const output: string[] = []
    const reader = Layer.succeed(
      Reader,
      Reader.of({
        read: Effect.fn("Test.blocked")(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return snapshot
        })
      })
    )
    const worker = yield* run(transport([initialize, initialized, call(2, { root: "/project" })], output)).pipe(
      Effect.provide(reader),
      Effect.forkScoped
    )
    yield* Deferred.await(entered)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(worker)
    expect(replies(output).find(({ id }) => id === 2)?.result).toMatchObject({
      isError: false,
      structuredContent: { result: snapshot }
    })
  })
)

it.effect("returns stable sanitized errors for invalid arguments and unavailable residents", () =>
  Effect.gen(function* () {
    const output: string[] = []
    const reader = Layer.succeed(
      Reader,
      Reader.of({
        read: Effect.fn("Test.unavailable")(() =>
          Effect.fail(
            new MemoryReadError({ code: "RESIDENT_UNAVAILABLE", message: "Resident unavailable", retryable: true })
          )
        )
      })
    )
    yield* run(
      transport(
        [
          initialize,
          initialized,
          call(2, { root: "/project", unexpected: "private input" }),
          call(3, { root: "/project" })
        ],
        output
      )
    ).pipe(Effect.provide(reader))
    expect(replies(output).find(({ id }) => id === 2)?.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INVALID_INPUT", retryable: false } }
    })
    expect(replies(output).find(({ id }) => id === 3)?.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "RESIDENT_UNAVAILABLE", retryable: true } }
    })
    expect(output.join("")).not.toContain("private input")
  })
)

it.effect("flushes a batch call before closing an older negotiated protocol", () =>
  Effect.gen(function* () {
    const output: string[] = []
    const reader = Layer.succeed(Reader, Reader.of({ read: Effect.fn("Test.batch")(() => Effect.succeed(snapshot)) }))
    yield* run(
      transport(
        [
          { ...initialize, params: { ...initialize.params, protocolVersion: "2025-03-26" } },
          initialized,
          [call(2, { root: "/project" })]
        ],
        output
      )
    ).pipe(Effect.provide(reader))
    expect(output.join("")).toContain("old available fact")
  })
)

it.effect("propagates oversized input through the typed protocol failure channel", () =>
  Effect.gen(function* () {
    const output: string[] = []
    const reader = Layer.succeed(
      Reader,
      Reader.of({ read: Effect.fn("Test.largeInput")(() => Effect.succeed(snapshot)) })
    )
    const failure = yield* run(transport([{ ...initialize, oversized: "x".repeat(2 * 1024 * 1024) }], output)).pipe(
      Effect.provide(reader),
      Effect.flip
    )
    expect(failure).toMatchObject({ _tag: "ProtocolLimitError", reason: "frame" })
  })
)
