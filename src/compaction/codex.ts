import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Duration, Effect, Exit, Layer, Option, Pool, ScopedCache } from "effect"
import type { CompressionRequest, Observation } from "@firfi/unii"
import type { AuthReference } from "./profile.js"
import type { Capacity } from "./capacity.js"
import { makeAdmission } from "./admission.js"
import type { WorkerOptions } from "./codex-worker.js"
import { acquireWorker, reusable, useWorker } from "./codex-worker.js"
import {
  defaultConcurrency,
  defaultPerAuthConcurrency,
  defaultAttemptTimeoutMs,
  maximumAuthProfiles,
  maximumWorkerLeaseChecks,
  workerIdleTimeToLive
} from "./limits.js"
import { CompactionError, Compactor } from "./compactor.js"

export interface Options extends WorkerOptions {
  readonly concurrency?: number
  readonly perAuthConcurrency?: number
  readonly timeoutMs?: number
  readonly fallbackHome?: string
}

export const layer = (options: Options = {}, shared?: Capacity) =>
  Layer.effect(
    Compactor,
    Effect.gen(function* () {
      const concurrency = options.concurrency ?? defaultConcurrency
      const perAuth = options.perAuthConcurrency ?? defaultPerAuthConcurrency
      const timeoutMs = options.timeoutMs ?? defaultAttemptTimeoutMs
      if (![concurrency, perAuth, timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0))
        return yield* Effect.fail(new CompactionError({ message: "Compactor limits must be positive integers" }))
      const admission = yield* makeAdmission(concurrency, perAuth, shared)
      const pools = yield* ScopedCache.make({
        capacity: maximumAuthProfiles,
        timeToLive: Duration.infinity,
        lookup: (home: string) =>
          Pool.makeWithTTL({
            acquire: acquireWorker(home, options).pipe(
              Effect.timeout(`${timeoutMs} millis`),
              Effect.mapError((error) =>
                error instanceof CompactionError
                  ? error
                  : new CompactionError({ message: "Codex compaction timed out" })
              )
            ),
            min: 0,
            max: perAuth,
            timeToLive: workerIdleTimeToLive
          })
      })
      const work = Effect.fn("Compactor.workerLease")(function* (
        home: string,
        request: CompressionRequest,
        emit: (event: Observation) => void
      ) {
        const pool = yield* ScopedCache.get(pools, home)
        for (let retry = 0; retry < maximumWorkerLeaseChecks; retry++) {
          const result = yield* Effect.gen(function* () {
            const worker = yield* Pool.get(pool)
            return yield* Effect.gen(function* () {
              if (!(yield* reusable(worker))) {
                yield* Pool.invalidate(pool, worker)
                return Option.none<string>()
              }
              return yield* useWorker(worker, request, emit).pipe(Effect.map(Option.some))
            }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Pool.invalidate(pool, worker) : Effect.void)))
          }).pipe(Effect.scoped)
          if (Option.isSome(result)) return result.value
        }
        return yield* Effect.fail(
          new CompactionError({ message: "Caller Codex profile changed during worker acquisition" })
        )
      })
      const compress = Effect.fn("Compactor.compress")(function* (
        auth: AuthReference | undefined,
        request: CompressionRequest,
        emit: (event: Observation) => void
      ) {
        if (auth !== undefined && !("codexHome" in auth))
          return yield* Effect.fail(new CompactionError({ message: "Claude profiles cannot use the Codex compactor" }))
        const requestedHome = auth?.codexHome ?? options.fallbackHome
        if (requestedHome === undefined || !isAbsolute(requestedHome))
          return yield* Effect.fail(new CompactionError({ message: "No usable caller Codex profile selected" }))
        const home = yield* Effect.tryPromise({
          try: () => realpath(requestedHome),
          catch: () => new CompactionError({ message: "Caller Codex profile unavailable" })
        })
        return yield* admission.withPermit(
          home,
          work(home, request, emit).pipe(
            Effect.timeout(`${timeoutMs} millis`),
            Effect.mapError((error) =>
              error instanceof CompactionError ? error : new CompactionError({ message: "Codex compaction timed out" })
            )
          )
        )
      })
      return Compactor.of({ compress })
    })
  )
