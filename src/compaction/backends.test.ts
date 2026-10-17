import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type { CompressionRequest } from "@firfi/unii"
import { Compactor } from "./compactor.js"
import { ClaudeCompactor } from "./claude.js"
import { routing } from "./backends.js"

const request: CompressionRequest = {
  jobId: "job",
  attemptId: "attempt",
  attempt: 1,
  node: { level: 0, index: 0 },
  source: "fact",
  context: "",
  priorResponses: [],
  feedback: null
}

it.effect("routes by source runtime and rejects mismatched profiles without cross-runtime fallback", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const service = (name: string) => ({
      compress: Effect.fn("Test.route")(() =>
        Effect.sync(() => {
          calls.push(name)
          return name
        })
      )
    })
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      expect(yield* compactor.compress({ codexHome: "/codex" }, request, () => {}, "codex")).toBe("codex")
      expect(yield* compactor.compress({ claudeHome: "/claude" }, request, () => {}, "claude")).toBe("claude")
      expect(yield* compactor.compress(undefined, request, () => {}, "claude")).toBe("claude")
      expect(yield* compactor.compress(undefined, request, () => {})).toBe("codex")
      expect(yield* compactor.compress({ claudeHome: "/claude" }, request, () => {})).toBe("claude")
      for (const [auth, runtime] of [
        [{ codexHome: "/codex" }, "claude"],
        [{ claudeHome: "/claude" }, "codex"],
        [undefined, "unknown"]
      ] as const)
        expect((yield* compactor.compress(auth, request, () => {}, runtime).pipe(Effect.exit))._tag).toBe("Failure")
      expect(calls).toEqual(["codex", "claude", "claude", "codex", "claude"])
    }).pipe(
      Effect.provide(
        routing().pipe(
          Layer.provide(Layer.succeed(Compactor, service("codex"))),
          Layer.provide(Layer.succeed(ClaudeCompactor, service("claude")))
        )
      )
    )
  })
)

it.effect("shares one global capacity across both backends", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const codex = {
      compress: Effect.fn("Test.hold")(() =>
        Effect.gen(function* () {
          calls.push("codex")
          yield* Deferred.succeed(first, undefined)
          yield* Deferred.await(release)
          return "codex"
        })
      )
    }
    const claude = {
      compress: Effect.fn("Test.claude")(() =>
        Effect.sync(() => {
          calls.push("claude")
          return "claude"
        })
      )
    }
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const a = yield* compactor.compress({ codexHome: "/codex" }, request, () => {}).pipe(Effect.forkScoped)
      yield* Deferred.await(first)
      const b = yield* compactor.compress({ claudeHome: "/claude" }, request, () => {}).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(calls).toEqual(["codex"])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(a)).toBe("codex")
      expect(yield* Fiber.join(b)).toBe("claude")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        routing(1).pipe(
          Layer.provide(Layer.succeed(Compactor, codex)),
          Layer.provide(Layer.succeed(ClaudeCompactor, claude))
        )
      )
    )
  })
)

it.effect("admits an older waiting project before a busy project reacquires capacity", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const backend = Compactor.of({
      compress: Effect.fn("Test.compactProject")(function* (_auth: unknown, job: CompressionRequest) {
        calls.push(job.source)
        if (job.source === "holder") {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return "summary"
      })
    })
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const compress = (source: string) => compactor.compress(undefined, { ...request, source }, () => {}, "codex")
      const hot = yield* Effect.gen(function* () {
        yield* compress("holder")
        for (let index = 0; index < 20; index++) yield* compress("new hot-project job")
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const waiting = yield* compress("older waiting project").pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(hot)
      yield* Fiber.join(waiting)
      expect(calls[1]).toBe("older waiting project")
      expect(calls).toHaveLength(22)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        routing(1).pipe(
          Layer.provide(Layer.succeed(Compactor, backend)),
          Layer.provide(Layer.succeed(ClaudeCompactor, backend))
        )
      )
    )
  })
)

it.effect("cancels waiting and admitted work without losing compaction capacity", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const calls: string[] = []
    const backend = Compactor.of({
      compress: Effect.fn("Test.cancelCompaction")(function* (_auth: unknown, job: CompressionRequest) {
        calls.push(job.source)
        if (job.source === "active") {
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }
        return "summary"
      })
    })
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const compress = (source: string) => compactor.compress(undefined, { ...request, source }, () => {}, "codex")
      const active = yield* compress("active").pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const waiting = yield* compress("cancelled waiter").pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      yield* Fiber.interrupt(active)
      expect(yield* compress("after cancellation")).toBe("summary")
      expect(calls).toEqual(["active", "after cancellation"])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        routing(1).pipe(
          Layer.provide(Layer.succeed(Compactor, backend)),
          Layer.provide(Layer.succeed(ClaudeCompactor, backend))
        )
      )
    )
  })
)
