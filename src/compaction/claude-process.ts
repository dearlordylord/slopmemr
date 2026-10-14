import { spawn } from "node:child_process"
import { maximumResponseBytes, maximumResponseLineBytes, terminationGraceMs } from "./limits.js"

export const claudeEnvironment = (home: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|AWS_|GOOGLE_|GCLOUD_|AZURE_)/u.test(name) && name !== "NODE_OPTIONS"
    )
  ),
  CLAUDE_CONFIG_DIR: home,
  CLAUDE_CODE_SAFE_MODE: "1"
})

export interface CliOptions {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly directory: string
  readonly home: string
  readonly input: string
  readonly signal: AbortSignal
  readonly receive?: (line: string) => void
}

/** Bounded CLI transport. Abort and rejection terminate the entire process group. */
export const runClaude = (options: CliOptions): Promise<string> => {
  if (options.signal.aborted) return Promise.reject(new Error("Claude compaction interrupted"))
  const child = spawn(options.executable, [...options.args], {
    cwd: options.directory,
    env: claudeEnvironment(options.home),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "ignore"]
  })
  return new Promise((resolve, reject) => {
    let output = ""
    let pending = ""
    let failure: Error | undefined
    let force: NodeJS.Timeout | undefined
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        /* Process already exited. */
      }
    }
    const fail = () => {
      if (failure !== undefined) return
      failure = new Error("Claude compactor process failed or was interrupted")
      kill("SIGTERM")
      force = setTimeout(() => kill("SIGKILL"), terminationGraceMs)
      force.unref()
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (failure !== undefined) return
      output += chunk
      pending += chunk
      if (Buffer.byteLength(output) > maximumResponseBytes) return fail()
      try {
        pending = receiveLines(pending, options.receive)
      } catch {
        fail()
      }
    })
    child.once("error", fail)
    child.stdin.on("error", fail)
    options.signal.addEventListener("abort", fail, { once: true })
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", fail)
      // The leader may exit on TERM while a descendant ignores it. Do not
      // cancel escalation until the remaining process group has been killed.
      kill("SIGKILL")
      if (force !== undefined) clearTimeout(force)
      if (code !== 0 || failure !== undefined) reject(failure ?? new Error("Claude exited unsuccessfully"))
      else {
        try {
          if (pending.trim()) options.receive?.(pending)
          resolve(output)
        } catch {
          reject(new Error("Invalid Claude result"))
        }
      }
    })
    if (options.signal.aborted) fail()
    child.stdin.end(options.input)
  })
}

const receiveLines = (input: string, receive?: (line: string) => void): string => {
  let pending = input
  let newline: number
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline)
    if (Buffer.byteLength(line) > maximumResponseLineBytes) throw new Error("Oversized Claude frame")
    if (line.trim()) receive?.(line)
    pending = pending.slice(newline + 1)
  }
  if (Buffer.byteLength(pending) > maximumResponseLineBytes) throw new Error("Oversized Claude frame")
  return pending
}
