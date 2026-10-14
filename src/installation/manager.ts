import { dirname } from "node:path"
import { privateDirectory } from "../local-state/private-directory.js"
import { Effect, Schema } from "effect"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import { InstallationError, Operation, Ownership, type Selection, type Snapshot } from "./contracts.js"
import { installationPaths, launcherContent, makeOwnership, contentDigest } from "./binding.js"
import { capture } from "./snapshot.js"
import { exclusive, readOptional, removeOptional, writeAtomic } from "./files.js"
import { configurationText, parseConfiguration, reconcile } from "./reconciliation.js"

export interface InstallationFiles {
  readonly read: typeof readOptional
  readonly write: typeof writeAtomic
  readonly remove: typeof removeOptional
}
const liveFiles: InstallationFiles = { read: readOptional, write: writeAtomic, remove: removeOptional }
const jsonIndentation = 2
const encode = (value: unknown): string => JSON.stringify(value, null, jsonIndentation) + "\n"
const decodeOptional = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string | undefined
): S["Type"] | undefined =>
  text === undefined ? undefined : Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text)

const validateSelection = (actual: Selection, expected: Selection): void => {
  if (actual.runtime !== expected.runtime || actual.profile !== expected.profile)
    throw new InstallationError({ operation: "ownership", message: "Installation belongs to a different profile" })
}

const validateLauncher = (text: string | undefined, operation: Operation): void => {
  if (text === undefined) return
  const allowed = [operation.ownership.launcherDigest]
  if (operation._tag === "Install" && operation.previousOwnership !== undefined)
    allowed.push(operation.previousOwnership.launcherDigest)
  if (!allowed.includes(contentDigest(text)))
    throw new InstallationError({
      operation: "launcher",
      message: "Hook launcher was modified; refusing to overwrite it"
    })
}

/** A pending journal permits missing owned handlers, but never modified ones. */
const finish = (operation: Operation, files: InstallationFiles): void => {
  const ownership = operation.ownership
  const paths = installationPaths(ownership.selection)
  validateLauncher(files.read(paths.launcher), operation)
  const before = files.read(paths.configuration)
  const configuration = before === undefined ? {} : parseConfiguration(before)
  const install = operation._tag === "Install"
  const next = configurationText(reconcile(configuration, ownership.command, install))
  if (install) files.write(paths.launcher, launcherContent(ownership.selection, ownership.snapshot))
  // Recheck immediately before publication. The native host does not share our lock.
  if (files.read(paths.configuration) !== before)
    throw new InstallationError({
      operation: "configuration",
      message: "Native settings changed during installation; retry to reconcile"
    })
  if (before !== next) files.write(paths.configuration, next)
  if (install) files.write(paths.ownership, encode(ownership))
  else {
    files.remove(paths.launcher)
    files.remove(paths.ownership)
  }
  files.remove(paths.operation)
}

const pendingOperation = (
  selection: Selection,
  files: InstallationFiles,
  expected: Operation["_tag"]
): Operation | undefined => {
  const pending = decodeOptional(Operation, files.read(installationPaths(selection).operation))
  if (pending === undefined) return
  if (pending._tag !== expected)
    throw new InstallationError({
      operation: "recovery",
      message: "Repeat the interrupted operation before changing installation state"
    })
  validateSelection(pending.ownership.selection, selection)
  validateOwnership(pending.ownership)
  if (pending._tag === "Install" && pending.previousOwnership !== undefined)
    validateOwnership(pending.previousOwnership)
  return pending
}

