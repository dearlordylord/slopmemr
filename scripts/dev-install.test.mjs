import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, readFile, access } from "node:fs/promises"
import { join, resolve } from "node:path"

const bootstrap = resolve("scripts/dev-install.mjs")
const fixture = async (t) => {
  const directory = await mkdtemp("/tmp/slopmemr-bootstrap ' ")
  const home = join(directory, "home"),
    profile = join(home, ".claude")
  await mkdir(home, { mode: 0o700 })
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(directory, "codex"),
    SLOPMEMR_DATA_DIR: join(directory, "data"),
    SLOPMEMR_RUNTIME_DIR: join(directory, "run")
  }
  t.after(async () => {
    const command = join(home, ".local", "bin", "slopmemr")
    spawnSync("/bin/sh", [command, "stop"], { env, stdio: "ignore", timeout: 10000 })
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, home, profile, env, command: join(home, ".local", "bin", "slopmemr") }
}
const setup = (f) =>
  spawnSync(process.execPath, [bootstrap, "--runtime", "claude", "--profile", f.profile], {
    env: f.env,
    encoding: "utf8",
    timeout: 30000
  })

test("development bootstrap installs a stable public command backed by the immutable snapshot", async (t) => {
  const f = await fixture(t)
  assert.equal(setup(f).status, 0)
  const before = await readFile(f.command, "utf8")
  assert.ok(!before.includes("/workspace/"))
  assert.equal(setup(f).status, 0)
  assert.equal(await readFile(f.command, "utf8"), before)
  const update = spawnSync(process.execPath, [bootstrap, "--update", "--runtime", "claude", "--profile", f.profile], {
    env: f.env,
    encoding: "utf8",
    timeout: 30000
  })
  assert.equal(update.status, 0, update.stderr)
  const help = spawnSync(f.command, ["help"], { env: f.env, encoding: "utf8", timeout: 10000 })
  assert.equal(help.status, 0, help.stderr)
  assert.ok(help.stdout.includes("slopmemr"))
  const doctor = spawnSync(f.command, ["doctor", "claude", "--profile", f.profile], {
    env: f.env,
    encoding: "utf8",
    timeout: 10000
  })
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).registration, "ready")
})

test("bootstrap refuses a dangling public symlink before modifying the selected native profile", async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.home, ".local", "bin"), { recursive: true, mode: 0o700 })
  const target = join(f.directory, "foreign-target")
  await symlink(target, f.command)
  assert.notEqual(setup(f).status, 0)
  await assert.rejects(access(target), { code: "ENOENT" })
  await assert.rejects(access(join(f.profile, "settings.json")), { code: "ENOENT" })
})
