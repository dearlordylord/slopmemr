#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
const home = process.env.CLAUDE_CONFIG_DIR
const mode = readFileSync(join(home, "fixture-mode"), "utf8")
const args = process.argv.slice(2)
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n")
appendFileSync(
  join(home, "events"),
  JSON.stringify({ event: args.includes("auth") ? "auth" : "turn", pid: process.pid }) + "\n"
)
if (Object.keys(process.env).some((name) => /^(ANTHROPIC_|OPENAI_|CODEX_)/u.test(name))) process.exit(5)
if (args.includes("auth")) {
  const account = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    forcedLoginMethod: "claudeai",
    configDirectory: home,
    subscriptionType: "pro"
  }
  if (mode === "api-key") account.authMethod = "api_key"
  if (mode === "logged-out") account.loggedIn = false
  if (mode === "third-party") account.apiProvider = "bedrock"
  if (mode === "unsafe-login-policy") account.forcedLoginMethod = "console"
  if (mode === "wrong-profile") account.configDirectory = "/"
  emit(account)
  process.exit(0)
}
if (
  args[args.indexOf("--model") + 1] !== "haiku" ||
  args[args.indexOf("--tools") + 1] !== "" ||
  !args.includes("--safe-mode") ||
  !args.includes("--restricted") ||
  !args.includes("--no-session-persistence")
)
  process.exit(6)
if (mode === "exit") process.exit(7)
if (mode === "orphan") {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }
  )
  child.once("message", () => {
    appendFileSync(join(home, "events"), JSON.stringify({ event: "descendant", pid: child.pid }) + "\n")
    process.stdout.write("malformed\n")
  })
} else if (mode === "hold") {
  appendFileSync(join(home, "events"), JSON.stringify({ event: "held", pid: process.pid }) + "\n")
  setInterval(() => {}, 1000)
} else {
  for await (const chunk of process.stdin) void chunk
  if (mode === "malformed") {
    process.stdout.write("not-json\n")
    process.exit(0)
  }
  if (mode === "oversized") {
    process.stdout.write("x".repeat(2 * 1024 * 1024 + 1))
    process.exit(0)
  }
  emit({
    type: "system",
    subtype: "init",
    tools: mode === "tools" ? ["Bash"] : [],
    mcp_servers: mode === "mcp" ? [{}] : []
  })
  emit({
    type: "assistant",
    message: { content: [{ type: mode === "tool-use" ? "tool_use" : "text", text: "summary" }] }
  })
  if (mode === "unsupported") emit({ type: "user", message: {} })
  if (mode === "rate-limit") emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })
  if (mode === "rate-limit-failed") emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })
  if (mode !== "missing-result") {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: mode === "empty" ? " " : "Remember the Claude fact.",
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 3 },
      modelUsage: { [mode === "wrong-model" ? "claude-sonnet-4-5" : "claude-haiku-4-5"]: {} }
    }
    if (mode === "failed") result.is_error = true
    emit(result)
    if (mode === "duplicate-result") emit(result)
  }
}
