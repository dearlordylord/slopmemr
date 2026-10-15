import type { readOptional, writeAtomic, removeOptional } from "./files.js"

export interface InstallationFiles {
  readonly read: typeof readOptional
  readonly write: typeof writeAtomic
  readonly remove: typeof removeOptional
}
