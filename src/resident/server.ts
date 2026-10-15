import { readSelection, selectionFiles } from "../local-state/runtime-selection.js"
import { createHash } from "node:crypto"
import { createServer, createConnection } from "node:net"
import type { Server, Socket } from "node:net"
import { DatabaseSync } from "node:sqlite"
import { lstat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema, Semaphore } from "effect"
import { otherUserPermissions } from "../local-state/contracts.js"
import { endpointProbeMs, defaultConnectionLimit, frameDeadlineMs } from "./limits.js"
import { MemoryError } from "../memory/contracts.js"
import { RootError } from "../project-root/root.js"
import { MemoryReadError } from "../memory/reading.js"
import { MemoryManager } from "../memory/manager.js"
import { maxFrameBytes, Request, Response, ResponsePayload } from "./protocol.js"
import { prepare, secureSocket, TransportError } from "./endpoint.js"
import { applicationName, applicationVersion } from "./identity.js"
import type { Identity, ServingIdentity } from "./identity.js"
import type { Endpoint } from "./endpoint.js"

const dispatch = Effect.fn("Resident.dispatch")(function* (
  request: Request,
  identity: Identity,
  runtime: Options["runtime"]
) {
  const memory = yield* MemoryManager
  const handlers: {
    [K in Request["_tag"]]: (
      input: Extract<Request, { _tag: K }>
    ) => Effect.Effect<unknown, MemoryError | RootError | MemoryReadError | TransportError>
  } = {
    Ping: () => Effect.succeed({ ...identity, ...runtime, guardedShutdown: true, protocol: 1, pid: process.pid }),
    Shutdown: (input) =>
      input.expected === undefined || shutdownMatches(input.expected, identity, runtime)
        ? Effect.succeed({ stopping: true })
        : Effect.fail(new TransportError({ message: "Shutdown identity changed; refusing to stop this resident" })),
    Append: (input: Extract<Request, { _tag: "Append" }>) => memory.append(input),
    Snapshot: (input: Extract<Request, { _tag: "Snapshot" }>) =>
      memory.snapshot(input.root, {
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.view === undefined ? {} : { view: input.view })
      }),
    Zoom: (input: Extract<Request, { _tag: "Zoom" }>) => memory.zoom(input.root, input.first, input.count, input.page),
    Status: (input: Extract<Request, { _tag: "Status" }>) => memory.status(input.root),
    ReadSnapshot: (input: Extract<Request, { _tag: "ReadSnapshot" }>) => memory.readSnapshot(input.root, input),
    ReadZoom: (input: Extract<Request, { _tag: "ReadZoom" }>) =>
      memory.readZoom(input.root, input.first, input.count, input.page),
    ReadStatus: (input: Extract<Request, { _tag: "ReadStatus" }>) => memory.readStatus(input.root),
    Settle: (input: Extract<Request, { _tag: "Settle" }>) => memory.settle(input.root, input.waitMs),
    Roots: () => memory.roots()
  }
  return yield* Request.match(request, handlers)
})

export interface Options {
  readonly identity?: Identity
  readonly endpoint: Endpoint
  readonly maxConnections?: number
  readonly onShutdown?: () => void
  readonly runtime?: { readonly entrypoint: string; readonly executable: string; readonly dataDirectory: string }
}

// The lifetime lock prevents racing starters from unlinking each other's socket.
// OS release on process death makes stale-socket recovery deterministic.
const acquireOwnership = (paths: Endpoint): DatabaseSync => {
  const db = new DatabaseSync(join(paths.directory, "resident-owner.sqlite"))
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
    return db
  } catch (cause) {
    db.close()
    throw cause
  }
}

const removeStaleSocket = async (paths: Endpoint): Promise<void> => {
  const stat = await lstat(paths.socket).catch((cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return undefined
    throw cause
  })
  if (stat === undefined) return
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    (stat.mode & otherUserPermissions) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error("Unsafe stale socket")
  // A live endpoint may belong to another version which doesn't use this lock.
  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(paths.socket)
    probe.setTimeout(endpointProbeMs, () => {
      probe.destroy()
      reject(new Error("Endpoint probe timed out"))
    })
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", (cause: NodeJS.ErrnoException) => {
      probe.destroy()
      if (cause.code === "ECONNREFUSED" || cause.code === "ENOENT") resolve(false)
      else reject(new Error("Cannot verify stale endpoint"))
    })
  })
  if (live) throw new Error("Resident already listening")
  await unlink(paths.socket)
}

const listen = (server: Server, paths: Endpoint): Promise<void> =>
  new Promise((resolve, reject) => {
    const failed = (cause: Error) => reject(cause)
    server.once("error", failed)
    server.listen(paths.socket, () => {
      server.off("error", failed)
      resolve()
    })
  })

