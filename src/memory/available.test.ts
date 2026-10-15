import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import type { Scope } from "effect"
import { Memory, InMemoryStorage } from "@firfi/unii"
import { availableSnapshot, availableZoom, readingStatus } from "./available.js"

const open = (storage: InMemoryStorage): Effect.Effect<Memory, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() =>
      Memory.open({ storage, now: () => 1_800_000_000_000, policy: { nodeBytes: 64, pageBytes: 8 } })
    ),
    (memory) => Effect.promise(() => memory.close())
  )

it.effect("returns the existing prefix and metadata while a new record remains pending", () =>
  Effect.gen(function* () {
    const memory = yield* open(new InMemoryStorage())
    yield* Effect.promise(() => memory.append({ kind: "user", text: "preserved fact" }))
    yield* Effect.promise(() => memory.append({ kind: "user", text: "new source ".repeat(100) }))
    yield* Effect.promise(() => memory.append({ kind: "user", text: "later fact" }))
    const result = yield* Effect.fromResult(availableSnapshot(memory))
    expect(result.text).toContain("preserved fact")
    expect(result.text).not.toContain("later fact")
    expect(result).toMatchObject({
      requestedThrough: 3,
      coveredThrough: 1,
      totalRecords: 3,
      coverage: "behind",
      processing: { state: "waiting" }
    })
    expect(result.bytes).toBe(Buffer.byteLength(result.text))
    expect(result.freshness.coveredRecordAt).toBe(memory.date(0))
    expect(result.freshness.latestRecordAt).toBe(memory.date(2))
    expect(yield* Effect.fromResult(availableSnapshot(memory, { before: 1 }))).toMatchObject({
      coverage: "current",
      requestedThrough: 1,
      coveredThrough: 1
    })
    expect(readingStatus(memory)).toMatchObject({ count: 3, cursor: 1 })
  })
)

it.effect("returns empty text for an empty pool and for a missing first summary", () =>
  Effect.gen(function* () {
    const memory = yield* open(new InMemoryStorage())
    expect(yield* Effect.fromResult(availableSnapshot(memory))).toMatchObject({
      text: "",
      bytes: 0,
      coverage: "current",
      freshness: { latestRecordAt: null, coveredRecordAt: null }
    })
    yield* Effect.promise(() => memory.append({ kind: "user", text: "unresolved ".repeat(100) }))
    expect(yield* Effect.fromResult(availableSnapshot(memory))).toMatchObject({
      text: "",
      bytes: 0,
      coverage: "empty",
      requestedThrough: 1,
      coveredThrough: 0
    })
    expect(yield* Effect.fromResult(availableSnapshot(memory, { before: 0 }))).toMatchObject({
      text: "",
      coverage: "current",
      requestedThrough: 0
    })
    expect(Result.isFailure(availableSnapshot(memory, { before: 2 }))).toBe(true)
  })
)

it.effect("returns two child slots with partial readiness and reads originals independently", () =>
  Effect.gen(function* () {
    const memory = yield* open(new InMemoryStorage())
    yield* Effect.promise(() => memory.append({ kind: "user", text: "old" }))
    yield* Effect.promise(() => memory.append({ kind: "user", text: "αβγδ".repeat(100) }))
    const children = yield* Effect.fromResult(availableZoom(memory, 0, 2))
    expect(children).toMatchObject({
      kind: "children",
      children: [
        { first: 0, count: 1, state: "ready", text: "user: old" },
        { first: 1, count: 1, state: "pending", text: null }
      ]
    })
    expect(yield* Effect.fromResult(availableZoom(memory, 1, 1, 1))).toMatchObject({
      kind: "record",
      text: "αβγδ",
      pages: 100,
      totalBytes: 800,
      page: 1
    })
    expect(Result.isFailure(availableZoom(memory, 0, 2, 1))).toBe(true)
    expect(Result.isFailure(availableZoom(memory, 1, 2))).toBe(true)
    expect(Result.isFailure(availableZoom(memory, 0, 1, 999))).toBe(true)
  })
)

it.effect("reports null freshness for invalid persisted calendar dates", () =>
  Effect.gen(function* () {
    const memory = yield* open(new InMemoryStorage())
    yield* Effect.promise(() => memory.append({ kind: "user", text: "fact" }))
    const reader = {
      snapshot: memory.snapshot.bind(memory),
      status: memory.status.bind(memory),
      nodes: memory.nodes.bind(memory),
      zoom: memory.zoom.bind(memory),
      date: () => "2026-02-31T00:00:00.000Z"
    }
    expect(readingStatus(reader).freshness).toEqual({ latestRecordAt: null, coveredRecordAt: null })
  })
)
