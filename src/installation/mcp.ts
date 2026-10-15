import { basename, dirname, join } from "node:path"
import type { Schema } from "effect"
import { InstallationError } from "./contracts.js"
import type { Operation, Ownership } from "./contracts.js"
import { contentDigest, mcpLauncherContent } from "./binding.js"
import { document, replaceEntry, sameEntry, validateEntry } from "./mcp-configuration.js"
import type { InstallationFiles } from "./ports.js"

export const mcpLock = (configuration: string) => {
  const directory = join(dirname(configuration), ".slopmemr", `mcp-${contentDigest(basename(configuration))}`)
  return { directory, path: join(directory, "owner.sqlite") }
}

export const preflightMcp = (
  ownership: Ownership,
  previous: Ownership | undefined,
  files: InstallationFiles,
  recorded: boolean
): void => {
  const binding = ownership.mcp
  if (binding === undefined) return
  const old = previous?.mcp
  validateScope(old, binding.configuration)
  const current = document(ownership.selection.runtime, files.read(binding.configuration)).entry
  validateEntry(current, old === undefined ? [] : [old.entry], old === undefined || !recorded)
  validateMcpLauncher(files.read(binding.launcher), previous === undefined ? [] : [previous])
}

export const validateMcpOperation = (operation: Operation, files: InstallationFiles): void => {
  const ownership = operation.ownership
  const binding = ownership.mcp
  if (binding === undefined) return
  const allowed =
    operation._tag === "Install" && operation.previousOwnership !== undefined
      ? [ownership, operation.previousOwnership]
      : [ownership]
  validateMcpLauncher(files.read(binding.launcher), allowed)
  validateEntry(
    document(ownership.selection.runtime, files.read(binding.configuration)).entry,
    allowed.flatMap((value) => (value.mcp === undefined ? [] : [value.mcp.entry])),
    true
  )
}

export const publishMcp = (operation: Operation, files: InstallationFiles): void => {
  const ownership = operation.ownership
  const binding = ownership.mcp
  if (binding === undefined) return
  validateMcpOperation(operation, files)
  const before = files.read(binding.configuration)
  const parsed = document(ownership.selection.runtime, before)
  const install = operation._tag === "Install"
  if (install) files.write(binding.launcher, mcpLauncherContent(ownership.snapshot))
  const desired = install ? binding.entry : undefined
  const unchanged = equalOptional(parsed.entry, desired)
  if (!unchanged) {
    const next = replaceEntry(parsed, desired)
    if (files.read(binding.configuration) !== before)
      throw new InstallationError({
        operation: "mcp",
        message: "Native MCP settings changed during publication; retry recovery"
      })
    files.write(binding.configuration, next)
  }
  if (!install) files.remove(binding.launcher)
}

const equalOptional = (left: Schema.Json | undefined, right: Schema.Json | undefined): boolean =>
  left === undefined || right === undefined ? left === right : sameEntry(left, right)
const validateMcpLauncher = (text: string | undefined, owners: ReadonlyArray<Ownership>): void => {
  if (text === undefined) return
  const digests = owners.flatMap((owner) => (owner.mcp === undefined ? [] : [owner.mcp.launcherDigest]))
  if (!digests.includes(contentDigest(text)))
    throw new InstallationError({
      operation: "mcp",
      message: "MCP launcher is foreign or modified; refusing to overwrite"
    })
}

export const inspectMcp = (ownership: Ownership, files: InstallationFiles): boolean => {
  const binding = ownership.mcp
  if (binding === undefined) return false
  const current = document(ownership.selection.runtime, files.read(binding.configuration)).entry
  const launcher = files.read(binding.launcher)
  if (current === undefined || launcher === undefined) return false
  validateEntry(current, [binding.entry], false)
  if (contentDigest(launcher) !== binding.launcherDigest)
    throw new InstallationError({ operation: "mcp", message: "MCP launcher is missing or modified" })
  return true
}

const validateScope = (old: Ownership["mcp"], configuration: string): void => {
  if (old !== undefined && old.configuration !== configuration)
    throw new InstallationError({
      operation: "mcp",
      message: "Native MCP configuration scope changed; reconcile the recorded profile first"
    })
}
