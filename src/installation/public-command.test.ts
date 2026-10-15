import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { withPublicCommand } from "./public-command.js"
import { capture } from "./snapshot.js"
import { readOptional, writeAtomic, removeOptional } from "./files.js"
import type { InstallationFiles } from "./manager.js"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr-public ' "))
  directories.push(directory)
  const bin = join(directory, "bin"),
    data = join(directory, "data")
  await mkdir(bin, { mode: 0o700 })
  return {
    directory,
    bin,
    data,
    path: join(bin, "slopmemr"),
    prepare: capture({ executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") }, data)
  }
}

it.effect("publishes an executable immutable-runtime launcher and refuses subsequent modifications", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    yield* withPublicCommand(f.bin, f.data, f.prepare)
    const content = readOptional(f.path)
    expect(content).toContain("runtime/")
    expect(content).not.toContain("/workspace/")
    yield* withPublicCommand(f.bin, f.data, f.prepare)
    expect(readOptional(f.path)).toBe(content)
    writeAtomic(f.path, "modified")
    expect((yield* withPublicCommand(f.bin, f.data, f.prepare).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(f.path)).toBe("modified")
  })
)

it.effect("rejects dangling symlinks before running profile setup and never creates their target", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const target = join(f.directory, "foreign-target")
    yield* Effect.promise(() => symlink(target, f.path))
    let prepared = false
    const prepare = f.prepare.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          prepared = true
        })
      )
    )
    expect((yield* withPublicCommand(f.bin, f.data, prepare).pipe(Effect.exit))._tag).toBe("Failure")
    expect(prepared).toBe(false)
    expect(readOptional(target)).toBeUndefined()
  })
)

for (const index of [2, 3])
  it.effect(`recovers interrupted public publication ${index}`, () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      let writes = 0
      const files: InstallationFiles = {
        read: readOptional,
        remove: removeOptional,
        write: (path, text, mode) => {
          writes += 1
          if (writes === index) throw new Error("Publication interrupted")
          writeAtomic(path, text, mode)
        }
      }
      expect((yield* withPublicCommand(f.bin, f.data, f.prepare, files).pipe(Effect.exit))._tag).toBe("Failure")
      yield* withPublicCommand(f.bin, f.data, f.prepare)
      expect(readOptional(f.path)).toContain("slopmemr-public-launcher-1")
      expect(readOptional(join(f.bin, ".slopmemr", "public-command-operation.json"))).toBeUndefined()
    })
  )

it.live("shares one public destination lock across different memory directories", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const started = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    const after = Effect.void.pipe(
      Effect.tap(() => Deferred.succeed(started, undefined)),
      Effect.tap(() => Deferred.await(release))
    )
    const first = yield* withPublicCommand(f.bin, f.data, f.prepare, undefined, () => after).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    let secondPrepared = false
    const second = f.prepare.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          secondPrepared = true
        })
      )
    )
    expect((yield* withPublicCommand(f.bin, join(f.directory, "other-data"), second).pipe(Effect.exit))._tag).toBe(
      "Failure"
    )
    expect(secondPrepared).toBe(false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
  })
)