export const install = Effect.fn("Installation.install")(function* (
  selection: Selection,
  source: ProcessLaunch,
  dataDirectory: string,
  update: boolean,
  files: InstallationFiles = liveFiles,
  activate: (selection: Selection) => Effect.Effect<void, InstallationError> = () => Effect.void
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const paths = installationPaths(selection)
      yield* Effect.try({
        try: () => privateDirectory(dirname(paths.directory)),
        catch: (cause) => failure("directory", cause)
      })
      yield* exclusive(paths.directory, paths.lock)
      const snapshot = yield* capture(source, dataDirectory)
      const pending = yield* Effect.try({
        try: () => pendingOperation(selection, files, "Install"),
        catch: (cause) => failure("recover", cause)
      })
      if (pending !== undefined) {
        yield* Effect.try({ try: () => validatePending(pending, files), catch: (cause) => failure("recover", cause) })
        yield* activate(pending.ownership.selection)
        yield* Effect.try({ try: () => finish(pending, files), catch: (cause) => failure("recover", cause) })
        if (matchesSelection(pending.ownership, selection, snapshot)) return pending.ownership
      }
      const operation = yield* Effect.try({
        try: () => {
          const previous = decodeOptional(Ownership, files.read(paths.ownership))
          if (previous !== undefined) {
            validateSelection(previous.selection, selection)
            validateOwnership(previous)
          }
          if (update && previous === undefined)
            throw new InstallationError({ operation: "update", message: "Profile is not installed; run setup first" })
          const ownership = makeOwnership(preserveAuthSelection(selection, previous), snapshot)
          const configText = files.read(paths.configuration)
          const config = configText === undefined ? {} : parseConfiguration(configText)
          reconcile(config, ownership.command, true, previous !== undefined)
          const operation: Operation = {
            _tag: "Install",
            ownership,
            ...(previous === undefined ? {} : { previousOwnership: previous })
          }
          validateLauncher(files.read(paths.launcher), operation)
          files.write(paths.operation, encode(operation))
          return operation
        },
        catch: (cause) => failure("install", cause)
      })
      yield* activate(operation.ownership.selection)
      yield* Effect.try({ try: () => finish(operation, files), catch: (cause) => failure("install", cause) })
      return operation.ownership
    })
  )
})

export const uninstall = Effect.fn("Installation.uninstall")(function* (
  selection: Selection,
  files: InstallationFiles = liveFiles
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const paths = installationPaths(selection)
      yield* Effect.try({
        try: () => privateDirectory(dirname(paths.directory)),
        catch: (cause) => failure("directory", cause)
      })
      yield* exclusive(paths.directory, paths.lock)
      return yield* Effect.try({
        try: () => {
          const pending = pendingOperation(selection, files, "Uninstall")
          if (pending !== undefined) finish(pending, files)
          const ownership = decodeOptional(Ownership, files.read(paths.ownership))
          if (ownership === undefined) return { removed: false }
          validateSelection(ownership.selection, selection)
          validateOwnership(ownership)
          const operation: Operation = { _tag: "Uninstall", ownership }
          validateLauncher(files.read(paths.launcher), operation)
          const text = files.read(paths.configuration)
          reconcile(text === undefined ? {} : parseConfiguration(text), ownership.command, false)
          files.write(paths.operation, encode(operation))
          finish(operation, files)
          return { removed: true }
        },
        catch: (cause) => failure("uninstall", cause)
      })
    })
  )
})

const failure = (operation: string, cause: unknown): InstallationError =>
  cause instanceof InstallationError
    ? cause
    : new InstallationError({ operation, message: "Cannot safely read or publish installation files" })

const validateOwnership = (ownership: Ownership): void => {
  const expected = makeOwnership(ownership.selection, ownership.snapshot)
  if (ownership.command !== expected.command || ownership.launcherDigest !== expected.launcherDigest)
    throw new InstallationError({
      operation: "ownership",
      message: "Installation record does not match its profile binding"
    })
}

const preserveAuthSelection = (selection: Selection, previous: Ownership | undefined): Selection => {
  return selection.runtime === "claude"
    ? preserveClaudeProfile(selection, previous)
    : preserveCodexProfile(selection, previous)
}

const preserveClaudeProfile = (selection: Selection, previous: Ownership | undefined): Selection => ({
  runtime: selection.runtime,
  profile: selection.profile,
  claudeHome: selection.claudeHome ?? previous?.selection.claudeHome ?? selection.profile
})

const preserveCodexProfile = (selection: Selection, previous: Ownership | undefined): Selection => {
  const codexHome = selection.codexHome ?? previous?.selection.codexHome ?? selection.profile
  return { ...selection, ...(codexHome === undefined ? {} : { codexHome }) }
}

const validatePending = (operation: Operation, files: InstallationFiles): void => {
  validateLauncher(files.read(installationPaths(operation.ownership.selection).launcher), operation)
  const text = files.read(installationPaths(operation.ownership.selection).configuration)
  reconcile(
    text === undefined ? {} : parseConfiguration(text),
    operation.ownership.command,
    operation._tag === "Install"
  )
}
const matchesSelection = (ownership: Ownership, selection: Selection, snapshot: Snapshot): boolean =>
  ownership.snapshot.digest === snapshot.digest &&
  ownership.snapshot.directory === snapshot.directory &&
  ownership.snapshot.launch.executable === snapshot.launch.executable &&
  ownership.snapshot.launch.entrypoint === snapshot.launch.entrypoint &&
  ownership.selection.codexHome === preserveAuthSelection(selection, ownership).codexHome &&
  ownership.selection.claudeHome === preserveAuthSelection(selection, ownership).claudeHome
