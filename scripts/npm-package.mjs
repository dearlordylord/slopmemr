import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const output = join(root, "dist", "npm")
const stage = join(output, "package")
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, "dist", "bin"), { recursive: true })
for (const name of ["slopmemr.mjs", "slopmemr-hook.mjs", "THIRD_PARTY_NOTICES.txt"])
  copyFileSync(join(root, "dist", "bin", name), join(stage, "dist", "bin", name))
chmodSync(join(stage, "dist", "bin", "slopmemr.mjs"), 0o755)
copyFileSync(join(root, "README.md"), join(stage, "README.md"))
mkdirSync(join(stage, "docs"), { recursive: true })
copyFileSync(join(root, "docs", "installation.md"), join(stage, "docs", "installation.md"))
// The development package stays private and retains its exact dependency cohort.
// This published surface is the self-contained CLI, not the unbundled library.
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  type: "module",
  license: "UNLICENSED",
  engines: source.engines,
  os: source.os,
  bin: source.bin,
  files: [
    "dist/bin/slopmemr.mjs",
    "dist/bin/slopmemr-hook.mjs",
    "dist/bin/THIRD_PARTY_NOTICES.txt",
    "docs/installation.md"
  ],
  repository: { type: "git", url: "git+https://github.com/dearlordylord/slopmemr.git" },
  homepage: "https://github.com/dearlordylord/slopmemr#readme",
  bugs: { url: "https://github.com/dearlordylord/slopmemr/issues" },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/" }
}
writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
    cwd: stage,
    encoding: "utf8"
  })
)
writeFileSync(join(output, "pack.json"), JSON.stringify(packed, null, 2) + "\n")
process.stdout.write(join(output, packed[0].filename) + "\n")
