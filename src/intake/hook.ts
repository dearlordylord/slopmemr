import { createHash } from "node:crypto"
import { Schema } from "effect"
import { Append } from "../memory/contracts.js"
import type { AuthReference } from "../compaction/profile.js"
import { HookEvent, hookEvents, hookTimeoutSeconds } from "./events.js"
import type { Runtime } from "./events.js"

export const Hook = Schema.Struct({
  hook_event_name: HookEvent,
  session_id: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  agent_id: Schema.optionalKey(Schema.NonEmptyString),
  turn_id: Schema.optionalKey(Schema.NonEmptyString),
  tool_use_id: Schema.optionalKey(Schema.NonEmptyString),
  event_id: Schema.optionalKey(Schema.NonEmptyString),
  prompt: Schema.optionalKey(Schema.String),
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Json),
  tool_response: Schema.optionalKey(Schema.Json),
  last_assistant_message: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type Hook = typeof Hook.Type

export interface Options {
  readonly runtime: Runtime
  readonly root?: string
  readonly auth?: AuthReference
}

/** Observe supplied fields only. No transcript, source-file, or credential reads.
 * Without a native event identity, a nonce preserves repeated identical prompts. */
const observedText = (event: Hook) =>
  JSON.stringify({
    event: event.hook_event_name,
    ...optionalObservation("prompt", event.prompt),
    ...optionalObservation("tool", event.tool_name),
    ...optionalObservation("input", event.tool_input),
    ...optionalObservation("result", event.tool_response),
    ...optionalObservation("assistant", event.last_assistant_message ?? undefined)
  })

const optionalObservation = (key: string, value: Schema.Json | undefined) =>
  value === undefined ? {} : { [key]: value }

export const normalize = (event: Hook, options: Options, nonce: string): Append => {
  const nativeId =
    event.event_id ??
    event.tool_use_id ??
    event.turn_id ??
    (event.hook_event_name === "SessionStart" ? "session-start" : nonce)
  const eventId = createHash("sha256")
    .update(JSON.stringify([event.hook_event_name, nativeId]))
    .digest("hex")
  return Append.make({
    root: options.root ?? event.cwd,
    agent: { runtime: options.runtime, sessionId: event.session_id, agentId: event.agent_id ?? "root" },
    eventId,
    kind: event.hook_event_name,
    text: observedText(event),
    ...(options.auth === undefined ? {} : { auth: options.auth })
  })
}

export const hookConfiguration = (command: string) => ({
  hooks: Object.fromEntries(
    hookEvents.map((event) => [event, [{ hooks: [{ type: "command", command, timeout: hookTimeoutSeconds }] }]])
  )
})
