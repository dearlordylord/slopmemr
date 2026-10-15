import { failureToken, SummaryBackendFailure } from "./failures.js"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Result, Semaphore } from "effect"
import { Memory } from "@firfi/unii"
import type { Policy, Receipt, Snapshot } from "@firfi/unii"
import { Compactor } from "../compaction/compactor.js"
import { authHome, authRuntime, withAuthHome } from "../compaction/profile.js"
import { resolveRoot } from "../project-root/root.js"
import type { ProjectRoot, RootError } from "../project-root/root.js"
import { defaultMaximumRoots, maximumSettleWaitMs, binaryTreeBranchCount } from "./limits.js"
import { memoryError } from "./contracts.js"
import type { Append, MemoryError } from "./contracts.js"
import { SqliteStorage, storedRoots, legacyPoolKey } from "./storage.js"
import { privateDirectory } from "../local-state/private-directory.js"
import { MemoryReadError, parseBoundary, parseZoom, zoomFailure } from "./reading.js"
import type { AvailableSnapshot, AvailableZoom, ReadStatus } from "./reading.js"
import { availableSnapshot, availableZoom, readingStatus } from "./available.js"

export interface Options {
  readonly directory: string
  readonly maxRoots?: number
  readonly policy?: Partial<Policy>
}

type Failure = MemoryError | RootError | MemoryReadError
type Status = ReturnType<Memory["status"]> & { readonly usage: ReturnType<Memory["usage"]> }
type Zoom = ReturnType<Memory["zoom"]>
export interface Interface {
  readonly append: (input: Append) => Effect.Effect<{ root: string; receipt: Receipt; duplicate: boolean }, Failure>
  readonly snapshot: (
    root: string,
    options?: { before?: number; view?: "main" | "compaction" }
  ) => Effect.Effect<Snapshot, Failure>
  readonly zoom: (root: string, first: number, count: number, page?: number) => Effect.Effect<Zoom, Failure>
  readonly status: (root: string) => Effect.Effect<Status, Failure>
  readonly settle: (root: string, waitMs?: number) => Effect.Effect<Snapshot, Failure>
  readonly roots: () => Effect.Effect<ReadonlyArray<ProjectRoot>, MemoryError | MemoryReadError>
  readonly readSnapshot: (
    root: string,
    options?: { before?: number; view?: "main" | "compaction" }
  ) => Effect.Effect<AvailableSnapshot, Failure>
  readonly readZoom: (
    root: string,
    first: number,
    count: number,
    page?: number
  ) => Effect.Effect<AvailableZoom, Failure>
  readonly readStatus: (root: string) => Effect.Effect<ReadStatus, Failure>
}

export class MemoryManager extends Context.Service<MemoryManager, Interface>()("slopmemr/MemoryManager") {}

interface Pool {
  readonly root: ProjectRoot
  readonly storage: SqliteStorage
  readonly memory: Memory
  readonly appendGate: Semaphore.Semaphore
}

