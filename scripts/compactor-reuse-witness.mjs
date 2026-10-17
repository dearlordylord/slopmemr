// Installed artifact witness with a controlled offline Codex protocol; no model or login access.
import { watch } from "node:fs"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import assert from "node:assert/strict"

const directory = mkdtempSync(join(tmpdir(), "slopmemr-worker-reuse-"))
const profile = join(directory, "profile")
const root = join(directory, "project")
mkdirSync(profile, { mode: 0o700 })
mkdirSync(root)
writeFileSync(join(profile, "fixture.json"), JSON.stringify({ mode: "hold" }))
writeFileSync(join(profile, "events.jsonl"), "")
const fixture = resolve("src/compaction/fixtures/app-server.mjs")
chmodSync(fixture, 0o755)
const env = {
  ...process.env,
  HOME: directory,
  CODEX_HOME: profile,
  SLOPMEMR_RUNTIME_DIR: join(directory, "run"),
  SLOPMEMR_DATA_DIR: join(directory, "data"),
  SLOPMEMR_BIN_DIR: join(directory, "bin"),
  SLOPMEMR_CODEX_BIN: fixture,
  SLOPMEMR_COMPACTION_CONCURRENCY: "30",
  SLOPMEMR_AUTH_CONCURRENCY: "5"
}
let entrypoint = resolve("dist/bin/slopmemr.mjs")
const cli = (args, input) => {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: directory,
    env,
    input,
    encoding: "utf8",
    timeout: 30000
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
const events = () =>
  readFileSync(join(profile, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
try {
  cli(["setup", "codex", "--profile", profile])
  const owned = JSON.parse(readFileSync(join(profile, ".slopmemr/codex/ownership.json"), "utf8"))
  entrypoint = owned.snapshot.launch.entrypoint
  assert.equal(existsSync(join(owned.snapshot.directory, "node_modules")), false)
  const command = JSON.parse(readFileSync(join(profile, "hooks.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0]
    .command
  const deliver = (index) => {
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 10000,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: root,
        session_id: "offline-reuse",
        event_id: String(index),
        prompt: "Synthetic memory decision. ".repeat(100)
      })
    })
    assert.equal(result.status, 0, result.stderr)
  }
  for (let index = 0; index < 12; index++) deliver(index)
  for (let probe = 0; probe < 20 && events().filter((event) => event.event === "held").length < 5; probe++)
    cli(["status", "--root", root])
  const held = events()
  assert.equal(held.filter((event) => event.event === "held").length, 5)
  assert.equal(held.filter((event) => event.event === "started").length, 5)
  assert.equal(JSON.parse(cli(["status", "--root", root])).count, 12)
  writeFileSync(join(profile, "release"), "complete")
  cli(["settle", "--root", root])
  for (let index = 12; index < 16; index++) deliver(index)
  cli(["settle", "--root", root])
  const snapshot = JSON.parse(cli(["snapshot", "--root", root]))
  assert.equal(snapshot.totalRecords, 16)
  assert.equal(snapshot.coveredThrough, 16)
  assert.deepEqual(snapshot.processing.failed, [])
  const log = events()
  assert.equal(log.filter((event) => event.event === "started").length, 5)
  const turns = log.filter((event) => event.event === "turn")
  assert.ok(turns.length >= 16)
  assert.equal(log.filter((event) => event.event === "unsubscribed").length, turns.length)
  const shutdown = new Promise((resolveShutdown, reject) => {
    const complete = () => {
      if (events().filter((event) => event.event === "stopped").length !== 5) return
      clearTimeout(deadline)
      watcher.close()
      resolveShutdown()
    }
    const watcher = watch(profile, complete)
    const deadline = setTimeout(() => {
      watcher.close()
      reject(new Error("Workers did not terminate after shutdown"))
    }, 10000)
    complete()
  })
  cli(["stop"])
  await shutdown
  assert.equal(events().filter((event) => event.event === "stopped").length, 5)
  const evidence = {
    validation: "installed-codex-worker-reuse",
    provider: "offline protocol fixture",
    providerInference: false,
    implementation: owned.snapshot.digest,
    limits: { shared: 30, perProfile: 5 },
    durableRecords: snapshot.totalRecords,
    coveredThrough: snapshot.coveredThrough,
    hooksAcknowledgeWhileFiveSummariesHeld: true,
    workerStarts: 5,
    completedTurns: turns.length,
    workersReused: true,
    ephemeralThreadsReleased: true,
    workersClosedOnShutdown: true,
    complete: true
  }
  writeFileSync(resolve("docs/validation/compactor-worker-reuse.json"), JSON.stringify(evidence, null, 2) + "\n")
  process.stdout.write(JSON.stringify(evidence) + "\n")
} finally {
  spawnSync(process.execPath, [entrypoint, "stop"], { env, timeout: 10000, stdio: "ignore" })
  rmSync(directory, { recursive: true, force: true })
}
