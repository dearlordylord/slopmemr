import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { capture } from "./snapshot.js"
import { selectRuntime } from "./runtime-selection.js"
import { readSelection, selectionFiles } from "../local-state/runtime-selection.js"
import { InstallationError } from "./contracts.js"

it.effect("retains the last serving target across multiple failed package activations", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "slopmemr-selection-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
    )
    const original = yield* capture(
      { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") },
      directory
    )
    yield* selectRuntime(original, () => Effect.succeed({ serving: true }))
    const failure = () =>
      Effect.fail(new InstallationError({ operation: "test", message: "Activation failed before shutdown" }))
    yield* selectRuntime({ ...original, digest: "b".repeat(64) }, failure).pipe(Effect.exit)
    yield* selectRuntime({ ...original, digest: "c".repeat(64) }, failure).pipe(Effect.exit)
    expect(readSelection(directory, selectionFiles)).toMatchObject({
      implementation: "c".repeat(64),
      previous: { implementation: original.digest }
    })
    yield* selectRuntime({ ...original, digest: "c".repeat(64) }, () => Effect.succeed({ serving: true }))
    expect(readSelection(directory, selectionFiles)?.previous).toBeUndefined()
  })
)
