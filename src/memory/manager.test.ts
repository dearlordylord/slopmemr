import { mkdtemp, mkdir, rm, rename, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { Compactor } from "../compaction/compactor.js"
import { authHome } from "../compaction/profile.js"
import { Append } from "./contracts.js"
import { layer, MemoryManager } from "./manager.js"
import { SqliteStorage } from "./storage.js"
import { identityFilename } from "../project-root/identity.js"

const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const fixture = () =>
  Effect.promise(async () => {
    const path = await mkdtemp(join(tmpdir(), "slopmemr-memory-"))
    fixtures.push(path)
    const root = join(path, "project")
    await mkdir(root)
    return { root, directory: join(path, "data") }
  })
const input = (root: string, eventId = "e1", text = "keep this fact") =>
  Append.make({ root, eventId, kind: "user", text, agent: { runtime: "codex", sessionId: "session", agentId: "root" } })
const fake = Layer.succeed(
  Compactor,
  Compactor.of({ compress: Effect.fn("Test.compress")(() => Effect.succeed("A preserved fact")) })
)

it.effect("retains records and receipts after relocation during and across resident lifetimes", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const moved = options.root + "-moved"
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      yield* manager.append(input(options.root))
      yield* Effect.promise(() => rename(options.root, moved))
      expect((yield* manager.append(input(moved))).duplicate).toBe(true)
      expect((yield* manager.zoom(moved, 0, 1)).text).toBe("keep this fact")
      expect((yield* manager.roots()).map((root) => root.path)).toEqual([moved])
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      expect((yield* manager.status(moved)).count).toBe(1)
      expect((yield* manager.append(input(moved))).duplicate).toBe(true)
      expect((yield* manager.roots()).map((root) => root.path)).toEqual([moved])
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
  })
)

it.effect("adopts legacy path-keyed memory before moving the project", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const key = createHash("sha256").update(options.root).digest("hex")
    yield* Effect.promise(async () => {
      await mkdir(options.directory, { mode: 0o700 })
      const storage = new SqliteStorage(join(options.directory, key), options.root)
      await storage.open()
      try {
        await storage.appendRecords([{ id: 0, kind: "user", text: "legacy fact", date: "2026-10-14" }])
      } finally {
        await storage.close()
      }
    })
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      expect((yield* manager.zoom(options.root, 0, 1)).text).toBe("legacy fact")
      expect((yield* manager.roots())[0]?.key).toBe(key)
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
    expect(yield* Effect.promise(() => readFile(join(options.root, identityFilename), "utf8"))).toContain(key)
    const moved = options.root + "-moved"
    yield* Effect.promise(() => rename(options.root, moved))
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      expect((yield* manager.zoom(moved, 0, 1)).text).toBe("legacy fact")
      expect(yield* manager.roots()).toEqual([{ path: moved, key }])
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
  })
)

it.effect("deduplicates concurrent intake and persists memory across resident lifetimes", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => manager.append(input(options.root))),
        { concurrency: "unbounded" }
      )
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1)
      expect(results.map((r) => r.receipt.endExclusive)).toEqual(Array(8).fill(1))
      const conflict = yield* manager.append(input(options.root, "e1", "changed content")).pipe(Effect.flip)
      expect(conflict._tag).toBe("MemoryError")
      // Distinct agents and sessions contribute to the same root.
      yield* manager.append({
        ...input(options.root, "e1", "child fact"),
        agent: { runtime: "claude", sessionId: "other", agentId: "child" }
      })
      expect((yield* manager.status(options.root)).count).toBe(2)
      expect((yield* manager.snapshot(options.root)).text).toContain("child fact")
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      expect((yield* manager.roots()).map((root) => root.path)).toEqual([options.root])
      expect((yield* manager.status(options.root)).count).toBe(2)
      expect((yield* manager.append(input(options.root))).duplicate).toBe(true)
      expect((yield* manager.zoom(options.root, 0, 1)).text).toBe("keep this fact")
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
  })
)

it.effect("pins compression auth to source records and supports summary-to-original zoom", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const observed: { home: string | undefined; level: number; index: number }[] = []
    const compactor = Layer.succeed(
      Compactor,
      Compactor.of({
        compress: Effect.fn("Test.profile")(function* (auth, request) {
          yield* Effect.sync(() =>
            observed.push({ home: auth === undefined ? undefined : authHome(auth), ...request.node })
          )
          return "summary " + "s".repeat(30)
        })
      })
    )
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      yield* manager.append({ ...input(options.root, "a", "α".repeat(200)), auth: { codexHome: "/profile-a" } })
      yield* manager.append({ ...input(options.root, "b", "β".repeat(200)), auth: { codexHome: "/profile-b" } })
      const snapshot = yield* manager.settle(options.root)
      expect(snapshot.state).toBe("ready")
      expect(observed).toContainEqual({ home: "/profile-a", level: 0, index: 0 })
      expect(observed).toContainEqual({ home: "/profile-b", level: 0, index: 1 })
      expect(observed).toContainEqual({ home: "/profile-b", level: 1, index: 0 })
      const zoom = yield* manager.zoom(options.root, 0, 1, 0)
      expect(zoom.text).toBe("α".repeat(16))
      expect(zoom.pages).toBe(13)
      expect((yield* manager.zoom(options.root, 0, 2)).text).toContain("0+1|summary")
      expect((yield* manager.zoom(options.root, 1, 2).pipe(Effect.flip))._tag).toBe("MemoryError")
    }).pipe(
      Effect.provide(layer({ ...options, policy: { nodeBytes: 64, pageBytes: 32 } }).pipe(Layer.provide(compactor)))
    )
  })
)

