import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, afterEach } from "vitest"
import { it } from "@effect/vitest"
import { Console, ConfigProvider, Effect, Fiber, Schedule } from "effect"
import { program as fastHook } from "../intake/program.js"
import { deliver } from "../installation/delivery.js"
import { InstallationError } from "../installation/contracts.js"
import { program } from "./program.js"
import { CliError } from "./errors.js"
import { printJson, reportFailure } from "./output.js"
import { readInput } from "./input.js"
import { configuration } from "./configuration.js"
import { request } from "../resident/client.js"
import { endpoint } from "../resident/endpoint.js"
import { maxFrameBytes } from "../resident/limits.js"

const capture = () => {
  const messages: unknown[] = []
  const collect = (...values: ReadonlyArray<unknown>) => {
    messages.push(...values)
  }
  const ignore = () => {}
  const port: Console.Console = {
    assert: ignore,
    clear: ignore,
    count: ignore,
    countReset: ignore,
    debug: ignore,
    dir: ignore,
    dirxml: ignore,
    error: collect,
    group: ignore,
    groupCollapsed: ignore,
    groupEnd: ignore,
    info: ignore,
    log: collect,
    table: ignore,
    time: ignore,
    timeEnd: ignore,
    timeLog: ignore,
    trace: ignore,
    warn: ignore
  }
  return { messages, port }
}
const input = async function* (value: unknown) {
  yield Buffer.from(JSON.stringify(value))
}
const launch = { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") }
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const fixture = async (aliasedData = false) => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr-program-"))
  directories.push(directory)
  const root = join(directory, "root"),
    profile = join(directory, "profile")
  await mkdir(root)
  await mkdir(profile, { mode: 0o700 })
  if (aliasedData) await symlink(directory, join(directory, "alias"))
  const data = aliasedData ? join(directory, "alias", "data") : join(directory, "data")
  const paths = endpoint(join(directory, "run"))
  const provider = ConfigProvider.layer(
    ConfigProvider.fromEnvRecord({
      SLOPMEMR_RUNTIME_DIR: paths.directory,
      SLOPMEMR_DATA_DIR: data,
      SLOPMEMR_BIN_DIR: join(directory, "bin"),
      CODEX_HOME: profile
    })
  )
  return { directory, root, profile, paths, provider }
}

