import { Schema } from "effect"

export const Runtime = Schema.Literals(["codex", "claude"])
export type Runtime = typeof Runtime.Type
export const HookEvent = Schema.Literals(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"])
export type HookEvent = typeof HookEvent.Type
export const hookEvents: ReadonlyArray<HookEvent> = HookEvent.literals
export const hookTimeoutSeconds = 30

export const commandRequiresAcknowledgement = (runtime: Runtime, event: HookEvent): boolean =>
  runtime === "codex" && (event === "Stop" || event === "SubagentStop")
