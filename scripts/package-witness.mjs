import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  cpSync,
  appendFileSync,
  writeFileSync,
  chmodSync,
  existsSync
} from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir, release, cpus, loadavg } from "node:os"
import { performance } from "node:perf_hooks"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
const directory = mkdtempSync(join(tmpdir(), "slopmemr-package-"))
const profile = join(directory, "profile"),
  root = join(directory, "project")
mkdirSync(profile, { mode: 0o700 })
mkdirSync(root)
const env = {
  ...process.env,
  HOME: directory,
  CLAUDE_CONFIG_DIR: profile,
  SLOPMEMR_BIN_DIR: join(directory, "commands"),
  SLOPMEMR_DATA_DIR: join(directory, "data"),
  SLOPMEMR_RUNTIME_DIR: join(directory, "run"),
  SLOPMEMR_CLAUDE_BIN: resolve("src/compaction/fixtures/claude.mjs")
}
const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"))
const source = resolve(`dist/releases/slopmemr-${version}-${process.platform}-${process.arch}`)
const target = join(directory, "package")
cpSync(source, target, { recursive: true })
const publicCommand = join(directory, "commands/slopmemr")
const execute = (executable, args, input) => {
  const child = spawnSync(executable, args, { cwd: directory, env, input, encoding: "utf8", timeout: 60000 })
  assert.equal(child.status, 0, child.stderr)
  return child.stdout
}
const cli = (args) => execute(publicCommand, args)
writeFileSync(join(profile, "fixture-mode"), "normal")
chmodSync(env.SLOPMEMR_CLAUDE_BIN, 0o755)
const evidence = {
  platform: process.platform,
  arch: process.arch,
  environment: {
    node: process.version,
    osRelease: release(),
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    loadAtStart: loadavg()
  },
  artifactDigests: JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")),
  conditions:
    "Real installed UserPromptSubmit hook; durable acknowledgement; repeated identical 4KiB prompt with replay identity; fresh resident, filesystem cache uncontrolled; synthetic Claude backend, no paid inference",
  hook: { cold: [], warm: [], unavailable: [] },
  complete: false
}
try {
  execute(join(target, "bin/slopmemr"), ["install", "claude", "--profile", profile])
  const owned = JSON.parse(readFileSync(join(profile, ".slopmemr/claude/ownership.json"), "utf8"))
  assert.equal(owned.snapshot.launch.executable, join(owned.snapshot.directory, "node"))
  const hooks = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"))
  const hook = hooks.hooks.UserPromptSubmit[0].hooks[0].command
  const guide = spawnSync("/bin/sh", ["-c", hooks.hooks.SessionStart[0].hooks[0].command], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 10000,
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: root, session_id: "guide" })
  })
  assert.equal(guide.status, 0, guide.stderr)
  assert.ok(guide.stdout.includes("slopmemr_snapshot") && guide.stdout.includes("slopmemr snapshot --root"))
  assert.equal(existsSync(join(root, ".slopmemr-id")), false)
  assert.equal(existsSync(env.SLOPMEMR_RUNTIME_DIR), false)
  evidence.instructionOnlySessionStart = true
  assert.ok(!readFileSync(join(profile, ".slopmemr/claude/hook-launcher.sh"), "utf8").includes("slopmemr.mjs' hook"))
  const payload = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    session_id: "latency",
    event_id: "latency-replay",
    prompt: "x".repeat(4096)
  })
  const measure = (stage) => {
    const started = performance.now()
    const child = spawnSync("/bin/sh", ["-c", hook], {
      cwd: directory,
      env,
      input: payload,
      encoding: "utf8",
      timeout: 10000
    })
    const sample = {
      elapsedMs: performance.now() - started,
      exit: child.status,
      signal: child.signal,
      acknowledged: child.status === 0 && child.stdout === ""
    }
    evidence.hook[stage].push(sample)
    return sample
  }
  for (let sample = 0; sample < 10; sample++) {
    if (sample > 0) cli(["stop"])
    assert.ok(measure("cold").acknowledged)
  }
  for (let sample = 0; sample < 30; sample++) assert.ok(measure("warm").acknowledged)
  const percentile = (samples) =>
    samples.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
  evidence.hook.coldP95Ms = percentile(evidence.hook.cold)
  evidence.hook.warmP95Ms = percentile(evidence.hook.warm)
  const status = JSON.parse(cli(["status", "--root", root]))
  assert.equal(status.count, 1)
  evidence.durableReplayRecordCount = status.count
  cli(["settle", "--root", root])
  const launcher = owned.mcp.launcher
  const frames =
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "witness", version: "1" } }
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slopmemr_snapshot", arguments: { root } } }
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n") + "\n"
  const replies = execute("/bin/sh", [launcher], frames).trim().split("\n").map(JSON.parse)
  assert.equal(replies.find(({ id }) => id === 2).result.tools.length, 4)
  const memory = replies.find(({ id }) => id === 3).result.structuredContent.result
  assert.deepEqual(memory, JSON.parse(cli(["snapshot", "--root", root])))
  const previous = JSON.parse(cli(["start"])).value
  appendFileSync(join(target, "bin/slopmemr.mjs"), "\n// package update witness\n")
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"))
  manifest.cli.digest = createHash("sha256")
    .update(readFileSync(join(target, "bin/slopmemr.mjs")))
    .digest("hex")
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest))
  const updated = JSON.parse(cli(["update", "claude", "--profile", profile, "--target", target]))
  assert.equal(updated.restarted, true)
  const current = JSON.parse(cli(["start"])).value
  assert.notEqual(current.pid, previous.pid)
  assert.equal(current.implementation, manifest.cli.digest)
  rmSync(target, { recursive: true })
  assert.equal(JSON.parse(cli(["doctor", "claude", "--profile", profile])).runtimeAvailable, true)
  assert.equal(JSON.parse(cli(["snapshot", "--root", root])).text, memory.text)
  Object.assign(evidence, {
    mcpCliParity: true,
    eofResidentSurvival: true,
    liveUpdate: true,
    sourcePackageRemoval: true,
    memoryPreserved: true
  })
  cli(["stop"])
  const selectedPath = join(env.SLOPMEMR_DATA_DIR, "runtime/selected.json")
  const selectionText = readFileSync(selectedPath, "utf8")
  try {
    const selection = JSON.parse(selectionText)
    selection.launch.executable = join(directory, "unavailable-node")
    writeFileSync(selectedPath, JSON.stringify(selection))
    for (let sample = 0; sample < 3; sample++) {
      const result = measure("unavailable")
      assert.notEqual(result.exit, 0)
      assert.equal(result.acknowledged, false)
    }
  } finally {
    writeFileSync(selectedPath, selectionText)
  }
  cli(["uninstall", "claude", "--profile", profile])
  assert.equal(JSON.parse(cli(["snapshot", "--root", root])).text, memory.text)
  assert.ok(evidence.hook.coldP95Ms <= 2000, `Cold hook p95 ${evidence.hook.coldP95Ms}ms`)
  assert.ok(evidence.hook.warmP95Ms <= 150, `Warm hook p95 ${evidence.hook.warmP95Ms}ms`)
  assert.ok(
    evidence.hook.unavailable.every(({ elapsedMs }) => elapsedMs <= 3000),
    "Unavailable resident exceeded 3s deadline"
  )
  evidence.complete = true
  process.stdout.write(
    JSON.stringify({
      coldP95Ms: evidence.hook.coldP95Ms,
      warmP95Ms: evidence.hook.warmP95Ms,
      unavailableMs: evidence.hook.unavailable.map(({ elapsedMs }) => elapsedMs),
      complete: evidence.complete
    }) + "\n"
  )
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : "Package witness failed"
  throw error
} finally {
  const evidencePath = resolve("docs/validation/package-memory-reading.json")
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n")
  appendFileSync(resolve("docs/validation/package-memory-reading-runs.jsonl"), JSON.stringify(evidence) + "\n")
  spawnSync(publicCommand, ["stop"], { env, timeout: 10000, stdio: "ignore" })
  rmSync(directory, { recursive: true, force: true })
}
