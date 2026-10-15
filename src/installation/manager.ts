import { verifySnapshot, artifactFiles } from "./artifacts.js"
import { dirname } from "node:path"
import { privateDirectory } from "../local-state/private-directory.js"
import { Effect, Schema } from "effect"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import {
  Delivery,
  type DeliveryIntent,
  InstallationError,
  Operation,
  Ownership,
  type Selection,
  type Snapshot
} from "./contracts.js"
import { installationPaths, launcherContent, makeOwnership, contentDigest } from "./binding.js"
import { capture } from "./snapshot.js"
import { exclusive, readOptional, removeOptional, writeAtomic } from "./files.js"
import { configurationText, parseConfiguration, reconcile } from "./reconciliation.js"
import { sameEntry } from "./mcp-configuration.js"
import { mcpLock, preflightMcp, publishMcp, validateMcpOperation } from "./mcp.js"
import type { InstallationFiles } from "./ports.js"
export type { InstallationFiles } from "./ports.js"

const liveFiles: InstallationFiles = { read: readOptional, write: writeAtomic, remove: removeOptional }
const jsonIndentation = 2
const encode = (value: unknown): string => JSON.stringify(value, null, jsonIndentation) + "\n"
const decodeOptional = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string | undefined
): S["Type"] | undefined =>
  text === undefined ? undefined : Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text)

