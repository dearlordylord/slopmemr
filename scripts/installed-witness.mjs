import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, renameSync, existsSync, writeFileSync, chmodSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { strict as assert } from "node:assert"
const directory = mkdtempSync(join(tmpdir(), "slopmemr-installed ' "))
const profile = join(directory, "profile")
mkdirSync(profile, { mode: 0o700 })
let root = join(directory, "project")
mkdirSync(root)
const env = {
  ...process.env,
  SLOPMEMR_RUNTIME_DIR: join(directory, "run"),
  SLOPMEMR_DATA_DIR: join(directory, "data"),
  CODEX_HOME: profile
}
const run = (entrypoint, args, input) => {
  const child = spawnSync(process.execPath, [entrypoint, ...args], { env, input, encoding: "utf8", timeout: 20000 })
  assert.equal(child.status, 0, child.stderr)
  return child.stdout
}
let entrypoint
try {
  const source = resolve("dist/bin/slopmemr.mjs")
  run(source, ["setup", "codex", "--profile", profile])
  const ownership = JSON.parse(readFileSync(join(profile, ".slopmemr", "codex", "ownership.json"), "utf8"))
  entrypoint = ownership.snapshot.launch.entrypoint
  // Execute outside the checkout, with no node_modules adjacent to the installed snapshot.
  assert.ok(!existsSync(join(ownership.snapshot.directory, "node_modules")))
  const hooks = JSON.parse(readFileSync(join(profile, "hooks.json"), "utf8"))
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command
  const hook = spawnSync("/bin/sh", ["-c", command], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 20000,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      session_id: "installed-session",
      event_id: "event-1",
      prompt: "Installed hook remembered this fact."
    })
  })
  assert.equal(hook.status, 0, hook.stderr)
  assert.equal(hook.stdout, "")
  assert.ok(run(entrypoint, ["snapshot", "--root", root]).includes("Installed hook remembered this fact."))
  const moved = join(directory, "project moved")
  renameSync(root, moved)
  root = moved
  const git = spawnSync("git", ["init", root], { encoding: "utf8", timeout: 5000 })
  assert.equal(git.status, 0, git.stderr)
  assert.ok(run(entrypoint, ["snapshot", "--root", root]).includes("Installed hook remembered this fact."))
  const ping = JSON.parse(run(entrypoint, ["start"]))
  process.kill(ping.value.pid, "SIGKILL")
  assert.ok(run(entrypoint, ["snapshot", "--root", root]).includes("Installed hook remembered this fact."))
  const original = readFileSync(join(profile, "hooks.json"), "utf8")
  run(entrypoint, ["update", "codex", "--profile", profile])
  assert.equal(readFileSync(join(profile, "hooks.json"), "utf8"), original)
  assert.equal(JSON.parse(run(entrypoint, ["doctor", "codex", "--profile", profile])).registration, "ready")
  run(entrypoint, ["uninstall", "codex", "--profile", profile])
  assert.deepEqual(JSON.parse(readFileSync(join(profile, "hooks.json"), "utf8")), {})
  assert.ok(run(entrypoint, ["snapshot", "--root", root]).includes("Installed hook remembered this fact."))
  run(entrypoint, ["stop"])
  const claudeRoot = join(directory, "claude project")
  mkdirSync(claudeRoot)
  const claudeExecutable = resolve("src/compaction/fixtures/claude.mjs")
  chmodSync(claudeExecutable, 0o755)
  writeFileSync(join(profile, "fixture-mode"), "normal")
  env.SLOPMEMR_CLAUDE_BIN = claudeExecutable
  env.SLOPMEMR_CODEX_BIN = join(directory, "codex-must-not-be-started")
  env.CODEX_HOME = join(directory, "absent-codex-profile")
  run(entrypoint, ["setup", "claude", "--profile", profile])
  const claudeOwnership = JSON.parse(readFileSync(join(profile, ".slopmemr", "claude", "ownership.json"), "utf8"))
  assert.equal(claudeOwnership.selection.claudeHome, profile)
  assert.equal(claudeOwnership.selection.codexHome, undefined)
  const claudeCommand = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")).hooks.UserPromptSubmit[0]
    .hooks[0].command
  const claudeHook = spawnSync("/bin/sh", ["-c", claudeCommand], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 20000,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: claudeRoot,
      session_id: "claude-session",
      event_id: "claude-event",
      prompt: "Retain the Claude fact. ".repeat(100)
    })
  })
  assert.equal(claudeHook.status, 0, claudeHook.stderr)
  assert.equal(claudeHook.stdout, "")
  assert.equal(JSON.parse(run(entrypoint, ["settle", "--root", claudeRoot])).state, "ready")
  assert.ok(run(entrypoint, ["snapshot", "--root", claudeRoot]).includes("Remember the Claude fact."))
  assert.ok(readFileSync(join(profile, "events"), "utf8").includes('"turn"'))
  run(entrypoint, ["uninstall", "claude", "--profile", profile])
  process.stdout.write(
    "Installed immutable bundle: Codex hooks, Claude hooks/Haiku without Codex, automatic startup, relocation, git init, crash recovery, update and uninstall passed.\n"
  )
} finally {
  if (entrypoint) spawnSync(process.execPath, [entrypoint, "stop"], { env, timeout: 10000, stdio: "ignore" })
  rmSync(directory, { recursive: true, force: true })
}
