import { Effect, Schema } from "effect"
import { maxFrameBytes } from "../resident/limits.js"
import { CliError } from "./errors.js"

export const parseJsonInput = (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text)

export const readInput = Effect.fn("CLI.readInput")(function* (source: AsyncIterable<unknown> = process.stdin) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of source) {
        if (!(Buffer.isBuffer(chunk) || typeof chunk === "string"))
          throw new CliError({ message: "Invalid stdin chunk" })
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > maxFrameBytes) throw new CliError({ message: "Input exceeds transport limit" })
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    catch: () => new CliError({ message: "Expected bounded JSON input on stdin" })
  })
  return yield* parseJsonInput(text).pipe(
    Effect.mapError(() => new CliError({ message: "Expected JSON input on stdin" }))
  )
})
