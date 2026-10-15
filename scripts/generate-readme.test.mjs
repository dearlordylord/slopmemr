import { test } from "node:test"
import assert from "node:assert/strict"
import { renderTools, replaceSection } from "./generate-readme.mjs"

test("generated metadata replaces stale tools while preserving authored prose and other regions", () => {
  const original =
    "Introduction\n<!-- tools:start -->\nstale\n<!-- tools:end -->\n<!-- cli-reference:start -->\nmanual help\n<!-- cli-reference:end -->\nFooter\n"
  const tools = [
    {
      name: "read",
      description: "Read | memory\nnow",
      input: { properties: { root: {}, page: {} }, required: ["root"] }
    }
  ]
  const generated = renderTools(tools)
  assert.ok(generated.includes("Read \\| memory<br>now"))
  assert.ok(generated.includes("| `root` | `page` |"))
  const updated = replaceSection(original, "tools", generated)
  assert.notEqual(updated, original)
  assert.ok(updated.startsWith("Introduction\n"))
  assert.ok(updated.endsWith("Footer\n"))
  assert.ok(updated.includes("\nmanual help\n"))
  assert.ok(!updated.includes("stale"))
  assert.equal(replaceSection(updated, "tools", generated), updated)
  const changed = renderTools([{ ...tools[0], name: "new_read" }])
  assert.notEqual(replaceSection(updated, "tools", changed), updated)
})

test("missing, duplicated and reversed markers fail rather than changing unrelated documentation", () => {
  for (const text of [
    "prose",
    "<!-- tools:start -->",
    "<!-- tools:end --><!-- tools:start -->",
    "<!-- tools:start --><!-- tools:start --><!-- tools:end -->",
    "<!-- tools:start --><!-- tools:end --><!-- tools:end -->"
  ])
    assert.throws(() => replaceSection(text, "tools", "replacement"), /exactly one ordered tools marker pair/)
})

test("real check rejects drift without writing and update restores deterministic generated references", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, symlinkSync, rmSync } =
    await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join, resolve } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const directory = mkdtempSync(join(tmpdir(), "slopmemr-docs-"))
  try {
    mkdirSync(join(directory, "scripts"))
    copyFileSync(resolve("scripts/generate-readme.mjs"), join(directory, "scripts/generate-readme.mjs"))
    symlinkSync(resolve("dist"), join(directory, "dist"), "dir")
    const path = join(directory, "README.md")
    writeFileSync(
      path,
      "Authored intro\n<!-- tools:start --><!-- tools:end -->\n<!-- cli-reference:start --><!-- cli-reference:end -->\nAuthored footer\n"
    )
    const run = (mode) =>
      spawnSync(process.execPath, [join(directory, "scripts/generate-readme.mjs"), mode], { encoding: "utf8" })
    assert.equal(run("--update").status, 0)
    const generated = readFileSync(path, "utf8")
    assert.ok(generated.includes("slopmemr_snapshot"))
    assert.ok(generated.includes("Install hooks and MCP"))
    assert.equal(run("--check").status, 0)
    const stale = generated.replace("slopmemr_snapshot", "stale_tool")
    writeFileSync(path, stale)
    const check = run("--check")
    assert.equal(check.status, 1)
    assert.ok(check.stderr.includes("pnpm docs:generate"))
    assert.equal(readFileSync(path, "utf8"), stale)
    assert.equal(run("--update").status, 0)
    assert.equal(readFileSync(path, "utf8"), generated)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
