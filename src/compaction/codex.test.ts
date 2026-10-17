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

const waitForEvent = (home: string, kind: string, count: number) =>
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
            if ((await events(home)).filter((event) => event.event === kind).length >= count) {
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
      yield* waitForEvent(home, "held", 1)
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
      yield* waitForEvent(home, "held", 2)
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
      yield* waitForEvent(home, "held", 1)
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

it.live("reuses a verified worker for separate ephemeral summary threads", () =>
  Effect.gen(function* () {
    const home = yield* fixture("normal", true)
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      for (let index = 0; index < 3; index++)
        expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      const log = yield* Effect.promise(() => events(home))
      expect(log.filter((event) => event.event === "started")).toHaveLength(2)
      expect(log.filter((event) => event.event === "thread")).toHaveLength(3)
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 1 })))
    const log = yield* Effect.promise(() => events(home))
    expect(log.filter((event) => event.event === "stopped")).toHaveLength(2)
  })
)

it.live("uses at most five workers for one profile and reuses them across queued requests", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const fibers = []
      for (let index = 0; index < 12; index++)
        fibers.push(yield* compactor.compress({ codexHome: home }, request, () => {}).pipe(Effect.forkScoped))
      yield* waitForEvent(home, "held", 5)
      expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "started")).toHaveLength(5)
      yield* Effect.promise(() => writeFile(join(home, "release"), "complete"))
      for (const fiber of fibers) expect(yield* Fiber.join(fiber)).toBe("Remember the factual decision.")
      const log = yield* Effect.promise(() => events(home))
      expect(log.filter((event) => event.event === "started")).toHaveLength(5)
      expect(log.filter((event) => event.event === "unsubscribed")).toHaveLength(12)
      const starts = log
        .filter((event) => event.event === "thread")
        .map((event) =>
          Schema.decodeUnknownSync(Schema.Struct({ cwd: Schema.String, ephemeral: Schema.Boolean }))(event.params)
        )
      expect(new Set(starts.map((entry) => entry.cwd)).size).toBe(12)
      expect(starts.every((entry) => entry.ephemeral)).toBe(true)
    }).pipe(Effect.provide(layer({ executable })))
  })
)

it.live("cancels one lease without killing other active summaries", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      const first = yield* compactor.compress({ codexHome: home }, request, () => {}).pipe(Effect.forkScoped)
      const second = yield* compactor.compress({ codexHome: home }, request, () => {}).pipe(Effect.forkScoped)
      yield* waitForEvent(home, "held", 2)
      yield* Fiber.interrupt(first)
      expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "stopped")).toHaveLength(1)
      yield* Effect.promise(() => writeFile(join(home, "release"), "complete"))
      expect(yield* Fiber.join(second)).toBe("Remember the factual decision.")
      expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 2 })))
  })
)

it.live("replaces an idle worker which exited before the next summary", () =>
  Effect.gen(function* () {
    const home = yield* fixture()
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      const log = yield* Effect.promise(() => events(home))
      const started = log.find((event) => event.event === "started")
      expect(started).toBeDefined()
      if (started === undefined) throw new Error("Missing worker process")
      yield* Effect.sync(() => process.kill(started.pid, "SIGTERM"))
      yield* waitForEvent(home, "stopped", 1)
      expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "started")).toHaveLength(2)
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 1 })))
  })
)

it.live.each(["config.toml", "auth.json"])("retires an idle worker after %s generation changes", (name) =>
  Effect.gen(function* () {
    const home = yield* fixture()
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      yield* Effect.promise(() => writeFile(join(home, name), "{}"))
      expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      const log = yield* Effect.promise(() => events(home))
      expect(log.filter((event) => event.event === "started")).toHaveLength(2)
      expect(log.filter((event) => event.event === "stopped")).toHaveLength(1)
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 1 })))
  })
)

it.live("keeps distinct calling profiles in distinct worker pools", () =>
  Effect.gen(function* () {
    const first = yield* fixture()
    const second = yield* fixture()
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      for (const home of [first, second, first, second])
        expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      for (const home of [first, second])
        expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "started")).toHaveLength(1)
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 1 })))
  })
)

it.live("checks current subscription mode before reusing a warm worker", () =>
  Effect.gen(function* () {
    const home = yield* fixture()
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      yield* compactor.compress({ codexHome: home }, request, () => {})
      yield* Effect.promise(() => writeFile(join(home, "fixture.json"), JSON.stringify({ mode: "api-key" })))
      const error = yield* compactor.compress({ codexHome: home }, request, () => {}).pipe(Effect.flip)
      expect(error.message).toContain("ChatGPT login")
      const log = yield* Effect.promise(() => events(home))
      expect(log.filter((event) => event.event === "turn")).toHaveLength(1)
      expect(log.filter((event) => event.event === "stopped")).toHaveLength(1)
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 1 })))
  })
)

it.live("bounds worker initialization and cleans up a stalled acquisition", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold-initialize")
    const result = yield* Effect.flatMap(Compactor, (compactor) =>
      compactor.compress({ codexHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable, timeoutMs: 200 })), Effect.flip)
    expect(result.message).toContain("timed out")
    expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "stopped")).toHaveLength(1)
  })
)

it.live("applies response byte limits per attempt rather than across the lifetime of a reused worker", () =>
  Effect.gen(function* () {
    const home = yield* fixture("reuse-byte-budget")
    yield* Effect.gen(function* () {
      const compactor = yield* Compactor
      for (let repeat = 0; repeat < 2; repeat++)
        expect(yield* compactor.compress({ codexHome: home }, request, () => {})).toBe("Remember the factual decision.")
      expect((yield* Effect.promise(() => events(home))).filter((event) => event.event === "started")).toHaveLength(1)
    }).pipe(Effect.provide(layer({ executable, perAuthConcurrency: 1 })))
  })
)

it.live("keeps canceled initialization scoped and bounded without submitting source", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold-initialize")
    const runtime = ManagedRuntime.make(layer({ executable, timeoutMs: 300 }))
    const controller = new AbortController()
    const pending = runtime
      .runPromise(
        Effect.flatMap(Compactor, (compactor) => compactor.compress({ codexHome: home }, request, () => {})),
        { signal: controller.signal }
      )
      .catch(() => "cancelled")
    try {
      yield* waitForEvent(home, "initializing", 1)
      controller.abort()
      expect(yield* Effect.promise(() => pending)).toBe("cancelled")
      yield* waitForEvent(home, "stopped", 1)
      const log = yield* Effect.promise(() => events(home))
      expect(log.some((event) => event.event === "thread" || event.event === "turn")).toBe(false)
      yield* Effect.promise(() => writeFile(join(home, "fixture.json"), JSON.stringify({ mode: "normal" })))
      expect(
        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.flatMap(Compactor, (compactor) => compactor.compress({ codexHome: home }, request, () => {}))
          )
        )
      ).toBe("Remember the factual decision.")
    } finally {
      controller.abort()
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)
