import { lstatSync, readFileSync } from "node:fs"
import type { Stats } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { AbsolutePath, Digest, otherUserPermissions } from "./contracts.js"
import { ProcessLaunch } from "./process-launch.js"

export const RuntimeTarget = Schema.Struct({
  application: Schema.Literal("slopmemr"),
  version: Schema.Literal(1),
  launch: ProcessLaunch,
  implementation: Digest,
  dataDirectory: AbsolutePath
})
export type RuntimeTarget = typeof RuntimeTarget.Type
export const RuntimeSelection = Schema.Struct({ ...RuntimeTarget.fields, previous: Schema.optionalKey(RuntimeTarget) })
export type RuntimeSelection = typeof RuntimeSelection.Type
export const selectionPath = (directory: string): string => join(directory, "runtime", "selected.json")

/** Passive transport-side lookup: no SQLite, directory creation or provider code. */
export interface SelectionFiles {
  readonly stat: (path: string) => Stats | undefined
  readonly read: (path: string) => string
  readonly owner: () => number | undefined
}

const statOptional = (path: string): Stats | undefined => {
  try {
    return lstatSync(path)
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
    throw cause
  }
}
export const selectionFiles: SelectionFiles = {
  stat: statOptional,
  read: (path) => readFileSync(path, "utf8"),
  owner: () => process.getuid?.()
}
const safeFile = (stat: Stats, owner: number | undefined): boolean =>
  stat.isFile() &&
  !stat.isSymbolicLink() &&
  (stat.mode & otherUserPermissions) === 0 &&
  (owner === undefined || stat.uid === owner)

export const readSelection = (directory: string, files: SelectionFiles): RuntimeSelection | undefined => {
  const path = selectionPath(directory)
  const stat = files.stat(path)
  if (stat === undefined) return undefined
  if (!safeFile(stat, files.owner())) throw new Error("Unsafe resident selection")
  const selected = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeSelection), { onExcessProperty: "error" })(
    files.read(path)
  )
  if (selected.dataDirectory !== directory) throw new Error("Resident selection belongs to another data directory")
  return selected
}
