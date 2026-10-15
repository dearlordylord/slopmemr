import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { inspectPackage, packageFiles } from "./package.js"
import { contentDigest } from "./binding.js"

test("accepts a matching complete package and rejects changed, linked and foreign artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "slopmemr-package-contract-"))
  const roles = {
    cli: "bin/slopmemr.mjs",
    hook: "bin/slopmemr-hook.mjs",
    runtime: "runtime/node",
    notices: "bin/THIRD_PARTY_NOTICES.txt",
    runtimeNotices: "NODE_LICENSE"
  }
  try {
    mkdirSync(join(root, "bin"))
    mkdirSync(join(root, "runtime"))
    const artifacts = Object.fromEntries(
      Object.entries(roles).map(([role, file]) => {
        writeFileSync(join(root, file), role)
        return [role, { digest: contentDigest(role) }]
      })
    )
    const manifest = {
      application: "slopmemr",
      format: 1,
      version: "test",
      platform: process.platform,
      arch: process.arch,
      ...artifacts
    }
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest))
    expect(inspectPackage(root, packageFiles).launch.entrypoint).toBe(join(root, roles.cli))
    expect(() => inspectPackage(root, { ...packageFiles, arch: "unsupported" })).toThrow("platform")
    writeFileSync(join(root, roles.hook), "modified")
    expect(() => inspectPackage(root, packageFiles)).toThrow("checksum")
    rmSync(join(root, roles.hook))
    symlinkSync(join(root, roles.cli), join(root, roles.hook))
    expect(() => inspectPackage(root, packageFiles)).toThrow("invalid artifact")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
