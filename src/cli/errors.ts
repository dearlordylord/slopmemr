import { Schema } from "effect"

export class CliError extends Schema.TaggedError<CliError>()("CliError", { message: Schema.String }) {}
