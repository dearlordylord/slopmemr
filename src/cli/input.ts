import { Effect, Schema } from "effect"
import { maxFrameBytes } from "../resident/limits.js"
import { readJson } from "../local-state/input.js"
import { CliError } from "./errors.js"

export const parseJsonInput = (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text)
export const readInput = Effect.fn("CLI.readInput")((source: AsyncIterable<unknown> = process.stdin) =>
  readJson(source, maxFrameBytes).pipe(Effect.mapError((error) => new CliError({ message: error.message })))
)
