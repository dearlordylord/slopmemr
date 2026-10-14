import { createConnection } from "node:net"
import { Effect, Schema } from "effect"
import { TransportError, verifySocket } from "./endpoint.js"
import type { Endpoint } from "./endpoint.js"
import { maxFrameBytes, Response, responseSchemas } from "./protocol.js"
import type { Request } from "./protocol.js"

export const request = Effect.fn("ResidentClient.request")(function* (
  paths: Endpoint,
  value: Request,
  timeoutMs = 5_000
) {
  yield* verifySocket(paths)
  const frame = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(frame) > maxFrameBytes)
    return yield* Effect.fail(new TransportError({ message: "Request too large" }))
  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<Response>((resolve, reject) => {
        const socket = createConnection(paths.socket)
        let buffer = ""
        let finished = false
        const abort = () => finish(new Error("Request interrupted"))
        const finish = (cause: Error | undefined, result?: Response) => {
          if (finished) return
          finished = true
          signal.removeEventListener("abort", abort)
          socket.destroy()
          if (cause !== undefined) reject(cause)
          else if (result !== undefined) resolve(result)
        }
        signal.addEventListener("abort", abort, { once: true })
        socket.setTimeout(timeoutMs, () => finish(new Error("Resident request timed out")))
        socket.setEncoding("utf8")
        socket.on("connect", () => socket.write(frame))
        socket.on("error", () => finish(new Error("Resident unavailable")))
        socket.on("end", () => finish(new Error("Resident closed without a response")))
        socket.on("data", (chunk: string) => {
          buffer += chunk
          if (Buffer.byteLength(buffer) > maxFrameBytes) {
            finish(new Error("Response too large"))
            return
          }
          const index = buffer.indexOf("\n")
          if (index < 0) return
          try {
            if (buffer.slice(index + 1).trim()) throw new Error("Multiple response frames")
            const response = Schema.decodeUnknownSync(Response)(JSON.parse(buffer.slice(0, index)))
            if (response._tag === "Success") Schema.decodeUnknownSync(responseSchemas[value._tag])(response.value)
            finish(undefined, response)
          } catch {
            finish(new Error("Invalid resident response"))
          }
        })
      }),
    catch: () => new TransportError({ message: "Resident request failed or timed out" })
  })
})
