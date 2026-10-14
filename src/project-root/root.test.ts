import { mkdtemp, mkdir, rm, symlink, rename, readFile, writeFile, readdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { resolveRoot } from "./root.js"
import { identityFilename } from "./identity.js"

const run = promisify(execFile)
const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it.effect("shares a real root across descendants, symlinks, and linked worktrees, but isolates clones", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-root-")))
    fixtures.push(directory)
    const root = join(directory, "main")
    const worktree = join(directory, "linked")
    const clone = join(directory, "clone")
    yield* Effect.promise(async () => {
      await run("git", ["init", root])
      await run("git", [
        "-C",
        root,
        "-c",
        "user.email=test@example.test",
        "-c",
        "user.name=Test",
        "commit",
        "--allow-empty",
        "-m",
        "initial"
      ])
      await run("git", ["-C", root, "worktree", "add", "--detach", worktree])
      await run("git", ["clone", root, clone])
      await mkdir(join(worktree, "nested"))
      await symlink(worktree, join(directory, "alias"))
    })
    const main = yield* resolveRoot(root)
    expect(yield* resolveRoot(join(worktree, "nested"))).toEqual(main)
    expect(yield* resolveRoot(join(directory, "alias"))).toEqual(main)
    expect((yield* resolveRoot(clone)).key).not.toBe(main.key)
  })
)

it.effect("uses the explicit root for non-Git projects and rejects relative roots", () =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-nongit-")))
    fixtures.push(path)
    expect((yield* resolveRoot(path)).path).toBe(path)
    const result = yield* resolveRoot(".").pipe(Effect.flip)
    expect(result._tag).toBe("RootError")
  })
)

it.effect("keeps identity through moving a project, git init, and removing Git metadata", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-move-")))
    fixtures.push(directory)
    const root = join(directory, "before")
    const moved = join(directory, "after")
    yield* Effect.promise(() => mkdir(root))
    const original = yield* resolveRoot(root)
    const identity = yield* Effect.promise(() => readFile(join(root, identityFilename), "utf8"))
    yield* Effect.promise(() => rename(root, moved))
    expect(yield* resolveRoot(moved)).toEqual({ path: moved, key: original.key })
    yield* Effect.promise(() => run("git", ["init", moved]))
    expect((yield* resolveRoot(moved)).key).toBe(original.key)
    yield* Effect.promise(() => rm(join(moved, ".git"), { recursive: true }))
    expect((yield* resolveRoot(moved)).key).toBe(original.key)
    expect(yield* Effect.promise(() => readFile(join(moved, identityFilename), "utf8"))).toBe(identity)
  })
)

it.effect("publishes one complete identity for concurrent first callers", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-identity-race-")))
    fixtures.push(root)
    const roots = yield* Effect.all(
      Array.from({ length: 16 }, () => resolveRoot(root)),
      { concurrency: "unbounded" }
    )
    expect(new Set(roots.map((entry) => entry.key)).size).toBe(1)
    expect(yield* Effect.promise(() => readdir(root))).toEqual([identityFilename])
  })
)

it.effect("rejects malformed, oversized and symlink identities without replacing them", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-identity-invalid-")))
    fixtures.push(root)
    const path = join(root, identityFilename)
    for (const text of ["not json", JSON.stringify({ version: 2, key: "a".repeat(64) }), "x".repeat(257)]) {
      yield* Effect.promise(() => writeFile(path, text))
      expect((yield* resolveRoot(root).pipe(Effect.flip))._tag).toBe("RootError")
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(text)
    }
    yield* Effect.promise(async () => {
      await rm(path)
      await symlink(join(root, "missing-target"), path)
    })
    expect((yield* resolveRoot(root).pipe(Effect.flip))._tag).toBe("RootError")
  })
)
