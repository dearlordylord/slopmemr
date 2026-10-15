import { chmod, lstat } from "node:fs/promises"
import type { Stats } from "node:fs"
import { tmpdir } from "node:os"
import { join, isAbsolute } from "node:path"
import { Effect, Schema } from "effect"
import { privateDirectory } from "../local-state/private-directory.js"
import { AbsolutePath, otherUserPermissions, privateFileMode } from "../local-state/contracts.js"
import { maximumSocketBytes } from "./limits.js"
import { ReadCode } from "../memory/reading.js"

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String,
  code: Schema.optionalKey(ReadCode),
  retryable: Schema.optionalKey(Schema.Boolean)
}) {}

export const Endpoint = Schema.Struct({ directory: AbsolutePath, socket: AbsolutePath })
export type Endpoint = typeof Endpoint.Type

export const endpoint = (directory = join(tmpdir(), `slopmemr-${process.getuid?.() ?? process.pid}`)): Endpoint => ({
  directory,
  socket: join(directory, "resident.sock")
})

export const prepare = Effect.fn("Resident.prepareEndpoint")(function* (paths: Endpoint) {
  if (
    !isAbsolute(paths.directory) ||
    paths.socket !== join(paths.directory, "resident.sock") ||
    Buffer.byteLength(paths.socket) > maximumSocketBytes
  ) {
    return yield* Effect.fail(new TransportError({ message: "Resident requires a short absolute socket directory" }))
  }
  yield* Effect.try({
    try: () => privateDirectory(paths.directory),
    catch: () => new TransportError({ message: "Resident directory must be private and user owned" })
  })
})

export const verifySocket = Effect.fn("Resident.verifySocket")(function* (paths: Endpoint) {
  yield* prepare(paths)
  yield* verifyExistingSocket(paths)
})

const privateOwned = (stat: Stats): boolean =>
  (stat.mode & otherUserPermissions) === 0 && (process.getuid === undefined || stat.uid === process.getuid())
export const verifyExistingSocket = Effect.fn("Resident.verifyExistingSocket")((paths: Endpoint) =>
  Effect.tryPromise({
    try: async () => {
      const directory = await lstat(paths.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink() || !privateOwned(directory))
        throw new Error("Unsafe socket directory")
      const stat = await lstat(paths.socket)
      if (!stat.isSocket() || stat.isSymbolicLink() || !privateOwned(stat)) throw new Error("Unsafe socket")
    },
    catch: () => new TransportError({ message: "Resident socket unavailable or unsafe" })
  })
)

export const secureSocket = (paths: Endpoint) => chmod(paths.socket, privateFileMode)
