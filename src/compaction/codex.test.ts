import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { watch } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber, ManagedRuntime, Schema } from "effect"
import { CompactionError, Compactor } from "./compactor.js"
import { layer } from "./codex.js"
import type { CompressionRequest, Observation } from "@firfi/unii"

const executable = fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))
const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const fixture = (mode = "normal", mcp = false) =>
  Effect.promise(async () => {
    const home = await mkdtemp(join(tmpdir(), "slopmemr-auth-"))
    fixtures.push(home)
    await chmod(executable, 0o755)
    await writeFile(join(home, "fixture.json"), JSON.stringify({ mode, mcp }))
    await writeFile(join(home, "events.jsonl"), "")
    return home
  })
const request: CompressionRequest = {
  jobId: "job",
  attemptId: "attempt",
  attempt: 1,
  node: { level: 0, index: 0 },
  source: "A factual decision",
  context: "Earlier context",
  priorResponses: [],
  feedback: null
}
const Event = Schema.Struct({
  event: Schema.String,
  pid: Schema.Number,
  apiKeyPresent: Schema.optionalKey(Schema.Boolean),
  params: Schema.optionalKey(Schema.Unknown)
})
const events = async (home: string) =>
  (await readFile(join(home, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(Event)(JSON.parse(line)))

const waitForHeld = (home: string, count: number) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const watcher = watch(home, () => {
          void check()
        })
        const cleanup = () => {
          watcher.close()
          signal.removeEventListener("abort", abort)
        }
        const abort = () => {
          cleanup()
          reject(new CompactionError({ message: "Interrupted" }))
        }
        const check = async () => {
          try {
            if ((await events(home)).filter((event) => event.event === "held").length >= count) {
              cleanup()
              resolve()
            }
          } catch (cause) {
            cleanup()
            reject(cause)
          }
        }
        signal.addEventListener("abort", abort, { once: true })
        void check()
      }),
    catch: () => new CompactionError({ message: "Fixture synchronization failed" })
  })

it.live("reuses the explicit caller profile, disables inherited MCP, and waits for completed summary and usage", () =>
  Effect.gen(function* () {
    const home = yield* fixture("normal", true)
    const observations: Observation[] = []
    const result = yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      return yield* compactor.compress({ codexHome: home }, request, (event) => observations.push(event))
    }).pipe(Effect.provide(layer({ executable })))
    expect(result).toBe("Remember the factual decision.")
    const log = yield* Effect.promise(() => events(home))
    expect(log.filter((event) => event.event === "started")).toHaveLength(2)
    expect(log.filter((event) => event.event === "stopped")).toHaveLength(2)
    expect(log.filter((event) => event.event === "thread")).toHaveLength(1)
    const thread = Schema.decodeUnknownSync(
      Schema.Struct({ ephemeral: Schema.Boolean, sandbox: Schema.String, allowProviderModelFallback: Schema.Boolean })
    )(log.find((event) => event.event === "thread")?.params)
    expect(thread).toEqual({ ephemeral: true, sandbox: "read-only", allowProviderModelFallback: false })
    expect(log.every((event) => event.apiKeyPresent !== true)).toBe(true)
    expect(observations).toContainEqual({
      kind: "usage",
      scope: "attempt",
      counters: { input: 20, output: 4, cachedInput: 3 }
    })
  })
)

it.live.each([
  "api-key",
  "logged-out",
  "account-changed",
  "unsafe",
  "missing-model",
  "tool",
  "request",
  "failed",
  "malformed",
  "exit"
])("fails visibly and closes the worker for %s", (mode) =>
  Effect.gen(function* () {
    const home = yield* fixture(mode)
    const error = yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      return yield* compactor.compress({ codexHome: home }, request, () => {})
    }).pipe(Effect.provide(layer({ executable, timeoutMs: 2_000 })), Effect.flip)
    expect(error._tag).toBe("CompactionError")
    const log = yield* Effect.promise(() => events(home))
    expect(log.filter((event) => event.event === "started")).toHaveLength(1)
    if (["api-key", "logged-out", "unsafe", "missing-model"].includes(mode))
      expect(log.some((event) => event.event === "turn")).toBe(false)
  })
)

it.live("cancels a running app-server process when the caller interrupts", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const fiber = yield* compactor.compress({ codexHome: home }, request, () => {}).pipe(Effect.forkScoped)
      yield* waitForHeld(home, 1)
      yield* Fiber.interrupt(fiber)
      const log = yield* Effect.promise(() => events(home))
      expect(log.some((event) => event.event === "stopped")).toBe(true)
    }).pipe(Effect.provide(layer({ executable })))
  })
)

it.live("bounds auth-profile concurrency while other callers wait without spawning more workers", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const fibers = yield* Effect.all(
        Array.from({ length: 5 }, () =>
          compactor.compress({ codexHome: home }, request, () => {}).pipe(Effect.forkScoped)
        )
      )
      yield* waitForHeld(home, 2)
      expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "started")).toHaveLength(2)
      yield* Effect.promise(() => writeFile(join(home, "release"), "complete"))
      for (const fiber of fibers) expect(yield* Fiber.join(fiber)).toBe("Remember the factual decision.")
    }).pipe(Effect.provide(layer({ executable, concurrency: 4, perAuthConcurrency: 2 })))
  })
)

