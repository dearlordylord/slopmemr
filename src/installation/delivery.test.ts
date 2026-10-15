import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { doctor } from "./doctor.js"
import { deliver, pendingDelivery } from "./delivery.js"
import { InstallationError, Snapshot } from "./contracts.js"
import { installationPaths } from "./binding.js"
import { readOptional } from "./files.js"
import { repair, uninstall } from "./manager.js"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr-delivery-"))
  directories.push(directory)
  return {
    intent: { action: "Setup", publicDirectory: join(directory, "bin") } as const,
    selection: { runtime: "claude", profile: join(directory, "profile") } as const,
    source: { executable: process.execPath, entrypoint: resolve("dist/bin/slopmemr.mjs") },
    data: join(directory, "data")
  }
}
for (const stage of ["native", "activation"] as const)
  it.effect(`repairable delivery preserves setup intent after ${stage} interruption`, () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      const fail = Effect.fail(new InstallationError({ operation: "test", message: "interrupted" }))
      const interrupted = yield* deliver(
        f.intent,
        f.selection,
        f.source,
        f.data,
        () => (stage === "native" ? fail : Effect.void),
        () => (stage === "activation" ? fail : Effect.void)
      ).pipe(Effect.exit)
      expect(interrupted._tag).toBe("Failure")
      const pending = yield* pendingDelivery(f.selection)
      expect(pending?.intent.action).toBe("Setup")
      expect(yield* doctor(f.selection)).toMatchObject({ registration: "recovery-required" })
      expect((yield* uninstall(f.selection).pipe(Effect.exit))._tag).toBe("Failure")
      if (pending === undefined)
        return yield* Effect.fail(new InstallationError({ operation: "test", message: "Missing delivery journal" }))
      let action: string | undefined
      yield* deliver(
        pending.intent,
        f.selection,
        pending.ownership.snapshot.launch,
        f.data,
        () => Effect.void,
        (intent) =>
          Effect.sync(() => {
            action = intent
          })
      )
      expect(action).toBe("Setup")
      expect(yield* pendingDelivery(f.selection)).toBeUndefined()
      expect(readOptional(installationPaths(f.selection).operation)).toBeUndefined()
      expect(readOptional(join(f.intent.publicDirectory, "slopmemr"))).toContain("SLOPMEMR_BIN_DIR")
      yield* repair(f.selection)
      expect(yield* pendingDelivery(f.selection)).toBeUndefined()
    })
  )

it.effect("snapshot schema accepts only legacy-none or complete modern metadata", () =>
  Effect.gen(function* () {
    const legacy = {
      digest: "a".repeat(64),
      directory: "/snapshot",
      launch: { executable: "/node", entrypoint: "/cli" }
    }
    const fields = {
      hook: { launch: legacy.launch, digest: legacy.digest },
      dataDirectory: "/data",
      runtimeDigest: legacy.digest
    }
    expect((yield* Schema.decodeUnknownEffect(Snapshot)(legacy).pipe(Effect.exit))._tag).toBe("Success")
    expect((yield* Schema.decodeUnknownEffect(Snapshot)({ ...legacy, ...fields }).pipe(Effect.exit))._tag).toBe(
      "Success"
    )
    for (const partial of [
      { hook: fields.hook },
      { dataDirectory: fields.dataDirectory },
      { runtimeDigest: fields.runtimeDigest },
      { hook: fields.hook, dataDirectory: fields.dataDirectory }
    ])
      expect((yield* Schema.decodeUnknownEffect(Snapshot)({ ...legacy, ...partial }).pipe(Effect.exit))._tag).toBe(
        "Failure"
      )
  })
)
