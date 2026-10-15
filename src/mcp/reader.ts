import { Context, Effect, Layer, Schema } from "effect"
import { ReadResult, MemoryReadError } from "../memory/reading.js"
import type { ReadRequest } from "../memory/reading.js"
import type { TransportError } from "../resident/endpoint.js"
import { responseSchemas } from "../resident/protocol.js"

export interface Interface {
  readonly read: (request: ReadRequest) => Effect.Effect<ReadResult, MemoryReadError>
}
export class Reader extends Context.Service<Reader, Interface>()("slopmemr/Reader") {}
export type Port = (request: ReadRequest) => Effect.Effect<unknown, TransportError>

export const layer = (send: Port) =>
  Layer.sync(Reader, () => {
    const read = Effect.fn("MemoryReader.read")(function* (request: ReadRequest) {
      const raw = yield* send(request).pipe(
        Effect.mapError(
          (error) =>
            new MemoryReadError({
              code: error.code ?? "RESIDENT_UNAVAILABLE",
              message:
                error.code === undefined
                  ? "Memory resident is unavailable; inspect slopmemr doctor or retry"
                  : error.message,
              retryable: error.retryable ?? true
            })
        )
      )
      yield* Schema.decodeUnknownEffect(responseSchemas[request._tag])(raw).pipe(Effect.mapError(invalidResponse))
      return yield* Schema.decodeUnknownEffect(ReadResult)(raw).pipe(Effect.mapError(invalidResponse))
    })
    return Reader.of({ read })
  })

const invalidResponse = () =>
  new MemoryReadError({
    code: "RESIDENT_UNAVAILABLE",
    message: "Resident returned an incompatible memory response; reconnect after updating",
    retryable: false
  })
