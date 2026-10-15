import { spawn } from "node:child_process"
import { openSync, closeSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import { join } from "node:path"
import { privateFileMode } from "../local-state/contracts.js"
import { startupProbeMs, startupRetryCount, startupRetryDelayMs } from "./limits.js"
import { Config, Effect, Schedule, Schema } from "effect"
import { readSelection, selectionFiles } from "../local-state/runtime-selection.js"
import type { RuntimeSelection, RuntimeTarget } from "../local-state/runtime-selection.js"
import { Ping } from "./identity.js"
import { request } from "./client.js"
import { prepare, TransportError } from "./endpoint.js"
import type { Endpoint } from "./endpoint.js"
import type { Request, Response } from "./protocol.js"

export const start = Effect.fn("Resident.start")(function* (paths: Endpoint, launch: ProcessLaunch) {
  yield* prepare(paths)
  const selected = yield* selection()
  const running = yield* request(paths, { _tag: "Ping" }, startupProbeMs).pipe(Effect.option)
  if (running._tag === "Some") return yield* confirmReady(running.value, selected)
  // Re-read after waiting for another starter/previous owner. Never revive a
  // target cached by an older hook or MCP process before an update.
  const current = yield* selection()
  const target = current?.launch ?? launch
  yield* Effect.try({
    try: () => {
      const log = openSync(join(paths.directory, "resident.log"), "a", privateFileMode)
      try {
        if (
          current !== undefined &&
          createHash("sha256").update(readFileSync(target.entrypoint)).digest("hex") !== current.implementation
        )
          throw new Error("Modified selected resident")
        const child = spawn(target.executable, [target.entrypoint, "resident"], {
          detached: true,
          stdio: ["ignore", "ignore", log],
          env: {
            ...process.env,
            SLOPMEMR_RUNTIME_DIR: paths.directory,
            ...(current === undefined ? {} : { SLOPMEMR_DATA_DIR: current.dataDirectory })
          }
        })
        child.on("error", () => {})
        child.unref()
      } finally {
        closeSync(log)
      }
    },
    catch: () => new TransportError({ message: "Cannot launch resident; build the project first" })
  })
  return yield* request(paths, { _tag: "Ping" }, startupProbeMs).pipe(
    Effect.retry(Schedule.recurs(startupRetryCount).pipe(Schedule.addDelay(() => Effect.succeed(startupRetryDelayMs)))),
    Effect.timeout("12 seconds"),
    Effect.flatMap((response) => confirmReady(response, current)),
    Effect.mapError(() => new TransportError({ message: "Resident did not become ready; inspect resident.log" }))
  )
})

export const send = Effect.fn("Resident.send")(function* (
  paths: Endpoint,
  value: Request,
  launch: ProcessLaunch,
  timeoutMs = 5_000
) {
  yield* start(paths, launch)
  const result = yield* request(paths, value, timeoutMs)
  if (result._tag === "Failure")
    return yield* Effect.fail(
      new TransportError({
        message: result.message,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable })
      })
    )
  return result.value
})

export const selection = Effect.fn("Resident.selection")(function* () {
  const directory = yield* Config.NonEmptyString("SLOPMEMR_DATA_DIR").pipe(
    Config.withDefault(join(homedir(), ".local", "share", "slopmemr")),
    Effect.mapError(() => new TransportError({ message: "Invalid memory data directory" }))
  )
  return yield* Effect.try({
    try: () => readSelection(directory, selectionFiles),
    catch: () => new TransportError({ message: "Shared resident selection is unavailable or unsafe" })
  })
})

const confirmReady = Effect.fn("Resident.confirmReady")(function* (
  response: Response,
  selected: RuntimeSelection | undefined
) {
  if (response._tag === "Failure")
    return yield* Effect.fail(new TransportError({ message: "Endpoint refused resident identity verification" }))
  const ping = yield* Schema.decodeUnknownEffect(Ping)(response.value).pipe(
    Effect.mapError(() => new TransportError({ message: "Invalid resident identity" }))
  )
  if (selected !== undefined && !matchesSelection(ping, selected))
    return yield* Effect.fail(
      new TransportError({
        message: "The selected build is not serving; run slopmemr restart or finish update",
        retryable: false
      })
    )
  return response
})

export const matchesSelection = (ping: typeof Ping.Type, selected: RuntimeTarget): boolean =>
  ping.implementation === selected.implementation &&
  ping.entrypoint === selected.launch.entrypoint &&
  ping.executable === selected.launch.executable &&
  ping.dataDirectory === selected.dataDirectory
