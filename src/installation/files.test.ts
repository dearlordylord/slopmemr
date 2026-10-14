import { mkdtemp, mkdir, rm, chmod, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { exclusive, readOptional, removeOptional } from "./files.js"
import { privateDirectory } from "../local-state/private-directory.js"
import { enableHooks } from "./native-feature.js"

it.live("rejects unsafe filesystem objects and simultaneous SQLite lock owners", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-files-")))
    try {
      const foreign = join(directory, "foreign"),
        link = join(directory, "link")
      yield* Effect.promise(() => mkdir(foreign))
      expect(() => readOptional(foreign)).toThrow()
      expect(() => removeOptional(foreign)).toThrow()
      yield* Effect.promise(() => symlink(foreign, link))
      expect(() => privateDirectory(link)).toThrow()
      expect(() => readOptional(link)).toThrow()
      yield* Effect.promise(() => chmod(foreign, 0o755))
      expect(() => privateDirectory(foreign)).toThrow()
      const state = join(directory, "state"),
        lock = join(state, "owner.sqlite")
      yield* Effect.gen(function* () {
        yield* exclusive(state, lock)
        expect((yield* exclusive(state, lock).pipe(Effect.scoped, Effect.exit))._tag).toBe("Failure")
      }).pipe(Effect.scoped)
      yield* Effect.promise(() => chmod(lock, 0o666))
      expect((yield* exclusive(state, lock).pipe(Effect.scoped, Effect.exit))._tag).toBe("Failure")
    } finally {
      yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
    }
  })
)

it.live("delegates feature activation to the selected native profile and reports activation failure", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-feature-")))
    try {
      yield* enableHooks({ runtime: "claude", profile: directory }, "/does-not-exist")
      expect(
        (yield* enableHooks({ runtime: "codex", profile: directory }, "/does-not-exist").pipe(Effect.exit))._tag
      ).toBe("Failure")
      yield* enableHooks({ runtime: "codex", profile: directory }, "codex")
      expect(readOptional(join(directory, "config.toml"))).toContain("hooks = true")
    } finally {
      yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
    }
  })
)
