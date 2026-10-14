import { Schema } from "effect"
import { AuthReference } from "../compaction/profile.js"
import { AbsolutePath } from "../local-state/contracts.js"
import { maximumAppendCharacters, maximumIdentityLength } from "./limits.js"

const ShortText = Schema.NonEmptyString.check(Schema.isMaxLength(maximumIdentityLength))
export const Agent = Schema.Struct({ runtime: ShortText, sessionId: ShortText, agentId: ShortText })
export type Agent = typeof Agent.Type

export { AuthReference } from "../compaction/profile.js"

export const Append = Schema.Struct({
  root: AbsolutePath,
  agent: Agent,
  eventId: ShortText,
  kind: ShortText,
  text: Schema.String.check(Schema.isMaxLength(maximumAppendCharacters)),
  auth: Schema.optionalKey(AuthReference)
})
export type Append = typeof Append.Type

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  operation: Schema.String,
  message: Schema.String
}) {}

export const memoryError = (operation: string, message: string) => new MemoryError({ operation, message })
