import { mkdtemp, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { capture } from "./snapshot.js"
import { artifactFiles, verifySnapshot, authorizeSnapshot } from "./artifacts.js"
import { readOptional, writeAtomic } from "./files.js"

it.effect("reconciles only verified owned snapshots and rejects corrupt manifests, roles and permissions", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-integrity-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
    )
    const snapshot = yield* capture(
      { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") },
      directory
    )
    const observed = { ...snapshot.launch, implementation: snapshot.digest, dataDirectory: directory }
    yield* authorizeSnapshot(observed, directory, artifactFiles)
    for (const changed of [
      { ...observed, dataDirectory: "/other-memory" },
      { ...observed, entrypoint: "/tmp/unowned/resident.mjs" },
      { ...observed, implementation: "f".repeat(64) }
    ]) {
      expect((yield* authorizeSnapshot(changed, directory, artifactFiles).pipe(Effect.exit))._tag).toBe("Failure")
    }
    expect(
      (yield* verifySnapshot(
        { ...snapshot, launch: { ...snapshot.launch, entrypoint: "/tmp/foreign.mjs" } },
        artifactFiles
      ).pipe(Effect.exit))._tag
    ).toBe("Failure")
    const manifest = join(snapshot.directory, "snapshot.json")
    const text = readOptional(manifest)
    writeAtomic(manifest, JSON.stringify({ ...snapshot, digest: "f".repeat(64) }))
    expect((yield* verifySnapshot(snapshot, artifactFiles).pipe(Effect.exit))._tag).toBe("Failure")
    if (text !== undefined) writeAtomic(manifest, text)
    yield* Effect.promise(() => chmod(snapshot.launch.executable, 0o600))
    expect((yield* verifySnapshot(snapshot, artifactFiles).pipe(Effect.exit))._tag).toBe("Failure")
    yield* Effect.promise(() => chmod(snapshot.launch.executable, 0o700))
    yield* verifySnapshot(snapshot, artifactFiles)
  })
)