export const layer = (options: Options) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* prepare(options.endpoint)
      const context = yield* Effect.context<MemoryManager>()
      const limit = options.maxConnections ?? defaultConnectionLimit
      if (!Number.isSafeInteger(limit) || limit <= 0)
        return yield* Effect.fail(new TransportError({ message: "Invalid resident connection limit" }))
      const operations = Semaphore.makeUnsafe(limit)
      const sockets = new Set<Socket>()
      const accepted = new Set<Promise<void>>()
      let bound = false
      const ownership = yield* Effect.acquireRelease(
        Effect.try({
          try: () => acquireOwnership(options.endpoint),
          catch: () => new TransportError({ message: "Another resident owns this endpoint" })
        }),
        (db) => Effect.sync(() => db.close())
      )
      void ownership
      yield* Effect.try({
        try: () => verifySelectedOwner(options, options.identity ?? defaultIdentity),
        catch: () => new TransportError({ message: "This build is no longer the selected resident" })
      })
      const server = createServer((socket) => {
        if (sockets.size >= limit || accepted.size >= limit) {
          socket.destroy()
          return
        }
        sockets.add(socket)
        socket.on("error", () => socket.destroy())
        const frameDeadline = setTimeout(() => socket.destroy(), frameDeadlineMs)
        frameDeadline.unref()
        socket.once("close", () => {
          clearTimeout(frameDeadline)
          sockets.delete(socket)
        })
        socket.setTimeout(frameDeadlineMs, () => socket.destroy())
        socket.setEncoding("utf8")
        let buffer = ""
        let submitted = false
        const respond = (response: Response, shutdown = false) => {
          const frame = `${JSON.stringify(response)}\n`
          if (socket.destroyed) {
            if (shutdown) options.onShutdown?.()
            return
          }
          socket.end(
            Buffer.byteLength(frame) <= maxFrameBytes
              ? frame
              : `${JSON.stringify(Response.cases.Failure.make({ message: "Response exceeds transport limit" }))}\n`,
            () => {
              if (shutdown) options.onShutdown?.()
            }
          )
        }
        socket.on("data", (chunk: string) => {
          if (submitted) {
            socket.destroy()
            return
          }
          buffer += chunk
          if (Buffer.byteLength(buffer) > maxFrameBytes) {
            socket.destroy()
            return
          }
          const newline = buffer.indexOf("\n")
          if (newline < 0) return
          submitted = true
          clearTimeout(frameDeadline)
          socket.setTimeout(0)
          let request: Request
          try {
            if (buffer.slice(newline + 1).trim()) throw new Error("Multiple requests")
            request = Schema.decodeUnknownSync(Request)(JSON.parse(buffer.slice(0, newline)))
          } catch {
            respond(Response.cases.Failure.make({ message: "Invalid memory request" }))
            return
          }
          // Accepted writes outlive client disconnect. Shutdown drains this bounded
          // set before the manager layer releases its storage and cancels jobs.
          const operation = operations
            .withPermit(dispatch(request, options.identity ?? defaultIdentity, options.runtime))
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.provide(context),
              Effect.flatMap((value) => Schema.decodeUnknownEffect(ResponsePayload)(value)),
              Effect.map((value) => Response.cases.Success.make({ value })),
              Effect.catch((error) => Effect.succeed(operationFailure(error)))
            )
          const task = Effect.runPromise(operation)
            .then(
              (value) => respond(value, request._tag === "Shutdown" && value._tag === "Success"),
              () => respond(Response.cases.Failure.make({ message: "Resident operation failed" }))
            )
            .finally(() => {
              accepted.delete(task)
            })
          accepted.add(task)
        })
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
          for (const socket of sockets) socket.destroy()
          await Promise.all(accepted)
          await stopped
          if (bound) await unlink(options.endpoint.socket).catch(() => {})
        })
      )
      yield* Effect.tryPromise({
        try: async () => {
          await removeStaleSocket(options.endpoint)
          await listen(server, options.endpoint)
          bound = true
          await secureSocket(options.endpoint)
        },
        catch: () => new TransportError({ message: "Cannot bind private resident endpoint" })
      })
    })
  )

const operationFailure = (error: unknown): Extract<Response, { _tag: "Failure" }> => {
  if (error instanceof MemoryReadError)
    return Response.cases.Failure.make({ code: error.code, message: error.message, retryable: error.retryable })
  if (rootFailure(error))
    return Response.cases.Failure.make({
      code: "ROOT_UNAVAILABLE",
      message: "Cannot open the requested project memory",
      retryable: false
    })
  return Response.cases.Failure.make({ message: "Memory operation failed; inspect resident status or retry the event" })
}

const defaultIdentity: Identity = {
  application: applicationName,
  version: applicationVersion,
  implementation: createHash("sha256").update(`${applicationName}/${applicationVersion}`).digest("hex")
}

const verifySelectedOwner = (options: Options, identity: Identity): void => {
  if (options.runtime === undefined) return
  const selected = readSelection(options.runtime.dataDirectory, selectionFiles)
  if (selected === undefined) return
  if (
    selected.implementation !== identity.implementation ||
    selected.launch.entrypoint !== options.runtime.entrypoint ||
    selected.launch.executable !== options.runtime.executable
  )
    throw new Error("Superseded resident target")
}

const rootFailure = (error: unknown): boolean =>
  error instanceof RootError || (error instanceof MemoryError && error.operation === "open")

const shutdownMatches = (
  expected: typeof ServingIdentity.Type,
  identity: Identity,
  runtime: Options["runtime"]
): boolean =>
  expected.pid === process.pid &&
  expected.implementation === identity.implementation &&
  expected.entrypoint === runtime?.entrypoint &&
  expected.executable === runtime?.executable &&
  expected.dataDirectory === runtime?.dataDirectory
