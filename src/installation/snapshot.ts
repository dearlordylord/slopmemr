import { dirname, join } from "node:path"
import { realpathSync } from "node:fs"
import { Effect, Schema } from "effect"
import { privateDirectory } from "../local-state/private-directory.js"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import { InstallationError, Snapshot } from "./contracts.js"
import { contentDigest } from "./binding.js"
import { readOptional, writeAtomic } from "./files.js"

/** Only the standalone build is installable; its closure contains UNII and Effect. */
export const capture = Effect.fn("Installation.capture")(function* (source: ProcessLaunch, directory: string) {
  return yield* Effect.try({
    try: () => {
      const text = readOptional(source.entrypoint)
      if (text === undefined || !text.includes("SLOPMEMR_STANDALONE_BUILD"))
        throw new InstallationError({ operation: "snapshot", message: "Run the standalone build before setup" })
      const notices = readOptional(join(dirname(source.entrypoint), noticesFilename))
      if (notices === undefined)
        throw new InstallationError({
          operation: "snapshot",
          message: "Standalone artifact is missing dependency notices; rebuild before setup"
        })
      const digest = contentDigest(text)
      const target = join(directory, "runtime", digest, "slopmemr.mjs")
      privateDirectory(directory)
      privateDirectory(join(directory, "runtime"))
      privateDirectory(dirname(target))
      publishImmutable(target, text)
      publishImmutable(join(dirname(target), noticesFilename), notices)
      return Schema.decodeUnknownSync(Snapshot)({
        digest,
        directory: dirname(target),
        launch: { executable: realpathSync(source.executable), entrypoint: target }
      })
    },
    catch: (cause) =>
      cause instanceof InstallationError
        ? cause
        : new InstallationError({ operation: "snapshot", message: "Cannot capture private standalone runtime" })
  })
})

const noticesFilename = "THIRD_PARTY_NOTICES.txt"
const publishImmutable = (path: string, content: string): void => {
  const existing = readOptional(path)
  if (existing !== undefined && existing !== content)
    throw new InstallationError({ operation: "snapshot", message: "Installed immutable runtime was modified" })
  if (existing === undefined) writeAtomic(path, content)
}
