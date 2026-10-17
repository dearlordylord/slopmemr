import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type { CompressionRequest } from "@firfi/unii"
import { Compactor } from "./compactor.js"
import { ClaudeCompactor } from "./claude.js"
import { layer, routing } from "./backends.js"

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

it.live("a saturated Codex login leaves shared capacity available to the actual Claude adapter", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-routing-"))),
    (directory) =>
      Effect.gen(function* () {
        const codexHome = join(directory, "codex")
        const claudeHome = join(directory, "claude")
        const codexExecutable = fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))
        const claudeExecutable = fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url))
        yield* Effect.promise(async () => {
          await Promise.all([
            mkdir(codexHome),
            mkdir(claudeHome),
            chmod(codexExecutable, 0o755),
            chmod(claudeExecutable, 0o755)
          ])
          await writeFile(join(codexHome, "fixture.json"), JSON.stringify({ mode: "hold" }))
          await writeFile(join(codexHome, "events.jsonl"), "")
          await writeFile(join(claudeHome, "fixture-mode"), "normal")
        })
        const entered = yield* Deferred.make<void>()
        yield* Effect.gen(function* () {
          const compactor = yield* Compactor
          const active = yield* compactor
            .compress({ codexHome }, request, (event) => {
              if (event.kind === "submission") Effect.runSync(Deferred.succeed(entered, undefined))
            })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const waiting = yield* compactor.compress({ codexHome }, request, () => {}).pipe(Effect.forkScoped)
          yield* Effect.yieldNow
          expect(yield* compactor.compress({ claudeHome }, request, () => {}, "claude")).toBe(
            "Remember the Claude fact."
          )
          yield* Effect.promise(() => writeFile(join(codexHome, "release"), "complete"))
          expect(yield* Fiber.join(active)).toBe("Remember the factual decision.")
          expect(yield* Fiber.join(waiting)).toBe("Remember the factual decision.")
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layer(
              { executable: codexExecutable, concurrency: 2, perAuthConcurrency: 1 },
              { executable: claudeExecutable, perAuthConcurrency: 1 }
            )
          )
        )
      }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )
)
