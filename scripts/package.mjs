import { copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const name = `slopmemr-${version}-${process.platform}-${process.arch}`
const output = join(root, "dist", "releases")
const target = join(output, name)
const nodeLicense = [
  join(dirname(process.execPath), "NODE_LICENSE"),
  join(dirname(process.execPath), "..", "LICENSE")
].find(existsSync)
if (nodeLicense === undefined) throw new Error("Cannot locate the bundled Node license")
mkdirSync(join(target, "bin"), { recursive: true })
mkdirSync(join(target, "runtime"), { recursive: true })
const roles = {
  cli: [join(root, "dist/bin/slopmemr.mjs"), "bin/slopmemr.mjs"],
  hook: [join(root, "dist/bin/slopmemr-hook.mjs"), "bin/slopmemr-hook.mjs"],
  runtime: [process.execPath, "runtime/node"],
  notices: [join(root, "dist/bin/THIRD_PARTY_NOTICES.txt"), "bin/THIRD_PARTY_NOTICES.txt"],
  runtimeNotices: [nodeLicense, "NODE_LICENSE"]
}
const manifest = { application: "slopmemr", format: 1, version, platform: process.platform, arch: process.arch }
for (const [role, [source, destination]] of Object.entries(roles)) {
  copyFileSync(source, join(target, destination))
  manifest[role] = { digest: createHash("sha256").update(readFileSync(source)).digest("hex") }
}
chmodSync(join(target, "runtime/node"), 0o700)
writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
writeFileSync(
  join(target, "bin/slopmemr"),
  '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/runtime/node" "$base/bin/slopmemr.mjs" "$@"\n',
  { mode: 0o700 }
)
execFileSync("tar", ["-czf", join(output, name + ".tar.gz"), "-C", output, name])
const archive = join(output, name + ".tar.gz")
writeFileSync(
  archive + ".sha256",
  createHash("sha256").update(readFileSync(archive)).digest("hex") + "  " + name + ".tar.gz\n"
)
process.stdout.write(archive + "\n")
