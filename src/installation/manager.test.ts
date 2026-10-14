import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { install, uninstall, type InstallationFiles } from "./manager.js"
import { InstallationError } from "./contracts.js"
import { doctor } from "./doctor.js"
import { installationPaths, makeOwnership, launcherContent } from "./binding.js"
import { readOptional, writeAtomic, removeOptional } from "./files.js"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr install ' "))
  directories.push(directory)
  const profile = join(directory, "profile")
  await mkdir(profile, { mode: 0o700 })
  const selection = { runtime: "codex", profile } satisfies Parameters<typeof install>[0]
  const source = { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") }
  const data = join(directory, "data")
  return { selection, source, data, paths: installationPaths(selection) }
}
const original = {
  unrelated: { private: "preserve me" },
  hooks: {
    Stop: [{ matcher: "other", hooks: [{ type: "command", command: "other-command" }] }],
    Custom: [{ hooks: [{ type: "command", command: "custom" }] }]
  }
}

it.effect("setup/update are idempotent, preserve unrelated settings, and uninstall retains memory", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    yield* Effect.promise(() => writeFile(f.paths.configuration, JSON.stringify(original)))
    const installed = yield* install(f.selection, f.source, f.data, false)
    const text = yield* Effect.promise(() => readFile(f.paths.configuration, "utf8"))
    yield* install(f.selection, f.source, f.data, false)
    yield* install(f.selection, f.source, f.data, true)
    expect(yield* Effect.promise(() => readFile(f.paths.configuration, "utf8"))).toBe(text)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", runtimeAvailable: true })
    expect(yield* uninstall(f.selection)).toEqual({ removed: true })
    expect(JSON.parse(yield* Effect.promise(() => readFile(f.paths.configuration, "utf8")))).toEqual(original)
    expect(readOptional(installed.snapshot.launch.entrypoint)).toContain("SLOPMEMR_STANDALONE_BUILD")
    expect(yield* uninstall(f.selection)).toEqual({ removed: false })
  })
)

const faultAt = (writeIndex: number): InstallationFiles => {
  let count = 0
  return {
    read: readOptional,
    remove: removeOptional,
    write: (path, text) => {
      count += 1
      if (count === writeIndex) throw new Error("Simulated publication failure")
      writeAtomic(path, text)
    }
  }
}
for (const index of [2, 3, 4])
  it.effect(`recovers failed install publication ${index} without losing later unrelated edits`, () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      const failed = yield* install(f.selection, f.source, f.data, false, faultAt(index)).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "recovery-required" })
      const configuration = JSON.parse(readOptional(f.paths.configuration) ?? "{}")
      writeAtomic(f.paths.configuration, JSON.stringify({ ...configuration, laterSetting: "survives" }))
      yield* install(f.selection, f.source, f.data, false)
      expect(readOptional(f.paths.configuration)).toContain("survives")
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready" })
    })
  )

it.effect("preserves modified handlers and launchers and rejects uninstalled update", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    expect((yield* install(f.selection, f.source, f.data, true).pipe(Effect.exit))._tag).toBe("Failure")
    yield* install(f.selection, f.source, f.data, false)
    const before = readOptional(f.paths.configuration) ?? ""
    writeAtomic(f.paths.configuration, before.replace('"timeout": 30', '"timeout": 31'))
    expect((yield* uninstall(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(f.paths.configuration)).toContain('"timeout": 31')
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "conflict" })
    writeAtomic(f.paths.configuration, before)
    writeAtomic(f.paths.launcher, "user modified launcher")
    expect((yield* install(f.selection, f.source, f.data, true).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(f.paths.launcher)).toBe("user modified launcher")
  })
)

it.effect("recovers uninstall after hooks and launcher removal while preserving a later independent hook", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    yield* install(f.selection, f.source, f.data, false)
    let removals = 0
    const files: InstallationFiles = {
      read: readOptional,
      write: writeAtomic,
      remove: (path) => {
        removals += 1
        if (removals === 2) throw new Error("Simulated ownership removal failure")
        removeOptional(path)
      }
    }
    expect((yield* uninstall(f.selection, files).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(f.paths.launcher)).toBeUndefined()
    writeAtomic(f.paths.configuration, JSON.stringify(original))
    yield* uninstall(f.selection)
    expect(JSON.parse(readOptional(f.paths.configuration) ?? "null")).toEqual(original)
    expect(readOptional(f.paths.operation)).toBeUndefined()
  })
)

it.effect("refuses to turn an interrupted install into an uninstall", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    yield* install(f.selection, f.source, f.data, false, faultAt(2)).pipe(Effect.exit)
    expect((yield* uninstall(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(f.paths.operation)).toBeDefined()
    yield* install(f.selection, f.source, f.data, false)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready" })
  })
)

for (const runtime of ["codex", "claude"] as const)
  it.effect(`preserves ${runtime}'s explicitly selected compaction profile when update omits auth`, () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      const selection = { ...f.selection, runtime }
      const auth = (home: string) => (runtime === "codex" ? { codexHome: home } : { claudeHome: home })
      const installed = yield* install({ ...selection, ...auth("/chosen/login") }, f.source, f.data, false)
      const paths = installationPaths(selection)
      const launcher = readOptional(paths.launcher)
      const updated = yield* install(selection, f.source, f.data, true)
      expect(updated.selection).toEqual(installed.selection)
      expect(readOptional(paths.launcher)).toBe(launcher)
      const changed = yield* install({ ...selection, ...auth("/other/login") }, f.source, f.data, true)
      expect(changed.selection).toMatchObject(auth("/other/login"))
    })
  )

