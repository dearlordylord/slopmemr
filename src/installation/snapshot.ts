import { dirname, join } from "node:path"
import { realpathSync, readFileSync } from "node:fs"
import { Effect, Schema } from "effect"
import { privateDirectory } from "../local-state/private-directory.js"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import { InstallationError, CurrentSnapshot } from "./contracts.js"
import { contentDigest } from "./binding.js"
import { readOptional, writeAtomic } from "./files.js"
import { copyRuntime, runtimeFiles } from "./binary.js"
import { nodeUsable, runtimeProbe } from "./doctor.js"

/** Only the standalone build is installable; its closure contains UNII and Effect. */
export const capture = Effect.fn("Installation.capture")(function* (source: ProcessLaunch, directory: string) {
  if (!(yield* nodeUsable(source.executable, runtimeProbe)))
    return yield* Effect.fail(
      new InstallationError({ operation: "runtime", message: "Target runtime is not a working Node 24 executable" })
    )
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
      const hook = readOptional(join(dirname(source.entrypoint), "slopmemr-hook.mjs"))
      if (hook === undefined || !hook.includes("SLOPMEMR_HOOK_BUILD"))
        throw new InstallationError({
          operation: "snapshot",
          message: "Dedicated hook artifact is missing; rebuild before setup"
        })
      const hookDigest = contentDigest(hook)
      const executableSource = realpathSync(source.executable)
      const bytes = readFileSync(executableSource)
      const runtimeDigest = contentDigest(bytes)
      const runtimeNotices = nodeNotices(executableSource)
      const build = contentDigest(
        `${digest}:${hookDigest}:${runtimeDigest}:${contentDigest(notices)}:${contentDigest(runtimeNotices)}`
      )
      const target = join(directory, "runtime", build, "slopmemr.mjs")
      privateDirectory(directory)
      privateDirectory(join(directory, "runtime"))
      privateDirectory(dirname(target))
      publishImmutable(target, text)
      publishImmutable(join(dirname(target), "slopmemr-hook.mjs"), hook)
      publishImmutable(join(dirname(target), noticesFilename), notices)
      const executable = join(dirname(target), "node")
      copyRuntime(bytes, executable, runtimeDigest, runtimeFiles)
      publishImmutable(join(dirname(target), "NODE_LICENSE"), runtimeNotices)
      const snapshot = Schema.decodeUnknownSync(CurrentSnapshot)({
        digest,
        directory: dirname(target),
        launch: { executable, entrypoint: target },
        hook: { digest: hookDigest, launch: { executable, entrypoint: join(dirname(target), "slopmemr-hook.mjs") } },
        dataDirectory: realpathSync(directory),
        runtimeDigest
      })
      publishImmutable(join(dirname(target), "snapshot.json"), JSON.stringify(snapshot) + "\n")
      return snapshot
    },
    catch: (cause) =>
      cause instanceof InstallationError
        ? cause
        : new InstallationError({ operation: "snapshot", message: "Cannot capture private standalone runtime" })
  })
})

const noticesFilename = "THIRD_PARTY_NOTICES.txt"
const nodeNotices = (executable: string): string => {
  const candidates = [
    join(dirname(executable), "NODE_LICENSE"),
    join(dirname(dirname(executable)), "NODE_LICENSE"),
    join(dirname(dirname(executable)), "LICENSE")
  ]
  for (const candidate of candidates) {
    const text = readOptional(candidate)
    if (text !== undefined) return text
  }
  throw new InstallationError({
    operation: "snapshot",
    message: "Node runtime license is missing from its distribution"
  })
}
const publishImmutable = (path: string, content: string): void => {
  const existing = readOptional(path)
  if (existing !== undefined && existing !== content)
    throw new InstallationError({ operation: "snapshot", message: "Installed immutable runtime was modified" })
  if (existing === undefined) writeAtomic(path, content)
}
