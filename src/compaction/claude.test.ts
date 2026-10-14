import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { watch } from "node:fs"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema, Schedule, ManagedRuntime } from "effect"
import type { CompressionRequest, Observation } from "@firfi/unii"
import { ClaudeCompactor, layer } from "./claude.js"
import { CompactionError } from "./compactor.js"
import { claudeEnvironment } from "./claude-process.js"

const executable = fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url))
const run = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const fixture = (mode = "normal") =>
  Effect.promise(async () => {
    const home = await mkdtemp(join(tmpdir(), "slopmemr-claude-test-"))
    directories.push(home)
    await chmod(executable, 0o755)
    await writeFile(join(home, "fixture-mode"), mode)
    return home
  })
const request: CompressionRequest = {
  jobId: "job",
  attemptId: "attempt",
  attempt: 1,
  node: { level: 0, index: 0 },
  source: "Claude fact",
  context: "",
  priorResponses: [],
  feedback: null
}

const waitForHeld = (home: string) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      void readFile(join(home, "events"), "utf8")
        .then((text) => {
          if (text.includes('"held"')) resume(Effect.void)
        })
        .catch(() => {})
    }
    const watcher = watch(home, check)
    check()
    return Effect.sync(() => watcher.close())
  })

it.live("disposes active Claude workers with their layer rather than waiting for the attempt timeout", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    const runtime = ManagedRuntime.make(layer({ executable }))
    const controller = new AbortController()
    const result = runtime
      .runPromise(
        Effect.flatMap(ClaudeCompactor, (service) => service.compress({ claudeHome: home }, request, () => {})),
        { signal: controller.signal }
      )
      .catch(() => "closed")
    try {
      yield* waitForHeld(home)
      yield* Effect.promise(() => runtime.dispose())
      const completed = yield* Effect.promise(() => result).pipe(Effect.timeout("2 seconds"), Effect.exit)
      expect(completed._tag).toBe("Success")
    } finally {
      controller.abort()
      yield* Effect.promise(() => result)
      yield* Effect.promise(() => runtime.dispose())
    }
  })
)

it.live("uses Claude subscription and Haiku without tools or cross-runtime credentials", () =>
  Effect.gen(function* () {
    const home = yield* fixture()
    const observations: Observation[] = []
    const result = yield* Effect.flatMap(ClaudeCompactor, (service) =>
      service.compress({ claudeHome: home }, request, (event) => observations.push(event))
    ).pipe(Effect.provide(layer({ executable })))
    expect(result).toBe("Remember the Claude fact.")
    expect(observations).toContainEqual({
      kind: "usage",
      scope: "attempt",
      counters: { input: 20, output: 5, cachedInput: 3, cacheWriteInput: 0 }
    })
    expect(claudeEnvironment(home).CLAUDE_CONFIG_DIR).toBe(home)
    expect(claudeEnvironment(home).CLAUDE_CODE_SAFE_MODE).toBe("1")
  })
)

it.live.each([
  "api-key",
  "logged-out",
  "third-party",
  "unsafe-login-policy",
  "wrong-profile",
  "tools",
  "mcp",
  "tool-use",
  "unsupported",
  "missing-result",
  "empty",
  "wrong-model",
  "failed",
  "duplicate-result",
  "malformed",
  "oversized",
  "exit",
  "rate-limit-failed"
])("rejects Claude %s without falling back to Codex", (mode) =>
  Effect.gen(function* () {
    const home = yield* fixture(mode)
    const error = yield* Effect.flatMap(ClaudeCompactor, (service) =>
      service.compress({ claudeHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable })), Effect.flip)
    expect(error._tag).toBe("CompactionError")
    if (["api-key", "logged-out", "third-party", "wrong-profile", "unsafe-login-policy"].includes(mode)) {
      const events = yield* Effect.promise(() => readFile(join(home, "events"), "utf8"))
      expect(events).not.toContain('"turn"')
    }
  })
)

it.live("aborts a held Claude process on timeout", () =>
  Effect.gen(function* () {
    const home = yield* fixture("hold")
    const error = yield* Effect.flatMap(ClaudeCompactor, (service) =>
      service.compress({ claudeHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable, timeoutMs: 500 })), Effect.flip)
    expect(error.message).toContain("timed out")
  })
)

it.effect("rejects invalid limits and foreign, missing, relative or unavailable profiles", () =>
  Effect.gen(function* () {
    for (const options of [{ concurrency: 0 }, { perAuthConcurrency: 0 }, { timeoutMs: -1 }]) {
      expect((yield* Effect.asVoid(ClaudeCompactor).pipe(Effect.provide(layer(options)), Effect.exit))._tag).toBe(
        "Failure"
      )
    }
    for (const auth of [
      undefined,
      { codexHome: "/foreign" },
      { claudeHome: "relative" },
      { claudeHome: "/slopmemr-missing-profile" }
    ]) {
      expect(
        (yield* Effect.flatMap(ClaudeCompactor, (service) => service.compress(auth, request, () => {})).pipe(
          Effect.provide(layer({ executable })),
          Effect.exit
        ))._tag
      ).toBe("Failure")
    }
  })
)

it.live("uses only an explicitly configured Claude fallback", () =>
  Effect.gen(function* () {
    const home = yield* fixture()
    const result = yield* Effect.flatMap(ClaudeCompactor, (service) =>
      service.compress(undefined, request, () => {})
    ).pipe(Effect.provide(layer({ executable, fallbackHome: home })))
    expect(result).toBe("Remember the Claude fact.")
  })
)

it.live("accepts informational subscription rate-limit events", () =>
  Effect.gen(function* () {
    const home = yield* fixture("rate-limit")
    const result = yield* Effect.flatMap(ClaudeCompactor, (service) =>
      service.compress({ claudeHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable })))
    expect(result).toBe("Remember the Claude fact.")
  })
)

it.live("kills a TERM-resistant descendant even when its leader exits first", () =>
  Effect.gen(function* () {
    const home = yield* fixture("orphan")
    const error = yield* Effect.flatMap(ClaudeCompactor, (service) =>
      service.compress({ claudeHome: home }, request, () => {})
    ).pipe(Effect.provide(layer({ executable })), Effect.flip)
    expect(error._tag).toBe("CompactionError")
    const text = yield* Effect.promise(() => readFile(join(home, "events"), "utf8"))
    const events = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ event: Schema.String, pid: Schema.Int })))(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    )
    const descendant = events.find((event) => event.event === "descendant")
    expect(descendant).toBeDefined()
    if (descendant === undefined) return
    const stopped = yield* Effect.tryPromise({
      try: async () => {
        try {
          const result = await run("ps", ["-o", "stat=", "-p", String(descendant.pid)], { timeout: 2000 })
          if (!result.stdout.trim().startsWith("Z")) throw new CompactionError({ message: "Descendant still running" })
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === 1)) throw cause
        }
      },
      catch: () => new CompactionError({ message: "Descendant still running" })
    }).pipe(Effect.retry(Schedule.recurs(50).pipe(Schedule.addDelay(() => Effect.succeed(10)))), Effect.exit)
    expect(stopped._tag).toBe("Success")
  })
)
