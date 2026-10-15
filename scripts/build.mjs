import { build } from "esbuild"
import { readFileSync, writeFileSync } from "node:fs"
const buildRole = (entry, outfile, marker) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minifyWhitespace: marker === "SLOPMEMR_HOOK_BUILD",
    minifySyntax: marker === "SLOPMEMR_HOOK_BUILD",
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: `#!/usr/bin/env node\n// ${marker}\nimport { createRequire as slopmemrCreateRequire } from "node:module"; const require = slopmemrCreateRequire(import.meta.url);`
    },
    metafile: true,
    legalComments: "eof",
    sourcemap: false
  })

const result = await buildRole("src/cli/main.ts", "dist/bin/slopmemr.mjs", "SLOPMEMR_STANDALONE_BUILD")
const hook = await buildRole("src/intake/main.ts", "dist/bin/slopmemr-hook.mjs", "SLOPMEMR_HOOK_BUILD")
const forbiddenHookSources = [
  "src/resident/server.ts",
  "src/memory/manager.ts",
  "src/memory/storage.ts",
  "src/cli/program.ts"
]
for (const output of Object.values(hook.metafile.outputs)) {
  for (const [input, contribution] of Object.entries(output.inputs)) {
    if (contribution.bytesInOutput === 0) continue
    if (
      forbiddenHookSources.includes(input) ||
      input.startsWith("src/mcp/") ||
      input.startsWith("src/installation/") ||
      (input.startsWith("src/compaction/") && input !== "src/compaction/profile.ts") ||
      input.includes("@firfi/unii")
    )
      throw new Error(`Hook artifact contains forbidden implementation: ${input}`)
  }
  if (output.imports.some((entry) => entry.path === "node:sqlite")) throw new Error("Hook artifact imports SQLite")
}
writeFileSync("dist/bin/hook-build.json", JSON.stringify(hook.metafile, null, 2))

const external = [...Object.values(result.metafile.outputs), ...Object.values(hook.metafile.outputs)]
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !entry.path.startsWith("node:"))
if (external.length !== 0)
  throw new Error(
    "Standalone artifact has external package dependencies: " + external.map((entry) => entry.path).join(", ")
  )

const notices = [
  ["Effect", "node_modules/effect/LICENSE"],
  ["@effect/platform-node", "node_modules/@effect/platform-node/LICENSE"],
  ["smol-toml", "node_modules/smol-toml/LICENSE"],
  ["UNII", "../unii/LICENSE"]
]
  .map(([name, path]) => `${name}\n${readFileSync(path, "utf8")}`)
  .join("\n\n")
writeFileSync("dist/bin/THIRD_PARTY_NOTICES.txt", notices)
