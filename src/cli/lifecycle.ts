import { spawn } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import { join } from "node:path"
import { privateFileMode } from "../local-state/contracts.js"
import { startupProbeMs, startupRetryCount, startupRetryDelayMs } from "../resident/limits.js"
import { Effect, Schedule } from "effect"
import { request } from "../resident/client.js"
import { prepare, TransportError } from "../resident/endpoint.js"
import type { Endpoint } from "../resident/endpoint.js"
import type { Request, Response } from "../resident/protocol.js"

export const start = Effect.fn("Resident.start")(function* (paths: Endpoint, launch: ProcessLaunch) {
  yield* prepare(paths)
  const running = yield* request(paths, { _tag: "Ping" }, startupProbeMs).pipe(Effect.option)
  if (running._tag === "Some") return yield* confirmReady(running.value)
  yield* Effect.try({
    try: () => {
      const log = openSync(join(paths.directory, "resident.log"), "a", privateFileMode)
      try {
        const child = spawn(launch.executable, [launch.entrypoint, "resident"], {
          detached: true,
          stdio: ["ignore", "ignore", log],
          env: { ...process.env, SLOPMEMR_RUNTIME_DIR: paths.directory }
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
    Effect.flatMap(confirmReady),
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
  if (result._tag === "Failure") return yield* Effect.fail(new TransportError({ message: result.message }))
  return result.value
})

const confirmReady = (response: Response) =>
  response._tag === "Failure"
    ? Effect.fail(new TransportError({ message: "Endpoint refused resident identity verification" }))
    : Effect.succeed(response)
