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
    ownership: join(directory, "ownership.json"),
    operation: join(directory, "operation.json"),
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
  return `#!/bin/sh\n# ${ownerMarker}\nexec ${launchCommand(snapshot.launch)} hook --runtime ${selection.runtime}${auth} "$@"\n`
}

export const ownedCommand = (selection: Selection): string =>
  `${shellQuote("/bin/sh")} ${shellQuote(installationPaths(selection).launcher)} --hook-owner ${ownerMarker}`

export const makeOwnership = (selection: Selection, snapshot: Snapshot): Ownership => ({
  version: 1,
  selection,
  snapshot,
  command: ownedCommand(selection),
  launcherDigest: contentDigest(launcherContent(selection, snapshot))
})
