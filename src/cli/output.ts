import { Console, Effect, Schema } from "effect"
import { CompactionError } from "../compaction/compactor.js"
import { InstallationError } from "../installation/contracts.js"
import { MemoryError } from "../memory/contracts.js"
import { RootError } from "../project-root/root.js"
import { TransportError } from "../resident/endpoint.js"
import { CliError } from "./errors.js"

export const printJson = Effect.fn("CLI.printJson")(function* (value: unknown) {
  const parsed = yield* Schema.decodeUnknownEffect(Schema.Json)(value)
  yield* Console.log(JSON.stringify(parsed))
})
const safeErrors = [CliError, InstallationError, CompactionError, MemoryError, RootError, TransportError]

export const reportFailure = Effect.fn("CLI.reportFailure")(function* (error: unknown) {
  const message =
    error instanceof Error && safeErrors.some((constructor) => error instanceof constructor)
      ? error.message
      : "Invalid command input or configuration"
  yield* Console.error(message)
  yield* Effect.sync(() => {
    process.exitCode = 1
  })
})