const validateSelection = (actual: Selection, expected: Selection): void => {
  if (
    actual.mcpConfiguration !== undefined &&
    expected.mcpConfiguration !== undefined &&
    actual.mcpConfiguration !== expected.mcpConfiguration
  )
    throw new InstallationError({
      operation: "ownership",
      message: "MCP configuration scope differs from the owned installation"
    })
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
  validateMcpOperation(operation, files)
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
  publishMcp(operation, files)
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
  activate: (selection: Selection) => Effect.Effect<void, InstallationError> = () => Effect.void,
  delivery?: DeliveryIntent
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const paths = installationPaths(selection)
      yield* Effect.try({
        try: () => privateDirectory(dirname(paths.directory)),
        catch: (cause) => failure("directory", cause)
      })
      yield* exclusive(paths.directory, paths.lock)
      const destination = mcpLock(paths.mcpConfiguration)
      yield* exclusive(destination.directory, destination.path)
      const snapshot = yield* capture(source, dataDirectory)
      yield* Effect.try({
        try: () => {
          const pending = decodeOptional(Delivery, files.read(paths.delivery))
          if (
            pending !== undefined &&
            (delivery === undefined ||
              pending.intent.action !== delivery.action ||
              pending.intent.publicDirectory !== delivery.publicDirectory ||
              !matchesSelection(pending.ownership, selection, snapshot))
          )
            throw new InstallationError({
              operation: "delivery",
              message: "Interrupted delivery must be repaired before choosing another target"
            })
        },
        catch: (cause) => failure("delivery", cause)
      })
      const pending = yield* Effect.try({
        try: () => pendingOperation(selection, files, "Install"),
        catch: (cause) => failure("recover", cause)
      })
      if (pending !== undefined) {
        yield* Effect.try({ try: () => validatePending(pending, files), catch: (cause) => failure("recover", cause) })
        yield* verifySnapshot(pending.ownership.snapshot, artifactFiles)
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
          preflightMcp(ownership, previous, files, previous !== undefined)
          const configText = files.read(paths.configuration)
          const config = configText === undefined ? {} : parseConfiguration(configText)
          reconcile(config, ownership.command, true, previous !== undefined)
          const operation: Operation = {
            _tag: "Install",
            ownership,
            ...(previous === undefined ? {} : { previousOwnership: previous })
          }
          validateLauncher(files.read(paths.launcher), operation)
          if (delivery !== undefined) files.write(paths.delivery, encode({ intent: delivery, ownership }))
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
      const destination = mcpLock(paths.mcpConfiguration)
      yield* exclusive(destination.directory, destination.path)
      return yield* Effect.try({
        try: () => {
          if (files.read(paths.delivery) !== undefined)
            throw new InstallationError({
              operation: "delivery",
              message: "Repair interrupted delivery before uninstalling"
            })
          const pending = pendingOperation(selection, files, "Uninstall")
          if (pending !== undefined) finish(pending, files)
          const ownership = decodeOptional(Ownership, files.read(paths.ownership))
          if (ownership === undefined) return { removed: false }
          validateSelection(ownership.selection, selection)
          validateOwnership(ownership)
          const operation: Operation = { _tag: "Uninstall", ownership }
          validateMcpOperation(operation, files)
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

/** Repair keeps the recorded target; a pending uninstall retains its intent. */
export const repair = Effect.fn("Installation.repair")(function* (
  selection: Selection,
  files: InstallationFiles = liveFiles,
  activate: (selection: Selection) => Effect.Effect<void, InstallationError> = () => Effect.void
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const paths = installationPaths(selection)
      yield* Effect.try({
        try: () => privateDirectory(dirname(paths.directory)),
        catch: (cause) => failure("repair", cause)
      })
      yield* exclusive(paths.directory, paths.lock)
      const destination = mcpLock(paths.mcpConfiguration)
      yield* exclusive(destination.directory, destination.path)
      const operation = yield* Effect.try({
        try: () => prepareRepair(selection, files),
        catch: (cause) => failure("repair", cause)
      })
      if (operation._tag === "Install") yield* verifySnapshot(operation.ownership.snapshot, artifactFiles)
      yield* Effect.try({
        try: () => {
          if (files.read(paths.operation) === undefined) files.write(paths.operation, encode(operation))
        },
        catch: (cause) => failure("repair", cause)
      })
      if (operation._tag === "Install") yield* activate(operation.ownership.selection)
      yield* Effect.try({ try: () => finish(operation, files), catch: (cause) => failure("repair", cause) })
      return { repaired: true, removed: operation._tag === "Uninstall" }
    })
  )
})

const prepareRepair = (selection: Selection, files: InstallationFiles): Operation => {
  const paths = installationPaths(selection)
  const pending = decodeOptional(Operation, files.read(paths.operation))
  const owned = pending?.ownership ?? decodeOptional(Ownership, files.read(paths.ownership))
  if (owned === undefined)
    throw new InstallationError({ operation: "repair", message: "Profile has no owned installation; run install" })
  validateSelection(owned.selection, selection)
  validateOwnership(owned)
  validatePrevious(pending)
  const operation: Operation = pending ?? { _tag: "Install", ownership: owned, previousOwnership: owned }
  validatePending(operation, files)
  return operation
}

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
  validateMcpOwnership(ownership, expected)
}

const validateMcpOwnership = (ownership: Ownership, expected: Ownership): void => {
  if (
    ownership.mcp !== undefined &&
    (expected.mcp === undefined ||
      !sameEntry(
        Schema.decodeUnknownSync(Schema.Json)(ownership.mcp),
        Schema.decodeUnknownSync(Schema.Json)(expected.mcp)
      ))
  )
    throw new InstallationError({ operation: "ownership", message: "MCP ownership does not match its profile binding" })
}

const preserveAuthSelection = (selection: Selection, previous: Ownership | undefined): Selection => {
  return selection.runtime === "claude"
    ? preserveClaudeProfile(selection, previous)
    : preserveCodexProfile(selection, previous)
}

const preserveClaudeProfile = (selection: Selection, previous: Ownership | undefined): Selection => ({
  ...selection,
  runtime: selection.runtime,
  profile: selection.profile,
  claudeHome: selection.claudeHome ?? previous?.selection.claudeHome ?? selection.profile
})

const preserveCodexProfile = (selection: Selection, previous: Ownership | undefined): Selection => {
  const codexHome = selection.codexHome ?? previous?.selection.codexHome ?? selection.profile
  return { ...selection, ...(codexHome === undefined ? {} : { codexHome }) }
}

const validatePending = (operation: Operation, files: InstallationFiles): void => {
  validateMcpOperation(operation, files)
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

const validatePrevious = (pending: Operation | undefined): void => {
  if (pending?._tag === "Install" && pending.previousOwnership !== undefined)
    validateOwnership(pending.previousOwnership)
}