export const layer = (options: Options) =>
  Layer.effect(
    MemoryManager,
    Effect.gen(function* () {
      const compactor = yield* Compactor
      const pools = new Map<string, Pool>()
      const admission = yield* Semaphore.make(1)
      const maxRoots = options.maxRoots ?? defaultMaximumRoots
      if (!Number.isSafeInteger(maxRoots) || maxRoots <= 0) {
        return yield* Effect.fail(memoryError("configure", "maxRoots must be a positive integer"))
      }
      yield* Effect.try({
        try: () => privateDirectory(options.directory),
        catch: () => memoryError("configure", "Memory directory must be private")
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...pools.values()].map((pool) => pool.memory.close()))
          pools.clear()
        })
      )

      const get = Effect.fn("MemoryManager.pool")(function* (requested: string) {
        const root = yield* resolveRoot(requested, (path) => legacyPoolKey(options.directory, path))
        return yield* admission
          .withPermit(
            Effect.gen(function* () {
              const existing = pools.get(root.key)
              if (existing !== undefined) {
                yield* Effect.try({
                  try: () => existing.storage.relocate(root.path),
                  catch: () => memoryError("relocate", "Cannot update the project's current location")
                })
                const relocated = { ...existing, root }
                pools.set(root.key, relocated)
                return relocated
              }
              if (pools.size >= maxRoots)
                return yield* Effect.fail(memoryError("open", "Resident root capacity reached"))
              const storage = new SqliteStorage(join(options.directory, root.key), root.path, root.key)
              // Auth references are attached to records by the storage adapter, not read
              // from the resident's startup environment. A parent uses its newest source
              // record's profile; that choice is deterministic across recovery.
              const memory = yield* Effect.tryPromise({
                try: () =>
                  Memory.open({
                    storage,
                    ...(options.policy === undefined ? {} : { policy: options.policy }),
                    backend: (request, signal, emit) => {
                      const last = (request.node.index + 1) * binaryTreeBranchCount ** request.node.level - 1
                      const auth = storage.authForRecord(last)
                      return Effect.runPromise(
                        compactor
                          .compress(auth, request, emit, storage.runtimeForRecord(last))
                          .pipe(
                            Effect.mapError(
                              (error) => new SummaryBackendFailure({ message: failureToken(error.message) })
                            )
                          ),
                        { signal }
                      )
                    }
                  }),
                catch: () => memoryError("open", "Memory storage is unavailable, already owned, or corrupt")
              })
              const appendGate = yield* Semaphore.make(1)
              const pool = { root, storage, memory, appendGate }
              pools.set(root.key, pool)
              // Recovered pending jobs resume under their persisted profile references.
              yield* Effect.sync(() => memory.step())
              return pool
            })
          )
          .pipe(Effect.uninterruptible)
      })

      const read = <A>(operation: string, action: () => A) =>
        Effect.try({
          try: action,
          catch: (cause) =>
            cause instanceof MemoryReadError
              ? cause
              : memoryError(operation, "Invalid memory request or unavailable memory state")
        })
      const append = Effect.fn("MemoryManager.append")(function* (input: Append) {
        const pool = yield* get(input.root)
        const eventKey = JSON.stringify([
          input.agent.runtime,
          input.agent.sessionId,
          input.agent.agentId,
          input.eventId
        ])
        const digest = createHash("sha256")
          .update(JSON.stringify([input.kind, input.text]))
          .digest("hex")
        return yield* pool.appendGate
          .withPermit(
            Effect.gen(function* () {
              const old = yield* read("deduplicate", () => pool.storage.findEvent(eventKey, digest))
              if (old !== undefined) return { root: pool.root.path, receipt: old, duplicate: true }
              const selectedAuth = input.auth
              if (selectedAuth !== undefined && input.agent.runtime !== authRuntime(selectedAuth))
                return yield* Effect.fail(
                  memoryError("authReference", "Login profile must match the calling agent runtime")
                )
              const auth =
                selectedAuth === undefined
                  ? undefined
                  : yield* Effect.tryPromise({
                      try: async () => {
                        const requestedHome = authHome(selectedAuth)
                        if (!isAbsolute(requestedHome)) throw new Error("Relative auth profile")
                        const home = await realpath(requestedHome).catch((cause: unknown) => {
                          if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
                            return requestedHome
                          throw cause
                        })
                        return withAuthHome(selectedAuth, home)
                      },
                      catch: () => memoryError("authReference", "Caller login profile must be an absolute path")
                    })
              const receipt = yield* Effect.tryPromise({
                try: () =>
                  pool.storage.withEvent(eventKey, digest, auth, () =>
                    pool.memory.append({ kind: JSON.stringify({ ...input.agent, kind: input.kind }), text: input.text })
                  ),
                catch: () => memoryError("append", "Memory append failed; retry the same event ID after recovery")
              })
              yield* read("step", () => pool.memory.step())
              return { root: pool.root.path, receipt, duplicate: false }
            })
          )
          .pipe(Effect.uninterruptible)
      })
      const snapshot = Effect.fn("MemoryManager.snapshot")(function* (
        root: string,
        options: { before?: number; view?: "main" | "compaction" } = {}
      ) {
        const pool = yield* get(root)
        return yield* read("snapshot", () => {
          return Result.map(parseBoundary(options.before, pool.memory.status().count), ({ before }) =>
            pool.memory.snapshot({ ...options, before })
          )
        }).pipe(Effect.flatMap(Effect.fromResult))
      })
      const zoom = Effect.fn("MemoryManager.zoom")(function* (root: string, first: number, count: number, page = 0) {
        const pool = yield* get(root)
        const range = yield* Effect.fromResult(parseZoom(first, count, page, pool.memory.status().count))
        return yield* Effect.try({
          try: () => pool.memory.zoom(range.first, range.count, { page: range.page }),
          catch: zoomFailure
        })
      })
      const status = Effect.fn("MemoryManager.status")(function* (root: string) {
        const pool = yield* get(root)
        return yield* read("status", () => ({ ...pool.memory.status(), usage: pool.memory.usage() }))
      })
      const settle = Effect.fn("MemoryManager.settle")(function* (root: string, waitMs = maximumSettleWaitMs) {
        const pool = yield* get(root)
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > maximumSettleWaitMs) {
          return yield* Effect.fail(memoryError("settle", "Wait must be between 0 and 20000 milliseconds"))
        }
        const waiting = Effect.callback<Snapshot, MemoryError>((resume) => {
          let scheduled: NodeJS.Immediate | undefined
          let done = false
          const check = () => {
            scheduled = undefined
            if (done) return
            try {
              if (pool.memory.status().active === 0) {
                done = true
                resume(Effect.succeed(pool.memory.snapshot()))
              }
            } catch {
              done = true
              resume(Effect.fail(memoryError("settle", "Memory settling failed")))
            }
          }
          const changed = () => {
            // UNII emits before the job's finally removes it. Check once after that
            // event-loop turn, rather than adding a second polling scheduler.
            if (!done && scheduled === undefined) scheduled = setImmediate(check)
          }
          const unsubscribe = pool.memory.subscribe(changed)
          pool.memory.step()
          changed()
          return Effect.sync(() => {
            done = true
            unsubscribe()
            if (scheduled !== undefined) clearImmediate(scheduled)
          })
        })
        return yield* waiting.pipe(
          Effect.timeoutOrElse({
            duration: `${waitMs} millis`,
            orElse: () => read("settle", () => pool.memory.snapshot())
          })
        )
      })
      return MemoryManager.of({
        append,
        snapshot,
        zoom,
        status,
        settle,
        roots: Effect.fn("MemoryManager.roots")(() => read("roots", () => storedRoots(options.directory))),
        readSnapshot: Effect.fn("MemoryManager.readSnapshot")(function* (root, input) {
          const pool = yield* get(root)
          return yield* read("readSnapshot", () => availableSnapshot(pool.memory, input)).pipe(
            Effect.flatMap(Effect.fromResult)
          )
        }),
        readZoom: Effect.fn("MemoryManager.readZoom")(function* (root, first, count, page) {
          const pool = yield* get(root)
          return yield* Effect.try({
            try: () => availableZoom(pool.memory, first, count, page),
            catch: zoomFailure
          }).pipe(Effect.flatMap(Effect.fromResult))
        }),
        readStatus: Effect.fn("MemoryManager.readStatus")(function* (root) {
          const pool = yield* get(root)
          return yield* read("readStatus", () => readingStatus(pool.memory))
        })
      })
    })
  )
