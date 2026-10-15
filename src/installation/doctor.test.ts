import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { install, repair } from "./manager.js"
import { doctor } from "./doctor.js"
import { capture } from "./snapshot.js"
import { installationPaths, launcherContent, mcpLauncherContent, makeOwnership } from "./binding.js"
import { realpathSync } from "node:fs"
import { readOptional, writeAtomic } from "./files.js"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr-doctor-"))
  directories.push(directory)
  return {
    directory,
    selection: { runtime: "claude", profile: join(directory, "profile") } satisfies Parameters<typeof install>[0],
    source: { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") },
    data: join(directory, "data")
  }
}

it.effect("cold doctor creates no state and notices malformed registrations and missing runtime", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const paths = installationPaths(f.selection)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "missing" })
    expect(readOptional(paths.ownership)).toBeUndefined()
    const installed = yield* install(f.selection, f.source, f.data, false)
    yield* Effect.promise(() => rm(installed.snapshot.launch.entrypoint))
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", runtimeAvailable: false })
    writeAtomic(paths.configuration, "malformed")
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "conflict" })
    writeAtomic(paths.configuration, "{}")
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "conflict" })
  })
)

for (const executableCase of ["missing", "not-executable", "old-version", "invalid-version"] as const)
  it.effect(`doctor rejects ${executableCase} Node while retaining readable installed state`, () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      const installed = yield* install(f.selection, f.source, f.data, false)
      const executable = join(f.directory, "node")
      if (executableCase !== "missing") {
        const output =
          executableCase === "old-version" ? "v23.9.0" : executableCase === "invalid-version" ? "invalid" : "v24.1.0"
        yield* Effect.promise(() =>
          writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {
            mode: executableCase === "not-executable" ? 0o600 : 0o700
          })
        )
      }
      const snapshot = { ...installed.snapshot, launch: { ...installed.snapshot.launch, executable } }
      const ownership = makeOwnership(f.selection, snapshot)
      const paths = installationPaths(f.selection)
      writeAtomic(paths.launcher, launcherContent(f.selection, snapshot))
      writeAtomic(paths.mcpLauncher, mcpLauncherContent(snapshot))
      writeAtomic(paths.ownership, JSON.stringify(ownership))
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", runtimeAvailable: false })
    })
  )

it.effect("rejects missing/nonstandalone sources and detects immutable runtime modification", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const fake = join(f.directory, "source.mjs")
    expect((yield* capture({ ...f.source, entrypoint: fake }, f.data).pipe(Effect.exit))._tag).toBe("Failure")
    yield* Effect.promise(() => writeFile(fake, "ordinary module"))
    expect((yield* capture({ ...f.source, entrypoint: fake }, f.data).pipe(Effect.exit))._tag).toBe("Failure")
    const snapshot = yield* capture(f.source, f.data)
    writeAtomic(snapshot.launch.entrypoint, "modified immutable runtime")
    expect((yield* capture(f.source, f.data).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* capture(f.source, "relative").pipe(Effect.exit))._tag).toBe("Failure")
  })
)

it.effect("doctor preserves independent component health", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    yield* install(f.selection, f.source, f.data, false)
    const paths = installationPaths(f.selection)
    writeAtomic(paths.mcpConfiguration, "malformed")
    expect(yield* doctor(f.selection)).toMatchObject({
      registration: "ready",
      hooks: "ready",
      mcp: "conflict",
      runtimeAvailable: true
    })
    writeAtomic(paths.mcpConfiguration, "{}")
    expect(yield* doctor(f.selection)).toMatchObject({ hooks: "ready", mcp: "missing", runtimeAvailable: true })
    yield* install(f.selection, f.source, f.data, false).pipe(Effect.exit)
    // Repair may restore a missing owned registration without borrowing a different target.
    yield* repair(f.selection)
    yield* Effect.promise(() => rm(paths.launcher))
    expect(yield* doctor(f.selection)).toMatchObject({ hooks: "missing", mcp: "ready", runtimeAvailable: true })
  })
)

it.effect("captures physical runtime paths through a symlinked parent directory", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture)
    const physical = join(f.directory, "physical")
    const alias = join(f.directory, "alias")
    yield* Effect.promise(async () => {
      await mkdir(physical)
      await symlink(physical, alias)
    })
    const snapshot = yield* capture(f.source, join(alias, "data"))
    expect(snapshot.dataDirectory).toBe(realpathSync(snapshot.dataDirectory))
    expect(snapshot.launch.entrypoint).toBe(realpathSync(snapshot.launch.entrypoint))
    expect(snapshot.launch.executable).toBe(realpathSync(snapshot.launch.executable))
    expect(snapshot.directory.startsWith(realpathSync(physical))).toBe(true)
  })
)
