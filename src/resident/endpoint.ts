import { chmod, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, isAbsolute } from "node:path"
import { Effect, Schema } from "effect"
import { privateDirectory } from "../local-state/private-directory.js"
import { AbsolutePath, otherUserPermissions, privateFileMode } from "../local-state/contracts.js"
import { maximumSocketBytes } from "./limits.js"

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String
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
  return yield* Effect.tryPromise({
    try: async () => {
      const stat = await lstat(paths.socket)
      if (
        !stat.isSocket() ||
        stat.isSymbolicLink() ||
        (stat.mode & otherUserPermissions) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        throw new Error("Unsafe socket")
    },
    catch: () => new TransportError({ message: "Resident socket unavailable or unsafe" })
  })
})

export const secureSocket = (paths: Endpoint) => chmod(paths.socket, privateFileMode)
