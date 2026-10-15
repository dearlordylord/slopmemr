import { Deferred, Effect, Option, Schema } from "effect"

const Header = Schema.Struct({ id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])) })
const Json = Schema.fromJsonString(Schema.Unknown)
export class ProtocolLimitError extends Schema.TaggedError<ProtocolLimitError>()("ProtocolLimitError", {
  reason: Schema.Literals(["frame", "requests"])
}) {}

export interface Drain {
  readonly input: (chunk: Uint8Array) => Effect.Effect<void, ProtocolLimitError>
  readonly output: (chunk: string | Uint8Array) => Effect.Effect<void, ProtocolLimitError>
  readonly end: Effect.Effect<void>
  readonly await: Effect.Effect<void>
}
export interface DrainLimits {
  readonly frameBytes: number
  readonly requests: number
}

const ids = (frame: string): string[] => {
  const parsed = Schema.decodeUnknownOption(Json)(frame)
  if (Option.isNone(parsed)) return []
  const values: unknown[] = Array.isArray(parsed.value) ? parsed.value : [parsed.value]
  return values.flatMap((entry) => {
    const decoded = Schema.decodeUnknownOption(Header)(entry)
    return Option.isSome(decoded) && decoded.value.id !== undefined ? [JSON.stringify(decoded.value.id)] : []
  })
}

/** Tracks complete requests until their response is written, including batches.
 * The owning transport scope controls cancellation; EOF drains accepted work. */
export const makeDrain = Effect.fn("MCP.makeDrain")(function* (limits: DrainLimits): Effect.fn.Return<Drain> {
  const done = yield* Deferred.make<void>()
  const outstanding = new Map<string, number>()
  const decoder = new TextDecoder()
  const outputDecoder = new TextDecoder()
  let input = "",
    output = "",
    ended = false,
    pending = 0
  const notify = Effect.suspend(() =>
    ended && pending === 0 ? Deferred.succeed(done, undefined).pipe(Effect.asVoid) : Effect.void
  )
  const add = (key: string) =>
    Effect.suspend(() => {
      if (pending >= limits.requests) return Effect.fail(new ProtocolLimitError({ reason: "requests" }))
      pending++
      outstanding.set(key, (outstanding.get(key) ?? 0) + 1)
      return Effect.void
    })
  const remove = (key: string) =>
    Effect.sync(() => {
      const count = outstanding.get(key)
      if (count === undefined) return
      pending--
      if (count === 1) outstanding.delete(key)
      else outstanding.set(key, count - 1)
    })
  const frames = Effect.fn("MCP.drainFrames")(function* (
    buffer: string,
    observe: (key: string) => Effect.Effect<void, ProtocolLimitError>
  ) {
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const frame = buffer.slice(0, newline)
      if (Buffer.byteLength(frame) > limits.frameBytes)
        return yield* Effect.fail(new ProtocolLimitError({ reason: "frame" }))
      for (const key of ids(frame)) yield* observe(key)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
    if (Buffer.byteLength(buffer) > limits.frameBytes)
      return yield* Effect.fail(new ProtocolLimitError({ reason: "frame" }))
    return buffer
  })
  return {
    input: Effect.fn("MCP.drainInput")(function* (chunk: Uint8Array) {
      input = yield* frames(input + decoder.decode(chunk, { stream: true }), add)
    }),
    output: Effect.fn("MCP.drainOutput")(function* (chunk: string | Uint8Array) {
      output = yield* frames(
        output + (typeof chunk === "string" ? chunk : outputDecoder.decode(chunk, { stream: true })),
        remove
      )
      yield* notify
    }),
    end: Effect.suspend(() => {
      ended = true
      return notify
    }),
    await: Deferred.await(done)
  }
})
