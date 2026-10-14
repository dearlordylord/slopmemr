import { expect, it } from "vitest"
import { Schema } from "effect"
import { Hook, hookConfiguration, normalize } from "./hook.js"
import { commandRequiresAcknowledgement } from "./events.js"

it("retains only observed event fields, real child identity, and an explicit calling root", () => {
  const event = Schema.decodeUnknownSync(Hook)({
    hook_event_name: "PostToolUse",
    session_id: "session",
    agent_id: "child",
    cwd: "/worktree",
    tool_use_id: "tool-1",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
    tool_response: "result",
    transcript_path: "/secret/transcript",
    api_key: "do not persist"
  })
  const value = normalize(event, { runtime: "codex", root: "/real-root", auth: { codexHome: "/profile" } }, "nonce")
  expect(value.root).toBe("/real-root")
  expect(value.agent.agentId).toBe("child")
  expect(value.text).toContain('"result":"result"')
  expect(value.text).not.toContain("secret")
  expect(value.text).not.toContain("do not persist")
  expect(normalize(event, { runtime: "codex" }, "nonce").eventId).toBe(value.eventId)
})

it("keeps repeated identical prompts distinct when the host supplies no event identity", () => {
  const event = Hook.make({ hook_event_name: "UserPromptSubmit", session_id: "session", cwd: "/root", prompt: "again" })
  expect(normalize(event, { runtime: "claude" }, "first").eventId).not.toBe(
    normalize(event, { runtime: "claude" }, "second").eventId
  )
})

it("rejects missing session attribution and unknown hook shapes", () => {
  expect(() => Schema.decodeUnknownSync(Hook)({ hook_event_name: "PostToolUse", cwd: "/root" })).toThrow()
})

it("accepts a native Stop with no assistant message", () => {
  const event = Schema.decodeUnknownSync(Hook)({
    hook_event_name: "Stop",
    session_id: "s",
    cwd: "/root",
    turn_id: "t",
    last_assistant_message: null
  })
  expect(normalize(event, { runtime: "codex" }, "nonce").text).toBe('{"event":"Stop"}')
})

it("deduplicates SessionStart independently of fallback nonces and acknowledges only native stop events", () => {
  const event = Hook.make({ hook_event_name: "SessionStart", session_id: "s", cwd: "/root" })
  expect(normalize(event, { runtime: "codex" }, "a").eventId).toBe(normalize(event, { runtime: "codex" }, "b").eventId)
  expect(commandRequiresAcknowledgement("codex", "SubagentStop")).toBe(true)
  expect(commandRequiresAcknowledgement("codex", "UserPromptSubmit")).toBe(false)
  expect(commandRequiresAcknowledgement("claude", "Stop")).toBe(false)
  expect(hookConfiguration("owned command").hooks.Stop).toEqual([
    { hooks: [{ type: "command", command: "owned command", timeout: 30 }] }
  ])
})
