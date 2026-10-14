import { randomUUID } from "node:crypto"
import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  lstatSync,
  readFileSync,
  unlinkSync
} from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { privateDirectory } from "../local-state/private-directory.js"
import { privateFileMode, otherUserPermissions } from "../local-state/contracts.js"
import { InstallationError } from "./contracts.js"

const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

export const readOptional = (path: string): string | undefined => {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new InstallationError({ operation: "read", message: "Installation file must be a regular file" })
    return readFileSync(path, "utf8")
  } catch (cause) {
    if (missing(cause)) return undefined
    throw cause
  }
}

/** Publish one durable file without following a destination or temporary symlink. */
export const writeAtomic = (path: string, content: string, mode = privateFileMode): void => {
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode
  )
  try {
    try {
      writeFileSync(descriptor, content)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    removeOptional(temporary)
  }
}

export const removeOptional = (path: string): void => {
  try {
    unlinkSync(path)
  } catch (cause) {
    if (!missing(cause)) throw cause
  }
}

const acquire = (directory: string, path: string): DatabaseSync => {
  privateDirectory(directory)
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, privateFileMode)
  closeSync(descriptor)
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & otherUserPermissions) !== 0)
    throw new InstallationError({ operation: "lock", message: "Installation lock must be private" })
  const database = new DatabaseSync(path)
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

export const exclusive = (directory: string, path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => acquire(directory, path),
      catch: () =>
        new InstallationError({ operation: "lock", message: "Profile is unsafe or another installer holds its lock" })
    }),
    (database) =>
      Effect.sync(() => {
        database.exec("ROLLBACK")
        database.close()
      })
  )
