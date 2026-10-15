import { DatabaseSync } from "node:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schedule, Schema } from "effect"
import { request } from "./client.js"
import { TransportError } from "./endpoint.js"
import type { Endpoint } from "./endpoint.js"
import { Ping, ServingIdentity } from "./identity.js"
import { matchesSelection, start } from "./startup.js"
import type { RuntimeSelection } from "../local-state/runtime-selection.js"
import { startupProbeMs, startupRetryDelayMs } from "./limits.js"

const probe = Effect.fn("Resident.probe")(function* (paths: Endpoint) {
  const response = yield* request(paths, { _tag: "Ping" }, startupProbeMs, true)
  if (response._tag === "Failure")
    return yield* Effect.fail(new TransportError({ message: "Resident refused identity inspection" }))
  return yield* Schema.decodeUnknownEffect(Ping)(response.value).pipe(
    Effect.mapError(() => new TransportError({ message: "Resident identity is incompatible" }))
  )
})

const awaitStopped = Effect.fn("Resident.awaitStopped")(function* (
  paths: Endpoint,
  selected: RuntimeSelection,
  retiringPid?: number
) {
  const check = Effect.gen(function* () {
    const current = yield* probe(paths).pipe(Effect.option)
    if (Option.isSome(current) && current.value.pid !== retiringPid && matchesSelection(current.value, selected))
      return true
    if (Option.isSome(current) || !(yield* ownershipReleased(paths)))
      return yield* Effect.fail(new TransportError({ message: "Previous resident still owns the endpoint" }))
    return false
  })
  return yield* check.pipe(
    Effect.retry({ schedule: Schedule.spaced(startupRetryDelayMs), while: (error) => error.retryable !== false }),
    Effect.timeout("40 seconds")
  )
})

export const activate = Effect.fn("Resident.activate")(function* (
  paths: Endpoint,
  selected: RuntimeSelection,
  startIfMissing: boolean,
  force = false,
  reconcile?: (observed: typeof Ping.Type) => Effect.Effect<void, TransportError>
) {
  const current = yield* probe(paths).pipe(Effect.option)
  if (Option.isNone(current)) return yield* activateMissing(paths, selected, startIfMissing)
  if (!force && matchesSelection(current.value, selected))
    return { serving: true, changed: false, implementation: selected.implementation }
  yield* verifyOwner(current.value, selected, reconcile)
  if (current.value.guardedShutdown !== true)
    return yield* Effect.fail(
      new TransportError({
        message: "Resident lacks guarded shutdown; explicitly run slopmemr stop, then repeat update",
        retryable: false
      })
    )
  const expected = yield* Schema.decodeUnknownEffect(ServingIdentity)(current.value).pipe(
    Effect.mapError(
      () =>
        new TransportError({ message: "Previous resident identity is incomplete; refusing shutdown", retryable: false })
    )
  )
  const stopped = yield* request(paths, { _tag: "Shutdown", expected })
  if (stopped._tag === "Failure")
    return yield* Effect.fail(new TransportError({ message: "Previous resident refused graceful shutdown" }))
  return yield* finishActivation(paths, selected, current.value.pid)
})

const activateMissing = Effect.fn("Resident.activateMissing")(function* (
  paths: Endpoint,
  selected: RuntimeSelection,
  enabled: boolean
) {
  if (!enabled) return { serving: false, changed: false, implementation: selected.implementation }
  return yield* finishActivation(paths, selected)
})

const finishActivation = Effect.fn("Resident.finishActivation")(function* (
  paths: Endpoint,
  selected: RuntimeSelection,
  retiringPid?: number
) {
  if (yield* awaitStopped(paths, selected, retiringPid))
    return { serving: true, changed: true, implementation: selected.implementation }
  return yield* startAndVerify(paths, selected)
})

const startAndVerify = Effect.fn("Resident.startAndVerify")(function* (paths: Endpoint, selected: RuntimeSelection) {
  yield* start(paths, selected.launch)
  const serving = yield* probe(paths)
  if (!matchesSelection(serving, selected))
    return yield* Effect.fail(new TransportError({ message: "Activation did not start the selected resident build" }))
  return { serving: true, changed: true, implementation: serving.implementation }
})

export const inspect = Effect.fn("Resident.inspect")(function* (paths: Endpoint) {
  return yield* probe(paths).pipe(
    Effect.option,
    Effect.map((value) => Option.getOrNull(value))
  )
})

const ownershipReleased = Effect.fn("Resident.ownershipReleased")(function* (paths: Endpoint) {
  return yield* Effect.try({
    try: () => {
      const path = join(paths.directory, "resident-owner.sqlite")
      if (!existsSync(path)) return true
      const db = new DatabaseSync(path)
      try {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK")
        return true
      } catch (cause) {
        if (busyDatabase(cause)) return false
        throw cause
      } finally {
        db.close()
      }
    },
    catch: () => new TransportError({ message: "Cannot inspect resident ownership", retryable: false })
  })
})
const busyDatabase = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "errcode" in cause &&
  (cause.errcode === sqliteBusy || cause.errcode === sqliteLocked)

const identifiedOwner = (current: typeof Ping.Type, selected: RuntimeSelection): boolean =>
  matchesSelection(current, selected) ||
  (selected.previous !== undefined && matchesSelection(current, selected.previous))

const sqliteBusy = 5
const sqliteLocked = 6

const verifyOwner = Effect.fn("Resident.verifyOwner")(function* (
  observed: typeof Ping.Type,
  selected: RuntimeSelection,
  reconcile: ((observed: typeof Ping.Type) => Effect.Effect<void, TransportError>) | undefined
) {
  if (identifiedOwner(observed, selected)) return
  if (reconcile !== undefined) return yield* reconcile(observed)
  return yield* Effect.fail(
    new TransportError({ message: "Endpoint serves an unexpected resident; refusing shutdown", retryable: false })
  )
})
