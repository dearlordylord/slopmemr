import { Effect, Schema } from "effect"

export class InputError extends Schema.TaggedError<InputError>()("InputError", { message: Schema.String }) {}

export const readJson = Effect.fn("Input.readJson")(function* (source: AsyncIterable<unknown>, maximumBytes: number) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of source) {
        if (!(Buffer.isBuffer(chunk) || typeof chunk === "string")) throw new Error("Invalid input chunk")
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > maximumBytes) throw new Error("Input exceeds limit")
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    catch: () => new InputError({ message: "Expected bounded JSON input on stdin" })
  })
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
    Effect.mapError(() => new InputError({ message: "Expected JSON input on stdin" }))
  )
})