it.live("finalizes all active workers when its layer is disposed", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    const runtime = ManagedRuntime.make(layer({ executable }))
    try {
      const result = runtime.runPromise(
        Effect.flatMap(Compactor, (service) => service.compress({ codexHome: home }, request, () => {}))
      )
      void result.catch(() => {})
      yield* waitForHeld(home, 1)
      yield* Effect.promise(() => runtime.dispose())
      yield* Effect.promise(() => result.catch(() => "cancelled"))
      expect((yield* Effect.promise(() => events(home))).some((event) => event.event === "stopped")).toBe(true)
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live.each([
  "rpc-error",
  "missing-result",
  "unknown-id",
  "invalid-envelope",
  "string-id",
  "oversized-line",
  "oversized-stream",
  "bad-notification",
  "bad-account-update",
  "commentary-only",
  "agent-message-no-text",
  "empty-summary",
  "feature-null",
  "feature-enabled-object",
  "feature-unknown",
  "account-auth-not-required",
  "wrong-provider",
  "unsafe-web-search",
  "catalog-cycle"
])("rejects hostile protocol/configuration %s and retains no unsafe response", (mode) =>
  Effect.gen(function* () {
    const home = yield* fixture(mode)
    const result = yield* Effect.flatMap(Compactor, (compactor) =>
      compactor.compress({ codexHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable, timeoutMs: 2000 })), Effect.flip)
    expect(result._tag).toBe("CompactionError")
    expect(result.message).not.toContain("must-not-log")
  })
)

it.live.each([
  "blank-lines",
  "wrong-thread-events",
  "account-update-unchanged",
  "catalog-page",
  "no-mcp-property",
  "resistant"
])("handles bounded compatible protocol %s", (mode) =>
  Effect.gen(function* () {
    const home = yield* fixture(mode)
    const text = yield* Effect.flatMap(Compactor, (compactor) =>
      compactor.compress({ codexHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable })))
    expect(text).toBe("Remember the factual decision.")
  })
)

it.live("rejects inherited MCP which fails to disable and times out a held turn", () =>
  Effect.gen(function* () {
    const home = yield* fixture("mcp-stays-enabled", true)
    expect(
      (yield* Effect.flatMap(Compactor, (compactor) => compactor.compress({ codexHome: home }, request, () => {})).pipe(
        Effect.provide(layer({ executable })),
        Effect.exit
      ))._tag
    ).toBe("Failure")
    expect((yield* Effect.promise(() => events(home))).some((event) => event.event === "thread")).toBe(false)
    const held = yield* fixture("hold")
    const result = yield* Effect.flatMap(Compactor, (compactor) =>
      compactor.compress({ codexHome: held }, request, () => {})
    ).pipe(Effect.provide(layer({ executable, timeoutMs: 100 })), Effect.flip)
    expect(result.message).toContain("timed out")
  })
)

it.effect("validates worker limits and profile selection before opening provider processes", () =>
  Effect.gen(function* () {
    for (const options of [{ concurrency: 0 }, { perAuthConcurrency: 0 }, { timeoutMs: -1 }]) {
      expect((yield* Effect.asVoid(Compactor).pipe(Effect.provide(layer(options)), Effect.exit))._tag).toBe("Failure")
    }
    const select = (codexHome?: string) =>
      Effect.flatMap(Compactor, (compactor) =>
        compactor.compress(codexHome === undefined ? undefined : { codexHome }, request, () => {})
      ).pipe(Effect.provide(layer({ executable })), Effect.exit)
    expect((yield* select())._tag).toBe("Failure")
    expect((yield* select("relative"))._tag).toBe("Failure")
    expect((yield* select("/slopmemr-does-not-exist"))._tag).toBe("Failure")
  })
)

it.live("reuses an explicit fallback and enforces a bounded auth-profile registry without eviction", () =>
  Effect.gen(function* () {
    const home = yield* fixture()
    const fallback = yield* Effect.flatMap(Compactor, (compactor) =>
      compactor.compress(undefined, request, () => {})
    ).pipe(Effect.provide(layer({ executable, fallbackHome: home })))
    expect(fallback).toBe("Remember the factual decision.")
    const parent = yield* fixture()
    const homes = yield* Effect.promise(async () => {
      const paths = Array.from({ length: 257 }, (_, index) => join(parent, String(index)))
      await Promise.all(paths.map((path) => mkdir(path)))
      return paths
    })
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      for (const [index, codexHome] of homes.entries()) {
        const error = yield* compactor.compress({ codexHome }, request, () => {}).pipe(Effect.flip)
        expect(error.message).toBe(index === 256 ? "Auth profile capacity reached" : "Cannot start Codex compactor")
      }
    }).pipe(Effect.provide(layer({ executable: "codex\0" })))
  })
)
