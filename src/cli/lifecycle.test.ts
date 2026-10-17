import { execFile, spawn } from "node:child_process"
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { Schema } from "effect"

const workflowDeadlineMs = 120_000
const execute = promisify(execFile)
const main = resolve("dist/bin/slopmemr.mjs")
const fixtureServer = resolve("src/compaction/fixtures/app-server.mjs")
const fixtures: { directory: string; env: NodeJS.ProcessEnv }[] = []
const Ping = Schema.Struct({
  _tag: Schema.Literal("Success"),
  value: Schema.Struct({ pid: Schema.Int, protocol: Schema.Literal(1) })
})

const run = async (env: NodeJS.ProcessEnv, args: string[], input?: unknown) => {
  if (input === undefined) {
    const result = await execute(process.execPath, [main, ...args], { env, timeout: 15_000 })
    return { ...result, code: 0 }
  }
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [main, ...args], { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "",
      stderr = ""
    const deadline = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("CLI deadline exceeded"))
    }, 15_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.once("error", (cause) => {
      clearTimeout(deadline)
      reject(cause)
    })
    child.once("exit", (code) => {
      clearTimeout(deadline)
      resolve({ stdout, stderr, code })
    })
    child.stdin.end(JSON.stringify(input))
  })
}

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "sm-cli-"))
  const root = join(directory, "main")
  const profile = join(directory, "profile")
  await mkdir(profile)
  await writeFile(join(profile, "fixture.json"), JSON.stringify({ mode: "normal", mcp: true }))
  await chmod(fixtureServer, 0o755)
  await execute("git", ["init", root])
  await execute("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial"
  ])
  const env = {
    ...process.env,
    SLOPMEMR_RUNTIME_DIR: join(directory, "run"),
    SLOPMEMR_DATA_DIR: join(directory, "data"),
    SLOPMEMR_CODEX_BIN: fixtureServer,
    CODEX_HOME: profile
  }
  fixtures.push({ directory, env })
  return { directory, root, profile, env }
}
afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await run(entry.env, ["stop"]).catch(() => {})
    await rm(entry.directory, { recursive: true, force: true })
  }
})

it(
  "racing compiled CLI starters converge, worktrees share memory, and killed residents recover durable records",
  async () => {
    const options = await fixture()
    const starts = await Promise.all(Array.from({ length: 8 }, () => run(options.env, ["start"])))
    const pids = starts.map((result) => Schema.decodeUnknownSync(Ping)(JSON.parse(result.stdout)).value.pid)
    expect(new Set(pids).size).toBe(1)
    const linked = join(options.directory, "worktree")
    await execute("git", ["-C", options.root, "worktree", "add", "--detach", linked])
    const append = {
      root: linked,
      agent: { runtime: "codex", sessionId: "session", agentId: "root" },
      eventId: "e",
      kind: "user",
      text: "remember through a crash"
    }
    const receipt = await run(options.env, ["append"], append)
    expect(JSON.parse(receipt.stdout)).toMatchObject({
      root: options.root,
      receipt: { endExclusive: 1 },
      duplicate: false
    })
    expect((await run(options.env, ["snapshot", "--root", options.root])).stdout).toContain("remember through a crash")
    const pid = pids[0]
    if (pid === undefined) throw new Error("Missing resident PID")
    process.kill(pid, "SIGKILL")
    // Auto-start retries until the OS releases the writer lock and stale socket.
    const retry = await run(options.env, ["append"], { ...append, root: options.root })
    expect(JSON.parse(retry.stdout)).toMatchObject({ receipt: { endExclusive: 1 }, duplicate: true })
    expect((await run(options.env, ["snapshot", "--root", linked])).stdout).toContain("remember through a crash")
    expect((await run(options.env, ["roots"])).stdout).toContain(options.root)
  },
  workflowDeadlineMs
)

it(
  "native hooks persist observations silently and use the explicitly selected calling root/profile",
  async () => {
    const options = await fixture()
    const result = await run(
      options.env,
      ["hook", "--runtime", "codex", "--root", options.root, "--codex-home", options.profile],
      {
        hook_event_name: "PostToolUse",
        cwd: options.root,
        session_id: "session",
        agent_id: "child",
        tool_use_id: "tool-1",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_response: "a supplied observation ".repeat(80)
      }
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    expect((await run(options.env, ["settle", "--root", options.root])).stdout).toContain(
      "Remember the factual decision"
    )
    const original = await run(options.env, ["zoom", "--root", options.root, "--first", "0", "--count", "1"])
    expect(original.stdout).toContain("a supplied observation")
    const invalid = await run(options.env, ["hook", "--runtime", "codex"], { api_key: "private-sentinel" })
    expect(invalid.code).toBe(1)
    expect(invalid.stdout).toBe("")
    expect(invalid.stderr).not.toContain("private-sentinel")
    const stop = await run(options.env, ["hook", "--runtime", "codex", "--root", options.root], {
      hook_event_name: "Stop",
      cwd: options.root,
      session_id: "session",
      turn_id: "turn",
      last_assistant_message: null
    })
    expect(stop.code).toBe(0)
    expect(stop.stdout).toBe("{}\n")
  },
  workflowDeadlineMs
)

it("instruction-only and empty terminal hooks acknowledge without starting a resident", async () => {
  const options = await fixture()
  const args = ["hook", "--runtime", "codex"]
  const base = { cwd: options.root, session_id: "session" }
  const guide = await run(options.env, args, { ...base, hook_event_name: "SessionStart" })
  expect(guide.code).toBe(0)
  expect(guide.stdout).toContain("slopmemr_snapshot")
  for (const hook_event_name of ["Stop", "SubagentStop"]) {
    const result = await run(options.env, args, { ...base, hook_event_name, last_assistant_message: "  " })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("{}\n")
  }
  const claude = await run(options.env, ["hook", "--runtime", "claude"], { ...base, hook_event_name: "Stop" })
  expect(claude.code).toBe(0)
  expect(claude.stdout).toBe("")
  await expect(access(join(options.directory, "run"))).rejects.toThrow()
  await expect(access(join(options.root, ".slopmemr-id"))).rejects.toThrow()
  const useful = await run(options.env, args, {
    ...base,
    hook_event_name: "Stop",
    last_assistant_message: "Useful answer"
  })
  expect(useful.code).toBe(0)
  expect((await run(options.env, ["zoom", "--root", options.root, "--first", "0", "--count", "1"])).stdout).toContain(
    "Useful answer"
  )
})
