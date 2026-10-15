import { createHash } from "node:crypto"
import { join } from "node:path"
import { shellQuote, launchCommand } from "../local-state/process-launch.js"
import { ownerMarker } from "./contracts.js"
import type { Ownership, Selection, Snapshot } from "./contracts.js"

export const installationPaths = (selection: Selection) => {
  const directory = join(selection.profile, ".slopmemr", selection.runtime)
  return {
    directory,
    configuration: join(selection.profile, selection.runtime === "codex" ? "hooks.json" : "settings.json"),
    launcher: join(directory, "hook-launcher.sh"),
    mcpLauncher: join(directory, "mcp-launcher.sh"),
    mcpConfiguration:
      selection.mcpConfiguration ??
      join(selection.profile, selection.runtime === "codex" ? "config.toml" : ".claude.json"),
    ownership: join(directory, "ownership.json"),
    operation: join(directory, "operation.json"),
    delivery: join(directory, "delivery.json"),
    lock: join(directory, "installation-owner.sqlite")
  }
}

export const contentDigest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex")

export const launcherContent = (selection: Selection, snapshot: Snapshot): string => {
  const auth =
    selection.claudeHome === undefined
      ? selection.codexHome === undefined
        ? ""
        : ` --codex-home ${shellQuote(selection.codexHome)}`
      : ` --claude-home ${shellQuote(selection.claudeHome)}`
  const hook = snapshot.hook
  const runtime =
    hook === undefined
      ? `${launchCommand(snapshot.launch)} hook`
      : `${launchCommand(hook.launch)} --resident-bin ${shellQuote(snapshot.launch.executable)} --resident-entry ${shellQuote(snapshot.launch.entrypoint)}`
  const data =
    snapshot.dataDirectory === undefined
      ? ""
      : `SLOPMEMR_DATA_DIR=${shellQuote(snapshot.dataDirectory)}\nexport SLOPMEMR_DATA_DIR\n`
  return `#!/bin/sh\n# ${ownerMarker}\n${data}exec ${runtime} --runtime ${selection.runtime}${auth} "$@"\n`
}

export const ownedCommand = (selection: Selection): string =>
  `${shellQuote("/bin/sh")} ${shellQuote(installationPaths(selection).launcher)} --hook-owner ${ownerMarker}`

export const mcpLauncherContent = (snapshot: Snapshot): string => {
  const data =
    snapshot.dataDirectory === undefined
      ? ""
      : `SLOPMEMR_DATA_DIR=${shellQuote(snapshot.dataDirectory)}\nexport SLOPMEMR_DATA_DIR\n`
  return `#!/bin/sh\n# slopmemr-mcp-owner-1\n${data}exec ${launchCommand(snapshot.launch)} mcp "$@"\n`
}

const mcpBinding = (selection: Selection, snapshot: Snapshot) => {
  const paths = installationPaths(selection)
  const entry =
    selection.runtime === "codex"
      ? { command: "/bin/sh", args: [paths.mcpLauncher] }
      : { type: "stdio", command: "/bin/sh", args: [paths.mcpLauncher], env: {} }
  return {
    configuration: paths.mcpConfiguration,
    launcher: paths.mcpLauncher,
    launcherDigest: contentDigest(mcpLauncherContent(snapshot)),
    entry
  }
}

export const makeOwnership = (selection: Selection, snapshot: Snapshot): Ownership => ({
  version: 1,
  selection,
  snapshot,
  command: ownedCommand(selection),
  launcherDigest: contentDigest(launcherContent(selection, snapshot)),
  ...(snapshot.hook === undefined ? {} : { mcp: mcpBinding(selection, snapshot) })
})
