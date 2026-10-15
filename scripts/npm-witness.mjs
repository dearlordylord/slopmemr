import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packed = JSON.parse(readFileSync(resolve("dist/npm/pack.json"), "utf8"))[0]
assert.deepEqual(packed.files.map((file) => file.path).sort(), [
  "README.md",
  "dist/bin/THIRD_PARTY_NOTICES.txt",
  "dist/bin/slopmemr-hook.mjs",
  "dist/bin/slopmemr.mjs",
  "docs/installation.md",
  "package.json"
])
const manifest = JSON.parse(readFileSync(resolve("dist/npm/package/package.json"), "utf8"))
for (const key of ["dependencies", "optionalDependencies", "devDependencies", "scripts", "exports", "private"])
  assert.equal(manifest[key], undefined, key)
const directory = mkdtempSync(join(tmpdir(), "slopmemr-npm ' "))
const prefix = join(directory, "npm-prefix")
const env = {
  ...process.env,
  HOME: directory,
  npm_config_cache: join(directory, "cache"),
  npm_config_userconfig: join(directory, "npmrc"),
  SLOPMEMR_DATA_DIR: join(directory, "data"),
  SLOPMEMR_RUNTIME_DIR: join(directory, "run"),
  SLOPMEMR_BIN_DIR: join(directory, "commands"),
  CODEX_HOME: join(directory, "codex"),
  CLAUDE_CONFIG_DIR: join(directory, "claude")
}
const publicCommand = join(env.SLOPMEMR_BIN_DIR, "slopmemr")
const execute = (executable, args, input) => {
  const result = spawnSync(executable, args, { env, cwd: directory, input, encoding: "utf8", timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
const cli = (args) => execute(publicCommand, args)
const profiles = [
  { runtime: "codex", profile: env.CODEX_HOME, settings: "hooks.json" },
  { runtime: "claude", profile: env.CLAUDE_CONFIG_DIR, settings: "settings.json" }
]
try {
  writeFileSync(env.npm_config_userconfig, "")
  execute("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve("dist/npm", packed.filename)
  ])
  const npmCommand = join(prefix, "bin", "slopmemr")
  assert.ok(execute(npmCommand, ["--help"]).includes("project memory"))
  const installed = join(prefix, "lib/node_modules/@firfi/slopmemr")
  assert.ok(!existsSync(join(installed, "node_modules")))
  for (const { runtime, profile } of profiles) {
    execute(npmCommand, ["install", runtime, "--profile", profile])
    execute(npmCommand, ["update", runtime, "--profile", profile])
    const doctor = JSON.parse(cli(["doctor", runtime, "--profile", profile]))
    assert.equal(doctor.registration, "ready")
    assert.equal(doctor.mcp, "ready")
  }
  // Native registration must survive both npm uninstall and deletion of the source package.
  execute("npm", [
    "uninstall",
    "--global",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    manifest.name
  ])
  rmSync(prefix, { recursive: true, force: true })
  for (const { runtime, profile, settings } of profiles) {
    cli(["stop"])
    const root = join(directory, runtime + " project")
    mkdirSync(root)
    const hooks = JSON.parse(readFileSync(join(profile, settings), "utf8")).hooks
    const deliver = (event, extra) =>
      execute(
        "/bin/sh",
        ["-c", hooks[event][0].hooks[0].command],
        JSON.stringify({ hook_event_name: event, cwd: root, session_id: "npm-session", ...extra })
      )
    assert.ok(deliver("SessionStart", {}).includes("slopmemr_snapshot"))
    assert.equal(
      deliver("UserPromptSubmit", {
        event_id: "prompt",
        prompt: "npm-installed memory survives removal of its source package."
      }),
      ""
    )
    assert.ok(cli(["snapshot", "--root", root]).includes("survives removal"))
    const before = JSON.parse(cli(["status", "--root", root])).count
    assert.equal(
      deliver("PostToolUse", { tool_name: "mcp__slopmemr__slopmemr_snapshot", tool_response: "old memory" }),
      ""
    )
    assert.equal(JSON.parse(cli(["status", "--root", root])).count, before)
    cli(["repair", runtime, "--profile", profile])
    cli(["uninstall", runtime, "--profile", profile])
    assert.ok(cli(["snapshot", "--root", root]).includes("survives removal"))
  }
  const evidence = {
    package: manifest.name,
    version: manifest.version,
    platform: process.platform,
    arch: process.arch,
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    integrity: packed.integrity,
    exactFileAllowlist: true,
    runtimeDependencies: 0,
    installScripts: false,
    offlineGlobalNpmInstallation: true,
    runtimes: profiles.map((p) => p.runtime),
    registrationAndMcp: true,
    update: true,
    repair: true,
    automaticStartup: true,
    dedicatedHooksSurviveNpmRemoval: true,
    selfReadFiltering: true,
    uninstallPreservesMemory: true,
    providerInference: false
  }
  writeFileSync(resolve("docs/validation/npm-package.json"), JSON.stringify(evidence, null, 2) + "\n")
  process.stdout.write(JSON.stringify(evidence) + "\n")
} finally {
  if (existsSync(publicCommand)) spawnSync(publicCommand, ["stop"], { env, timeout: 10000, stdio: "ignore" })
  rmSync(directory, { recursive: true, force: true })
}
