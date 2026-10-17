import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Schema } from "effect"
import { maximumResponseBytes, maximumResponseLineBytes, terminationGraceMs, unsupportedMethodCode } from "./limits.js"

const Envelope = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown)
})
export type Notification = { readonly method: string; readonly params: unknown }

export const disabledFeatures = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
  "code_mode",
  "code_mode_host",
  "browser_use",
  "computer_use",
  "image_generation",
  "view_image",
  "sleep_tool",
  "goals",
  "skill_search",
  "tool_suggest",
  "memories",
  "remote_control",
  "remote_plugin",
  "auth_elicitation",
  "api_key_model_discovery",
  "api_key_cyber_access_programs"
] as const

/** Strict, bounded JSON-lines transport. Errors deliberately exclude provider
 * payloads: those may contain credentials or the source memory. */
export class AppServer {
  readonly notifications = new EventEmitter()
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  #sequence = 0
  #buffer = ""
  #failure: Error | undefined
  #received = 0
  #closing: Promise<void> | undefined

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly directory: string
  ) {
    child.stdout.setEncoding("utf8")
    child.stderr.resume()
    child.stdout.on("data", (chunk: string) => this.#receive(chunk))
    child.on("error", () => this.#fail(new Error("Codex app server failed to start")))
    child.on("exit", () => this.#fail(new Error("Codex app server exited")))
    child.stdin.on("error", () => this.#fail(new Error("Codex app server pipe closed")))
  }

  static async open(executable: string, codexHome: string, disabledMcp: readonly string[] = []): Promise<AppServer> {
    if (!isAbsolute(codexHome)) throw new Error("Caller Codex home must be absolute")
    const home = await realpath(codexHome)
    const directory = await mkdtemp(join(tmpdir(), "slopmemr-compactor-"))
    try {
      const child = spawn(
        executable,
        [
          ...disabledFeatures.flatMap((name) => ["--disable", name]),
          "-c",
          'web_search="disabled"',
          "-c",
          "tools.view_image=false",
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          'model_provider="openai"',
          "-c",
          'forced_login_method="chatgpt"',
          "-c",
          'openai_base_url="https://chatgpt.com/backend-api/codex"',
          "-c",
          'chatgpt_base_url="https://chatgpt.com/backend-api/"',
          ...(disabledMcp.length === 0
            ? []
            : [
                "-c",
                `mcp_servers={${disabledMcp.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`
              ]),
          "app-server",
          "--listen",
          "stdio://"
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            CODEX_HOME: home,
            OPENAI_API_KEY: undefined,
            CODEX_API_KEY: undefined,
            CODEX_ACCESS_TOKEN: undefined,
            OPENAI_BASE_URL: undefined
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32"
        }
      )
      return new AppServer(child, directory)
    } catch (cause) {
      await rm(directory, { recursive: true, force: true })
      throw cause
    }
  }

  #receive(chunk: string): void {
    if (this.#failure !== undefined) return
    this.#received += Buffer.byteLength(chunk)
    this.#buffer += chunk
    if (this.#exceedsLimits()) {
      this.#fail(new Error("Codex app server exceeded response limits"))
      return
    }
    let newline: number
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        if (!this.#accept(Schema.decodeUnknownSync(Envelope)(JSON.parse(line)))) return
      } catch {
        this.#fail(new Error("Invalid Codex app-server response"))
        return
      }
    }
  }

  #exceedsLimits(): boolean {
    return this.#received > maximumResponseBytes || Buffer.byteLength(this.#buffer) > maximumResponseLineBytes
  }

  #accept(message: typeof Envelope.Type): boolean {
    if (message.method !== undefined) {
      // No server request (approval, tool, OAuth refresh, elicitation) is
      // serviced by a summarizer. Stop the attempt rather than execute it.
      if (message.id !== undefined) {
        this.#write({
          id: message.id,
          error: { code: unsupportedMethodCode, message: "Unavailable in memory compactor" }
        })
        this.#fail(new Error("Codex requested an unsupported compactor action"))
        return false
      }
      this.notifications.emit("notification", { method: message.method, params: message.params })
    } else if (typeof message.id === "number") {
      this.#resolveResponse(message.id, message)
    } else throw new Error("Invalid app-server envelope")
    return true
  }

  #resolveResponse(id: number, message: typeof Envelope.Type): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) throw new Error("Unknown request ID")
    if (message.error === undefined && !("result" in message)) throw new Error("Missing result")
    this.#pending.delete(id)
    if (message.error !== undefined) pending.reject(new Error("Codex app server rejected the request"))
    else pending.resolve(message.result)
  }

  #write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return
    this.#failure = error
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.notifications.emit("failure", error)
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#write({ id, method, params })
    })
  }

  notify(method: string): void {
    this.#write({ method })
  }

  get healthy(): boolean {
    return this.#failure === undefined
  }

  beginAttempt(): void {
    if (this.#failure !== undefined) throw this.#failure
    this.#received = 0
  }

  invalidate(message: string): void {
    this.#fail(new Error(message))
  }

  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    this.#fail(new Error("Compactor closed"))
    if (this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== "win32" && this.child.pid !== undefined) process.kill(-this.child.pid, signal)
            else this.child.kill(signal)
          } catch {
            /* The process already exited. */
          }
        }
        const force = setTimeout(() => kill("SIGKILL"), terminationGraceMs)
        force.unref()
        this.child.once("exit", () => {
          clearTimeout(force)
          resolve()
        })
        kill("SIGTERM")
      })
    }
    this.notifications.removeAllListeners()
    await rm(this.directory, { recursive: true, force: true })
  }
}