it.effect("retains both runtimes' own profiles across recovery and selects the newest source runtime for parents", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const observed: { runtime: string | undefined; home: string | undefined; level: number; index: number }[] = []
    const compactor = Layer.succeed(
      Compactor,
      Compactor.of({
        compress: Effect.fn("Test.runtimes")((auth, request, _emit, runtime) =>
          Effect.sync(() => {
            observed.push({ runtime, home: auth === undefined ? undefined : authHome(auth), ...request.node })
            return "summary " + "s".repeat(30)
          })
        )
      })
    )
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      yield* manager.append({ ...input(options.root, "codex", "c".repeat(200)), auth: { codexHome: "/codex-profile" } })
      yield* manager.append({
        ...input(options.root, "claude", "h".repeat(200)),
        agent: { runtime: "claude", sessionId: "session", agentId: "root" },
        auth: { claudeHome: "/claude-profile" }
      })
      expect((yield* manager.settle(options.root)).state).toBe("ready")
      expect(observed).toContainEqual({ runtime: "codex", home: "/codex-profile", level: 0, index: 0 })
      expect(observed).toContainEqual({ runtime: "claude", home: "/claude-profile", level: 0, index: 1 })
      expect(observed).toContainEqual({ runtime: "claude", home: "/claude-profile", level: 1, index: 0 })
      expect(
        (yield* manager
          .append({ ...input(options.root, "foreign"), auth: { claudeHome: "/claude-profile" } })
          .pipe(Effect.exit))._tag
      ).toBe("Failure")
    }).pipe(
      Effect.provide(layer({ ...options, policy: { nodeBytes: 64, pageBytes: 32 } }).pipe(Layer.provide(compactor)))
    )
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      expect((yield* manager.status(options.root)).count).toBe(2)
      expect((yield* manager.snapshot(options.root)).state).toBe("ready")
    }).pipe(
      Effect.provide(layer({ ...options, policy: { nodeBytes: 64, pageBytes: 32 } }).pipe(Layer.provide(compactor)))
    )
  })
)

it.effect("cancels background compaction on close without losing original records", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const compactor = Layer.succeed(
      Compactor,
      Compactor.of({
        compress: Effect.fn("Test.blocked")(() =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(cancelled, undefined))
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.scoped)
        )
      })
    )
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      yield* manager.append(input(options.root, "a", "long ".repeat(200)))
      yield* Deferred.await(started)
      expect((yield* manager.snapshot(options.root)).state).toBe("pending")
      expect((yield* manager.settle(options.root, 0)).state).toBe("pending")
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(compactor))))
    yield* Deferred.await(cancelled)
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      expect((yield* manager.zoom(options.root, 0, 1)).text).toBe("long ".repeat(200))
      expect((yield* manager.settle(options.root)).state).toBe("ready")
    }).pipe(Effect.provide(layer(options).pipe(Layer.provide(fake))))
  })
)

it.effect("rejects invalid capacity, unavailable private state and admission beyond the configured root limit", () =>
  Effect.gen(function* () {
    const options = yield* fixture()
    for (const maxRoots of [0, -1, 1.5]) {
      const result = yield* Effect.gen(function* () {
        yield* MemoryManager
      }).pipe(Effect.provide(layer({ ...options, maxRoots }).pipe(Layer.provide(fake))), Effect.exit)
      expect(result._tag).toBe("Failure")
    }
    const bad = yield* Effect.gen(function* () {
      yield* MemoryManager
    }).pipe(Effect.provide(layer({ ...options, directory: "relative" }).pipe(Layer.provide(fake))), Effect.exit)
    expect(bad._tag).toBe("Failure")
    yield* Effect.promise(() => mkdir(options.directory, { recursive: true, mode: 0o700 }))
    const other = join(options.directory, "other-project")
    yield* Effect.promise(() => mkdir(other, { recursive: true }))
    yield* Effect.gen(function* () {
      const manager = yield* MemoryManager
      yield* manager.append(input(options.root))
      expect((yield* manager.snapshot(other).pipe(Effect.exit))._tag).toBe("Failure")
      for (const waitMs of [-1, 20001, 1.5])
        expect((yield* manager.settle(options.root, waitMs).pipe(Effect.exit))._tag).toBe("Failure")
      const existingHome = options.root
      yield* manager.append({ ...input(options.root, "profile-existing"), auth: { codexHome: existingHome } })
      expect(
        (yield* manager
          .append({ ...input(options.root, "profile-relative"), auth: { codexHome: "relative" } })
          .pipe(Effect.exit))._tag
      ).toBe("Failure")
    }).pipe(Effect.provide(layer({ ...options, maxRoots: 1 }).pipe(Layer.provide(fake))))
  })
)
