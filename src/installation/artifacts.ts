import { lstatSync, readFileSync, realpathSync } from "node:fs"
import type { Stats } from "node:fs"
import { join, dirname } from "node:path"
import { Effect, Schema } from "effect"
import { InstallationError, Snapshot } from "./contracts.js"
import { contentDigest } from "./binding.js"

export interface ArtifactFiles {
  readonly stat: (path: string) => Stats
  readonly read: (path: string) => Uint8Array
  readonly canonical: (path: string) => string
}
export const artifactFiles: ArtifactFiles = { stat: lstatSync, read: readFileSync, canonical: realpathSync }

const artifact = (path: string, digest: string, files: ArtifactFiles): void => {
  const stat = files.stat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || contentDigest(files.read(path)) !== digest)
    throw new InstallationError({
      operation: "artifacts",
      message: "Installed artifact is missing or modified; install a verified package"
    })
}

export const verifySnapshot = Effect.fn("Installation.verifySnapshot")(function* (
  snapshot: Snapshot,
  files: ArtifactFiles
) {
  yield* Effect.try({
    try: () => {
      if (snapshot.hook === undefined || snapshot.runtimeDigest === undefined)
        throw new InstallationError({
          operation: "artifacts",
          message: "Legacy installation requires update to a verified package"
        })
      validateLayout(snapshot)
      const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(
        Buffer.from(files.read(join(snapshot.directory, "snapshot.json"))).toString("utf8")
      )
      if (JSON.stringify(manifest) !== JSON.stringify(snapshot))
        throw new InstallationError({
          operation: "artifacts",
          message: "Snapshot manifest differs from installation ownership"
        })
      artifact(snapshot.launch.entrypoint, snapshot.digest, files)
      artifact(snapshot.hook.launch.entrypoint, snapshot.hook.digest, files)
      artifact(snapshot.launch.executable, snapshot.runtimeDigest, files)
      const stat = files.stat(snapshot.launch.executable)
      if ((stat.mode & ownerExecuteMode) === 0)
        throw new InstallationError({ operation: "artifacts", message: "Installed runtime is not executable" })
    },
    catch: (cause) =>
      cause instanceof InstallationError
        ? cause
        : new InstallationError({
            operation: "artifacts",
            message: "Cannot verify installed artifacts; install a verified package"
          })
  })
})

const ownerExecuteMode = 0o100

const validateLayout = (snapshot: Snapshot): void => {
  if (
    snapshot.launch.entrypoint !== join(snapshot.directory, "slopmemr.mjs") ||
    snapshot.launch.executable !== join(snapshot.directory, "node") ||
    snapshot.hook?.launch.entrypoint !== join(snapshot.directory, "slopmemr-hook.mjs") ||
    snapshot.hook.launch.executable !== snapshot.launch.executable
  )
    throw new InstallationError({
      operation: "artifacts",
      message: "Snapshot launch roles differ from its immutable directory"
    })
}
interface ObservedRuntime {
  readonly implementation: string
  readonly entrypoint?: string
  readonly executable?: string
  readonly dataDirectory?: string
}

/** Reconcile only a verified immutable installation belonging to this memory directory.
 * This also recovers activation that served successfully before its final state write failed. */
export const authorizeSnapshot = Effect.fn("Installation.authorizeSnapshot")(function* (
  observed: ObservedRuntime,
  directory: string,
  files: ArtifactFiles
) {
  const canonicalDirectory = yield* Effect.try({
    try: () => files.canonical(directory),
    catch: () => new InstallationError({ operation: "identity", message: "Cannot resolve the installation directory" })
  })
  const snapshot = yield* Effect.try({
    try: () => {
      if (observed.entrypoint === undefined || observed.dataDirectory !== canonicalDirectory)
        throw new InstallationError({ operation: "identity", message: "Endpoint belongs to an unexpected resident" })
      const root = files.canonical(dirname(observed.entrypoint))
      if (dirname(root) !== join(canonicalDirectory, "runtime"))
        throw new InstallationError({ operation: "identity", message: "Resident is outside this installation" })
      return Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(
        Buffer.from(files.read(join(root, "snapshot.json"))).toString("utf8")
      )
    },
    catch: () =>
      new InstallationError({
        operation: "identity",
        message: "Cannot reconcile endpoint with a known installed snapshot"
      })
  })
  yield* verifySnapshot(snapshot, files)
  if (
    snapshot.digest !== observed.implementation ||
    snapshot.dataDirectory !== canonicalDirectory ||
    snapshot.launch.executable !== observed.executable ||
    snapshot.launch.entrypoint !== observed.entrypoint
  )
    return yield* Effect.fail(
      new InstallationError({ operation: "identity", message: "Serving identity differs from its verified snapshot" })
    )
})
