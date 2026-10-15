// Explicit live witness: synthetic project only, existing ChatGPT login, no API keys.
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir, homedir } from "node:os"
import { performance } from "node:perf_hooks"
import { strict as assert } from "node:assert"
const source = resolve("dist/bin/slopmemr.mjs")
const directory = await mkdtemp(join(tmpdir(), "slopmemr-native-"))
const profile = join(directory, "codex")
const root = join(directory, "project")
const loginHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")
await access(join(loginHome, "auth.json"))
await mkdir(profile, { mode: 0o700 })
await mkdir(root)
// Let Codex read its own existing login; the witness never decodes or copies tokens.
await symlink(join(loginHome, "auth.json"), join(profile, "auth.json"))
const env = {
  ...process.env,
  CODEX_HOME: profile,
  SLOPMEMR_RUNTIME_DIR: join(directory, "run"),
  SLOPMEMR_DATA_DIR: join(directory, "data"),
  SLOPMEMR_BIN_DIR: join(directory, "bin"),
  OPENAI_API_KEY: undefined,
  CODEX_API_KEY: undefined,
  CODEX_ACCESS_TOKEN: undefined,
  OPENAI_BASE_URL: undefined
}
const run = (executable, args, timeoutMs = 30000) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let stdout = "",
      stderr = ""
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {}
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGKILL")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (stderr.length > 4 * 1024 * 1024) child.kill("SIGKILL")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveResult({ code, stdout, stderr })
    })
  })
const cli = async (args) => {
  const result = await run(process.execPath, [source, ...args])
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}
try {
  const init = await run("git", ["init", "--quiet"])
  assert.equal(init.code, 0)
  await writeFile(
    join(root, "README.md"),
    "# Synthetic memory test\n" +
      "The shared project memory belongs to the primary Git working copy. Independent clones have separate memories. Observation intake never returns advice to the coding agent.\n".repeat(
        24
      )
  )
  await cli(["setup", "codex", "--profile", profile])
  const started = performance.now()
  const native = await run(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--dangerously-bypass-hook-trust",
      "--enable",
      "hooks",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "multi_agent",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-6-luna",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'model_provider="openai"',
      "-C",
      root,
      "Run one shell command to read README.md, then answer only NATIVE_MEMORY_WITNESS_OK. Do not inspect any other file, environment variable, configuration or credential. Do not edit files."
    ],
    180000
  )
  assert.equal(native.code, 0, native.stderr.slice(-2000))
  assert.ok(native.stdout.includes("NATIVE_MEMORY_WITNESS_OK"))
  assert.ok(!native.stdout.includes("bwrap: No permissions"), "Synthetic tool observation must succeed")
  const status = await cli(["status", "--root", root])
  assert.ok(status.count >= 3, "Native hooks should capture prompt, tool observation and stop")
  const snapshot = await cli(["settle", "--root", root, "--wait-ms", "20000"])
  assert.equal(snapshot.state, "ready", JSON.stringify(snapshot))
  const first = await cli(["zoom", "--root", root, "--first", "0", "--count", "1"])
  assert.ok(first.text.length > 0)
  const record = {
    witness: "real-native-codex-installed-hooks",
    codexVersion: (await run("codex", ["--version"])).stdout.trim(),
    authentication: "existing-chatgpt-login",
    model: "gpt-6-luna",
    apiKeys: false,
    syntheticProjectOnly: true,
    nativeAgentSucceeded: true,
    automaticResidentStartup: true,
    recordCount: status.count,
    snapshotStatus: snapshot.state,
    durationMs: Math.round(performance.now() - started)
  }
  await writeFile(resolve("docs/validation/native-agent.json"), JSON.stringify(record, null, 2) + "\n")
  process.stdout.write(JSON.stringify(record) + "\n")
} finally {
  await run(process.execPath, [source, "stop"]).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
