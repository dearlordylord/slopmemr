#!/usr/bin/env node
// Offline protocol fixture. It never contacts Codex or a model provider.
import { createInterface } from "node:readline"
import { appendFileSync, readFileSync, existsSync, watch } from "node:fs"
import { join } from "node:path"

if (process.argv.slice(2).join(" ") === "features enable hooks") process.exit(0)

const home = process.env.CODEX_HOME
const settings = JSON.parse(readFileSync(join(home, "fixture.json"), "utf8"))
const log = (event, extra = {}) =>
  appendFileSync(join(home, "events.jsonl"), JSON.stringify({ event, pid: process.pid, ...extra }) + "\n")
log("started", {
  home,
  apiKeyPresent: process.env.OPENAI_API_KEY !== undefined || process.env.CODEX_API_KEY !== undefined
})
process.on("SIGTERM", () => {
  log("stopped")
  if (settings.mode !== "resistant") process.exit(0)
})
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n")
const notify = (method, params) => write({ method, params })
const features = {}
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--disable") features[process.argv[i + 1]] = false
}
if (settings.mode === "unsafe") features.hooks = true
if (settings.mode === "feature-null") features.hooks = null
if (settings.mode === "feature-enabled-object") features.hooks = { enabled: true }
if (settings.mode === "feature-unknown") delete features.hooks
features.multi_agent_v2 = { enabled: false, max_concurrent_threads_per_session: 6 }
features.network_proxy = null
const disabled = process.argv.includes('mcp_servers={"danger.server"={enabled=false}}')
let sequence = 0
const complete = (threadId) => {
  if (settings.mode === "reuse-byte-budget")
    for (let count = 0; count < 9; count++) notify("compat/event", { text: "x".repeat(1024 * 1024) })
  if (settings.mode === "bad-notification") {
    notify("item/completed", { secret: "must-not-log" })
    return
  }
  if (settings.mode === "bad-account-update") {
    notify("account/updated", { authMode: {} })
    return
  }
  if (settings.mode === "wrong-thread-events") {
    notify("item/completed", { threadId: "other", item: { type: "commandExecution" } })
    notify("turn/completed", { threadId: "other", turn: { status: "failed" } })
    notify("thread/tokenUsage/updated", {
      threadId: "other",
      tokenUsage: { total: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0 } }
    })
  }
  if (settings.mode === "account-update-unchanged") notify("account/updated", {})
  if (settings.mode === "commentary-only") {
    notify("item/completed", {
      threadId,
      item: { type: "agentMessage", phase: "commentary", text: "Not a final summary" }
    })
    notify("turn/completed", { threadId, turn: { status: "completed" } })
    return
  }
  if (settings.mode === "agent-message-no-text") {
    notify("item/completed", { threadId, item: { type: "agentMessage" } })
    notify("turn/completed", { threadId, turn: { status: "completed" } })
    return
  }
  if (settings.mode === "account-changed") {
    notify("account/updated", { authMode: "apikey" })
    return
  }
  if (settings.mode === "request") {
    write({ id: 900, method: "item/commandExecution/requestApproval", params: {} })
    return
  }
  if (settings.mode === "tool") {
    notify("item/started", { threadId, item: { type: "commandExecution" } })
    return
  }
  notify("thread/tokenUsage/updated", {
    threadId,
    tokenUsage: { total: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 3 } }
  })
  notify("item/completed", {
    threadId,
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: settings.mode === "empty-summary" ? "" : "Remember the factual decision."
    }
  })
  notify("turn/completed", { threadId, turn: { status: settings.mode === "failed" ? "failed" : "completed" } })
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const reply = (result) => {
    if (settings.mode === "blank-lines") process.stdout.write("\n")
    write({ id: message.id, result })
  }
  if (message.method === "initialize") {
    if (settings.mode === "hold-initialize") {
      log("initializing")
      return
    }
    if (settings.mode === "rpc-error") {
      write({ id: message.id, error: { message: "must-not-log" } })
      return
    }
    if (settings.mode === "missing-result") {
      write({ id: message.id })
      return
    }
    if (settings.mode === "unknown-id") {
      write({ id: 99999, result: {} })
      return
    }
    if (settings.mode === "invalid-envelope") {
      write({})
      return
    }
    if (settings.mode === "string-id") {
      write({ id: "invalid", result: {} })
      return
    }
    if (settings.mode === "oversized-line") {
      process.stdout.write("x".repeat(2 * 1024 * 1024 + 1))
      return
    }
    if (settings.mode === "oversized-stream") {
      for (let count = 0; count < 18; count++) notify("unknown/event", { text: "x".repeat(1024 * 1024) })
      return
    }
  }
  if (message.method === "initialize") reply({})
  else if (message.method === "account/read") {
    const mode = JSON.parse(readFileSync(join(home, "fixture.json"), "utf8")).mode
    reply({
      requiresOpenaiAuth: mode !== "account-auth-not-required",
      account: mode === "logged-out" ? null : { type: mode === "api-key" ? "apiKey" : "chatgpt" }
    })
  } else if (message.method === "config/read")
    reply({
      config: {
        model_provider: settings.mode === "wrong-provider" ? "other" : "openai",
        forced_login_method: "chatgpt",
        openai_base_url: "https://chatgpt.com/backend-api/codex",
        chatgpt_base_url: "https://chatgpt.com/backend-api/",
        features,
        web_search: settings.mode === "unsafe-web-search" ? "live" : "disabled",
        tools: { view_image: false },
        ...(settings.mode === "no-mcp-property"
          ? {}
          : {
              mcp_servers: settings.mcp
                ? { "danger.server": { enabled: settings.mode === "mcp-stays-enabled" || !disabled } }
                : {}
            })
      }
    })
  else if (message.method === "model/list")
    reply({
      data: [
        {
          model:
            settings.mode === "missing-model" ||
            settings.mode === "catalog-cycle" ||
            (settings.mode === "catalog-page" && message.params.cursor === undefined)
              ? "other"
              : "gpt-6-luna"
        }
      ],
      nextCursor:
        settings.mode === "catalog-cycle" || (settings.mode === "catalog-page" && message.params.cursor === undefined)
          ? "page"
          : null
    })
  else if (message.method === "thread/start") {
    log("thread", { params: message.params })
    reply({ thread: { id: `thread-${++sequence}` } })
  } else if (message.method === "thread/unsubscribe") {
    log("unsubscribed", { params: message.params })
    reply({ status: "unsubscribed" })
  } else if (message.method === "turn/start") {
    log("turn", { params: message.params })
    if (settings.mode === "malformed") {
      process.stdout.write("not-json\n")
      return
    }
    if (settings.mode === "exit") {
      process.exit(1)
    }
    if (settings.mode === "hold") {
      reply({ turn: { id: "turn", status: "inProgress" } })
      log("held")
      const release = join(home, "release")
      const watcher = watch(home, () => {
        if (existsSync(release)) {
          watcher.close()
          complete(message.params.threadId)
        }
      })
      if (existsSync(release)) {
        watcher.close()
        complete(message.params.threadId)
      }
      return
    }
    // Exercise completion racing ahead of the turn/start RPC reply.
    complete(message.params.threadId)
    reply({ turn: { id: "turn", status: "inProgress" } })
  } else write({ id: message.id, error: { code: -32601, message: "unknown method" } })
})
