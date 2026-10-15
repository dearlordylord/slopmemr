import { mkdirSync, lstatSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { AbsolutePath, Digest, privateDirectoryMode } from "../local-state/contracts.js"
import { privateDirectory } from "../local-state/private-directory.js"
import { launchCommand, shellQuote } from "../local-state/process-launch.js"
import { InstallationError, Snapshot } from "./contracts.js"
import { contentDigest } from "./binding.js"
import { exclusive, readOptional, removeOptional, writeAtomic } from "./files.js"
import type { InstallationFiles } from "./manager.js"

const PublicRecord = Schema.Struct({
  path: AbsolutePath,
  digest: Digest,
  snapshot: Snapshot,
  binDirectory: Schema.optionalKey(AbsolutePath)
})
type PublicRecord = typeof PublicRecord.Type
const PublicOperation = Schema.Struct({ next: PublicRecord, previous: Schema.optionalKey(PublicRecord) })
const publicExecutableMode = 0o700
const writableByOthers = 0o022
const filesLive: InstallationFiles = { read: readOptional, write: writeAtomic, remove: removeOptional }
const encode = (value: unknown): string => JSON.stringify(value) + "\n"
const content = (snapshot: Snapshot, binDirectory?: string): string =>
  `#!/bin/sh\n# slopmemr-public-launcher-1\n${binDirectory === undefined ? "" : `export SLOPMEMR_BIN_DIR=${shellQuote(binDirectory)}\n`}${snapshot.dataDirectory === undefined ? "" : `export SLOPMEMR_DATA_DIR=${shellQuote(snapshot.dataDirectory)}\n`}exec ${launchCommand(snapshot.launch)} "$@"\n`

const prepareDirectory = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: privateDirectoryMode })
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & writableByOthers) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new InstallationError({
      operation: "public-command",
      message: "Public command directory must be user-owned and protected from other writers"
    })
}
const decodeRecord = (text: string | undefined): PublicRecord | undefined =>
  text === undefined ? undefined : Schema.decodeSync(Schema.fromJsonString(PublicRecord))(text)
const validateRecord = (record: PublicRecord, path: string): void => {
  if (record.path !== path || record.digest !== contentDigest(content(record.snapshot, record.binDirectory)))
    throw new InstallationError({
      operation: "public-command",
      message: "Public command ownership does not match its binding"
    })
}
const validateTarget = (text: string | undefined, previous: PublicRecord | undefined): void => {
  if (previous === undefined ? text !== undefined : text === undefined || contentDigest(text) !== previous.digest)
    throw new InstallationError({
      operation: "public-command",
      message: "An unrelated or modified command occupies the public launcher path"
    })
}

const publish = (
  operation: typeof PublicOperation.Type,
  state: string,
  journal: string,
  files: InstallationFiles
): void => {
  validateRecord(operation.next, operation.next.path)
  if (operation.previous !== undefined) validateRecord(operation.previous, operation.next.path)
  const existing = files.read(operation.next.path)
  const accepted = [operation.next.digest, operation.previous?.digest]
  if (existing !== undefined && !accepted.includes(contentDigest(existing)))
    throw new InstallationError({ operation: "public-command", message: "Public launcher changed during publication" })
  files.write(operation.next.path, content(operation.next.snapshot, operation.next.binDirectory), publicExecutableMode)
  files.write(state, encode(operation.next))
  files.remove(journal)
}

/** Serialize public-command publishers, preflight before profile changes, and recover atomic publication. */
export const withPublicCommand = Effect.fn("Installation.publicCommand")(function* <R, E = never>(
  directory: string,
  dataDirectory: string,
  prepare: Effect.Effect<Snapshot, InstallationError, R>,
  files: InstallationFiles = filesLive,
  after?: (snapshot: Snapshot) => Effect.Effect<void, E, R>
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const administration = join(directory, ".slopmemr")
      yield* Effect.try({
        try: () => {
          privateDirectory(dataDirectory)
          prepareDirectory(directory)
        },
        catch: failure
      })
      yield* exclusive(administration, join(administration, "public-command-owner.sqlite"))
      const path = join(directory, "slopmemr"),
        state = join(administration, "public-command.json"),
        journal = join(administration, "public-command-operation.json")
      const previous = yield* Effect.try({
        try: () => {
          const pending = files.read(journal)
          if (pending !== undefined) {
            const operation = Schema.decodeSync(Schema.fromJsonString(PublicOperation))(pending)
            validateRecord(operation.next, path)
            publish(operation, state, journal, files)
          }
          const record = decodeRecord(files.read(state))
          if (record !== undefined) validateRecord(record, path)
          validateTarget(files.read(path), record)
          return record
        },
        catch: failure
      })
      const snapshot = yield* prepare
      yield* Effect.try({
        try: () => {
          const next: PublicRecord = {
            path,
            digest: contentDigest(content(snapshot, directory)),
            snapshot,
            binDirectory: directory
          }
          const operation = { next, ...(previous === undefined ? {} : { previous }) }
          validateTarget(files.read(path), previous)
          files.write(journal, encode(operation))
          publish(operation, state, journal, files)
        },
        catch: failure
      })
      if (after !== undefined) yield* after(snapshot)
      return { path, snapshotDigest: snapshot.digest, snapshot }
    })
  )
})
const failure = (cause: unknown): InstallationError =>
  cause instanceof InstallationError
    ? cause
    : new InstallationError({
        operation: "public-command",
        message: "Cannot safely inspect or publish the public command"
      })
