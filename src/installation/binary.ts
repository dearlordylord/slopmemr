import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import type { Stats } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { contentDigest } from "./binding.js"
import { InstallationError } from "./contracts.js"
import { privateExecutableMode } from "../local-state/contracts.js"

export interface RuntimeFiles {
  readonly existing: (target: string, expected: string) => boolean
  readonly publish: (target: string, bytes: Uint8Array) => void
}
export const copyRuntime = (bytes: Uint8Array, target: string, expected: string, io: RuntimeFiles): void => {
  if (contentDigest(bytes) !== expected)
    throw new InstallationError({ operation: "runtime", message: "Embedded runtime checksum mismatch" })
  if (io.existing(target, expected)) return
  io.publish(target, bytes)
}

const publishRuntime = (target: string, bytes: Uint8Array): void => {
  const temporary = `${target}.${randomUUID()}.tmp`
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    privateExecutableMode
  )
  try {
    try {
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, target)
    const directory = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    removeTemporary(temporary)
  }
}

const removeTemporary = (path: string): void => {
  try {
    unlinkSync(path)
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause
  }
}

const existingRuntime = (target: string, expected: string): boolean => {
  try {
    const stat = lstatSync(target)
    if (!regularRuntime(stat) || contentDigest(readFileSync(target)) !== expected)
      throw new InstallationError({ operation: "runtime", message: "Installed embedded runtime was modified" })
    return true
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false
    throw cause
  }
}
export const runtimeFiles: RuntimeFiles = { existing: existingRuntime, publish: publishRuntime }

const regularRuntime = (stat: Stats): boolean => stat.isFile() && !stat.isSymbolicLink()
