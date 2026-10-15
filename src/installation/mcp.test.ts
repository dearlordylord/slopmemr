import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { Runtime } from "../intake/events.js"
import { install, uninstall, repair } from "./manager.js"
import { doctor } from "./doctor.js"
import { installationPaths, makeOwnership } from "./binding.js"
import { readOptional, writeAtomic, removeOptional } from "./files.js"
import { document, replaceEntry } from "./mcp-configuration.js"
import { capture } from "./snapshot.js"
import type { InstallationFiles } from "./ports.js"

interface Fixture {
  readonly directory: string
  readonly selection: { readonly runtime: Runtime; readonly profile: string }
  readonly source: { readonly executable: string; readonly entrypoint: string }
  readonly data: string
}
const fixture = (runtime: Runtime): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "slopmemr-mcp-"))
      return {
        directory,
        selection: { runtime, profile: join(directory, "profile") },
        source: { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") },
        data: join(directory, "data")
      }
    }),
    (value) => Effect.promise(() => rm(value.directory, { recursive: true, force: true }))
  )
const files: InstallationFiles = { read: readOptional, write: writeAtomic, remove: removeOptional }

for (const runtime of ["codex", "claude"] as const)
  it.effect(`registers and removes ${runtime} MCP without losing native settings`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(runtime)
      const first = yield* install(f.selection, f.source, f.data, false)
      const paths = installationPaths(f.selection)
      const before = readOptional(paths.mcpConfiguration)
      expect(document(runtime, before).entry).toEqual(first.mcp?.entry)
      const unrelated = runtime === "codex" ? '\n[other]\ncreated = 1979-05-27T07:32:00Z\nvalue = "keep"\n' : undefined
      if (unrelated !== undefined) writeAtomic(paths.mcpConfiguration, (before ?? "") + unrelated)
      else {
        const object = Schema.Record(Schema.String, Schema.Json)
        const original = Schema.decodeUnknownSync(Schema.fromJsonString(object))(before ?? "{}")
        const servers = Schema.decodeUnknownSync(object)(original.mcpServers)
        writeAtomic(
          paths.mcpConfiguration,
          JSON.stringify({
            ...original,
            other: { value: "keep" },
            mcpServers: { ...servers, foreign: { type: "stdio", command: "/bin/true", args: ["kept"] } }
          })
        )
      }
      yield* install(f.selection, f.source, f.data, true)
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", mcp: "ready" })
      yield* uninstall(f.selection)
      expect(document(runtime, readOptional(paths.mcpConfiguration)).entry).toBeUndefined()
      const retained = readOptional(paths.mcpConfiguration)
      expect(retained).toContain("keep")
      if (runtime === "codex") expect(retained).toContain("1979-05-27")
      else expect(retained).toContain("foreign")
    })
  )

it.effect("rejects an identical same-name foreign MCP entry before registering hooks", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude")
    const snapshot = yield* capture(f.source, f.data)
    const owner = makeOwnership(f.selection, snapshot)
    const paths = installationPaths(f.selection)
    yield* Effect.promise(() => mkdir(f.selection.profile, { mode: 0o700 }))
    writeAtomic(paths.mcpConfiguration, replaceEntry(document("claude", undefined), owner.mcp?.entry))
    expect((yield* install(f.selection, f.source, f.data, false).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(paths.configuration)).toBeUndefined()
    expect(readOptional(paths.ownership)).toBeUndefined()
    expect(readOptional(paths.mcpLauncher)).toBeUndefined()
  })
)

it.effect("preserves externally changed owned MCP entries during update and uninstall", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude")
    const owner = yield* install(f.selection, f.source, f.data, false)
    const paths = installationPaths(f.selection)
    const changed = { ...owner.mcp?.entry, userAdded: "preserve me" }
    writeAtomic(paths.mcpConfiguration, replaceEntry(document("claude", readOptional(paths.mcpConfiguration)), changed))
    expect((yield* install(f.selection, f.source, f.data, true).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* uninstall(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(paths.mcpConfiguration)).toContain("preserve me")
    expect(yield* doctor(f.selection)).toMatchObject({
      registration: "ready",
      hooks: "ready",
      mcp: "conflict",
      runtimeAvailable: true
    })
  })
)

it.effect("recovers a partial hook/MCP install without replacing later unrelated native edits", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude")
    const paths = installationPaths(f.selection)
    const interrupted: InstallationFiles = {
      ...files,
      write: (path, text, mode) => {
        if (path === paths.mcpConfiguration) throw new Error("Controlled MCP interruption")
        writeAtomic(path, text, mode)
      }
    }
    expect((yield* install(f.selection, f.source, f.data, false, interrupted).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(paths.configuration)).toContain("hook-launcher")
    writeAtomic(paths.mcpConfiguration, JSON.stringify({ userAddedAfterCrash: "keep" }))
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "recovery-required" })
    yield* install(f.selection, f.source, f.data, false)
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", mcp: "ready" })
    expect(readOptional(paths.mcpConfiguration)).toContain("userAddedAfterCrash")
  })
)

it.effect("repair restores missing exact-owned bindings and refuses modified ones", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude")
    const owner = yield* install(f.selection, f.source, f.data, false)
    const paths = installationPaths(f.selection)
    removeOptional(paths.launcher)
    removeOptional(paths.mcpLauncher)
    writeAtomic(paths.configuration, "{}")
    writeAtomic(paths.mcpConfiguration, "{}")
    expect((yield* install(f.selection, f.source, f.data, true).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* repair(f.selection)).toEqual({ repaired: true, removed: false })
    expect(yield* doctor(f.selection)).toMatchObject({ registration: "ready", mcp: "ready" })
    const edited = { ...owner.mcp?.entry, args: ["changed"] }
    writeAtomic(paths.mcpConfiguration, replaceEntry(document("claude", readOptional(paths.mcpConfiguration)), edited))
    expect((yield* repair(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
    expect(document("claude", readOptional(paths.mcpConfiguration)).entry).toEqual(edited)
  })
)

it.effect("rejects repair and diagnoses a changed native MCP scope", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude")
    const selection = { ...f.selection, mcpConfiguration: join(f.directory, "native.json") }
    yield* install(selection, f.source, f.data, false)
    const other = { ...selection, mcpConfiguration: join(f.directory, "other.json") }
    expect((yield* repair(other).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* doctor(other)).toMatchObject({ registration: "conflict", mcp: "conflict" })
    expect(yield* doctor(selection)).toMatchObject({ registration: "ready", mcp: "ready" })
  })
)

it.effect("repair refuses missing or modified hook artifacts before restoring registration", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude")
    const owned = yield* install(f.selection, f.source, f.data, false)
    const paths = installationPaths(f.selection)
    const hook = owned.snapshot.hook
    expect(hook).toBeDefined()
    if (hook === undefined) return
    const original = readOptional(hook.launch.entrypoint)
    removeOptional(paths.launcher)
    writeAtomic(hook.launch.entrypoint, "modified hook")
    expect((yield* repair(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(paths.launcher)).toBeUndefined()
    expect(readOptional(paths.operation)).toBeUndefined()
    removeOptional(hook.launch.entrypoint)
    expect((yield* repair(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
    expect(readOptional(paths.launcher)).toBeUndefined()
    expect(readOptional(paths.operation)).toBeUndefined()
    if (original !== undefined) writeAtomic(hook.launch.entrypoint, original)
    expect(yield* repair(f.selection)).toMatchObject({ repaired: true })
  })
)
