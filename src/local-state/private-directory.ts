import { mkdirSync, lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { otherUserPermissions, privateDirectoryMode } from "./contracts.js"

/** Shared OS-user privacy policy for resident endpoints and durable state. */
export const privateDirectory = (directory: string): void => {
  if (!isAbsolute(directory)) throw new Error("State directory must be absolute")
  mkdirSync(directory, { recursive: true, mode: privateDirectoryMode })
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & otherUserPermissions) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  ) {
    throw new Error("State directory must be private and owned by the current user")
  }
}
