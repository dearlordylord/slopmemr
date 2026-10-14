import { randomBytes, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, open, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { Digest, privateFileMode } from "../local-state/contracts.js"

export const identityFilename = ".slopmemr-id"
const Identity = Schema.Struct({ version: Schema.Literal(1), key: Digest })
const maximumIdentityBytes = 256
const identityEntropyBytes = 32

const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code

const readIdentity = async (path: string): Promise<string | undefined> => {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined
    throw cause
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximumIdentityBytes) throw new Error("Unsafe project identity file")
    const bytes = Buffer.alloc(maximumIdentityBytes + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > maximumIdentityBytes) throw new Error("Oversized project identity file")
    return Schema.decodeUnknownSync(Identity)(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))).key
  } finally {
    await file.close()
  }
}

const publishIdentity = async (path: string, key: string): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", privateFileMode)
  try {
    await file.writeFile(JSON.stringify(Identity.make({ version: 1, key })) + "\n")
    await file.sync()
    await file.close()
    try {
      // Publish complete bytes exclusively: racing callers all read the winner.
      await link(temporary, path)
    } catch (cause) {
      if (!hasCode(cause, "EEXIST")) throw cause
    }
  } finally {
    await file.close()
    await unlink(temporary)
  }
}

export const projectIdentity = async (
  root: string,
  legacyIdentity?: (path: string) => Promise<string | undefined>
): Promise<string> => {
  const path = join(root, identityFilename)
  const existing = await readIdentity(path)
  if (existing !== undefined) return existing
  const key = (await legacyIdentity?.(root)) ?? randomBytes(identityEntropyBytes).toString("hex")
  await publishIdentity(path, key)
  const directory = await open(root, constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  const published = await readIdentity(path)
  if (published === undefined) throw new Error("Project identity disappeared")
  return published
}