it.effect("validates update before native feature activation and journals activation failure", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    let activations = 0
    const activate = () =>
      Effect.sync(() => {
        activations += 1
      })
    expect((yield* install(f.selection, f.source, f.data, true, undefined, activate).pipe(Effect.exit))._tag).toBe(
      "Failure"
    )
    expect(activations).toBe(0)
    yield* install(f.selection, f.source, f.data, false, undefined, () =>
      Effect.fail(new InstallationError({ operation: "native-feature", message: "Simulated feature failure" }))
    ).pipe(Effect.exit)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "recovery-required" })
    expect(readOptional(f.paths.launcher)).toBeUndefined()
    yield* install(f.selection, f.source, f.data, false, undefined, activate)
    expect(activations).toBe(1)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready" })
  })
)

it.effect(
  "retains pending activation across repeated failures and publishes hooks only after activation succeeds",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      const failActivation = () =>
        Effect.fail(new InstallationError({ operation: "native-feature", message: "Not enabled" }))
      yield* install(f.selection, f.source, f.data, false, undefined, failActivation).pipe(Effect.exit)
      yield* install(f.selection, f.source, f.data, false, undefined, failActivation).pipe(Effect.exit)
      expect(readOptional(f.paths.launcher)).toBeUndefined()
      expect(readOptional(f.paths.ownership)).toBeUndefined()
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "recovery-required" })
      let activatedBeforePublication = false
      yield* install(f.selection, f.source, f.data, false, undefined, () =>
        Effect.sync(() => {
          activatedBeforePublication =
            readOptional(f.paths.launcher) === undefined && readOptional(f.paths.operation) !== undefined
        })
      )
      expect(activatedBeforePublication).toBe(true)
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready" })
    })
)

it.effect("rejects conflicting journal ownership and optimistic native-settings races", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    yield* install(f.selection, f.source, f.data, false, faultAt(2)).pipe(Effect.exit)
    const pending = JSON.parse(readOptional(f.paths.operation) ?? "null")
    writeAtomic(
      f.paths.operation,
      JSON.stringify({
        ...pending,
        ownership: { ...pending.ownership, selection: { ...pending.ownership.selection, profile: "/other-profile" } }
      })
    )
    expect((yield* install(f.selection, f.source, f.data, false).pipe(Effect.exit))._tag).toBe("Failure")
    removeOptional(f.paths.operation)
    let reads = 0
    const race: InstallationFiles = {
      write: writeAtomic,
      remove: removeOptional,
      read: (path) => {
        if (path === f.paths.configuration) {
          reads += 1
          if (reads === 3) writeAtomic(path, JSON.stringify({ foreignEdit: true }))
        }
        return readOptional(path)
      }
    }
    expect((yield* install(f.selection, f.source, f.data, false, race).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(f.paths.configuration)).toContain("foreignEdit")
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "recovery-required" })
    yield* install(f.selection, f.source, f.data, false)
    expect(readOptional(f.paths.configuration)).toContain("foreignEdit")
  })
)

it.effect("rebinds recovered installation to the current Node executable even when bundle bytes are identical", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const oldNode = join(f.selection.profile, "old-node")
    yield* Effect.promise(() => writeFile(oldNode, "#!/bin/sh\nexit 1\n", { mode: 0o700 }))
    yield* install(f.selection, { ...f.source, executable: oldNode }, f.data, false, undefined, () =>
      Effect.fail(new InstallationError({ operation: "activate", message: "Interrupted" }))
    ).pipe(Effect.exit)
    yield* Effect.promise(() => rm(oldNode))
    const installed = yield* install(f.selection, f.source, f.data, false)
    expect(installed.snapshot.launch.executable).toBe(process.execPath)
    expect(readOptional(f.paths.launcher)).not.toContain(oldNode)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", runtimeAvailable: true })
  })
)

it.effect("updates a legacy Claude launcher from a foreign Codex binding to its own native profile", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const selection = { runtime: "claude", profile: f.selection.profile } satisfies Parameters<typeof install>[0]
    const installed = yield* install(selection, f.source, f.data, false)
    const legacySelection = { ...selection, codexHome: "/former-codex-profile" }
    const legacy = makeOwnership(legacySelection, installed.snapshot)
    const paths = installationPaths(selection)
    writeAtomic(paths.ownership, JSON.stringify(legacy))
    writeAtomic(paths.launcher, launcherContent(legacySelection, installed.snapshot))
    const updated = yield* install(selection, f.source, f.data, true)
    expect(updated.selection.claudeHome).toBe(selection.profile)
    expect(updated.selection.codexHome).toBeUndefined()
    expect(readOptional(paths.launcher)).toContain("--claude-home")
    expect(readOptional(paths.launcher)).not.toContain("--codex-home")
    expect(yield* doctor(selection)).toMatchObject({ registration: "ready" })
  })
)