it.live("runs the full CLI workflow against its scoped resident using explicit input/configuration/console ports", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(() => fixture(true))
    const output = capture()
    yield* Effect.gen(function* () {
      const foreground = yield* program(["resident"], launch).pipe(Effect.forkScoped)
      yield* request(f.paths, { _tag: "Ping" }).pipe(
        Effect.retry(Schedule.recurs(100).pipe(Schedule.addDelay(() => Effect.succeed(10))))
      )
      for (const runtime of ["codex", "claude"]) {
        for (const event of ["SessionStart", "Stop", "UserPromptSubmit"]) {
          yield* fastHook(
            ["--runtime", runtime],
            launch,
            input({ hook_event_name: event, session_id: `fast-${runtime}`, cwd: f.root })
          )
        }
      }
      yield* fastHook(
        [
          "--runtime",
          "codex",
          "--codex-home",
          f.profile,
          "--root",
          f.root,
          "--resident-bin",
          launch.executable,
          "--resident-entry",
          launch.entrypoint
        ],
        launch,
        input({ hook_event_name: "Stop", session_id: "explicit", cwd: f.root })
      )
      yield* fastHook(
        ["--runtime", "claude", "--claude-home", f.profile],
        launch,
        input({ hook_event_name: "Stop", session_id: "explicit", cwd: f.root })
      )
      const unavailable = yield* request(f.paths, { _tag: "ReadSnapshot", root: join(f.directory, "missing-root") })
      expect(unavailable).toMatchObject({ _tag: "Failure", code: "ROOT_UNAVAILABLE", retryable: false })
      const run = (args: ReadonlyArray<string>, value: unknown = {}) => program(args, launch, input(value))
      yield* run(["help"])
      yield* run(["start"])
      yield* run(["append"], {
        root: f.root,
        agent: { runtime: "custom", sessionId: "s", agentId: "root" },
        eventId: "1",
        kind: "note",
        text: "Remember program ports"
      })
      yield* run(["request"], { _tag: "Status", root: f.root })
      for (const name of ["snapshot", "status", "settle"]) yield* run([name, "--root", f.root])
      yield* run(["zoom", "--root", f.root, "--first", "0", "--count", "1"])
      yield* run(["roots"])
      const hook = { hook_event_name: "Stop", session_id: "hook-session", cwd: f.root, last_assistant_message: "done" }
      yield* run(["hook", "--runtime", "codex", "--root", f.root], hook)
      yield* run(["hook", "--runtime", "claude", "--claude-home", f.profile], hook)
      yield* run(["hook", "--runtime", "claude"], { ...hook, hook_event_name: "UserPromptSubmit", prompt: "short" })
      yield* run(["hook-config", "--runtime", "codex"])
      yield* run(["hook-config", "--runtime", "claude", "--root", f.root, "--claude-home", f.profile])
      yield* run(["stop"])
      yield* Fiber.join(foreground)
      yield* run(["setup", "claude", "--profile", f.profile])
      yield* run(["repair", "claude", "--profile", f.profile])
      const interrupted = yield* deliver(
        { action: "Setup", publicDirectory: join(f.directory, "bin") },
        { runtime: "claude", profile: f.profile },
        launch,
        join(f.directory, "data"),
        () => Effect.void,
        () => Effect.fail(new InstallationError({ operation: "test", message: "interrupt before activation" }))
      ).pipe(Effect.exit)
      expect(interrupted._tag).toBe("Failure")
      yield* run(["repair", "claude", "--profile", f.profile])
      yield* run(["update", "claude", "--profile", f.profile, "--claude-home", f.profile])
      yield* run(["restart"])
      yield* run(["doctor", "claude", "--profile", f.profile])
      yield* run(["uninstall", "claude", "--profile", f.profile])
      yield* run(["stop"])
      yield* Fiber.join(foreground)
      expect(
        output.messages.some((value) => typeof value === "string" && value.includes("Remember program ports"))
      ).toBe(true)
      expect(output.messages).toContain("{}")
    }).pipe(Effect.scoped, Effect.provide(f.provider), Effect.provideService(Console.Console, output.port))
  })
)

it.effect("uses explicit fallback profiles and validates runtime limits through Config", () =>
  Effect.gen(function* () {
    const defaults = yield* configuration.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))))
    expect(defaults.callerHome).toContain(".codex")
    const config = yield* configuration.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CODEX_HOME: "/calling", SLOPMEMR_CODEX_HOME: "/fallback" }))
      )
    )
    expect(config.callerHome).toBe("/calling")
    expect(config.compactor.fallbackHome).toBe("/fallback")
  })
)

it.effect("sanitizes errors and bounds streaming stdin without logging source input", () =>
  Effect.gen(function* () {
    const output = capture()
    const previousExitCode = process.exitCode
    try {
      yield* reportFailure(new CliError({ message: "Safe operational error" })).pipe(
        Effect.provideService(Console.Console, output.port)
      )
      yield* reportFailure({ source: "secret" }).pipe(Effect.provideService(Console.Console, output.port))
      yield* reportFailure(Object.assign(new Error("secret"), { name: "SchemaError" })).pipe(
        Effect.provideService(Console.Console, output.port)
      )
      expect(process.exitCode).toBe(1)
      expect(output.messages).not.toContain("secret")
    } finally {
      process.exitCode = previousExitCode
    }
    expect(
      (yield* readInput(
        (async function* () {
          yield "not-json"
        })()
      ).pipe(Effect.exit))._tag
    ).toBe("Failure")
    expect(
      (yield* readInput(
        (async function* () {
          yield 5
        })()
      ).pipe(Effect.exit))._tag
    ).toBe("Failure")
    expect(
      (yield* readInput(
        (async function* () {
          yield "x".repeat(maxFrameBytes + 1)
        })()
      ).pipe(Effect.exit))._tag
    ).toBe("Failure")
    expect(
      yield* readInput(
        (async function* () {
          yield '{"valid":'
          yield Buffer.from("true}")
        })()
      )
    ).toEqual({ valid: true })
    expect((yield* printJson(undefined).pipe(Effect.exit))._tag).toBe("Failure")
  })
)
