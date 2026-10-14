import { build } from "esbuild"
import { readFileSync, writeFileSync } from "node:fs"
const result = await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/bin/slopmemr.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: '#!/usr/bin/env node\n// SLOPMEMR_STANDALONE_BUILD\nimport { createRequire as slopmemrCreateRequire } from "node:module"; const require = slopmemrCreateRequire(import.meta.url);'
  },
  metafile: true,
  legalComments: "eof",
  sourcemap: false
})

const external = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !entry.path.startsWith("node:"))
if (external.length !== 0)
  throw new Error(
    "Standalone artifact has external package dependencies: " + external.map((entry) => entry.path).join(", ")
  )

const notices = [
  ["Effect", "node_modules/effect/LICENSE"],
  ["@effect/platform-node", "node_modules/@effect/platform-node/LICENSE"],
  ["UNII", "../unii/LICENSE"]
]
  .map(([name, path]) => `${name}\n${readFileSync(path, "utf8")}`)
  .join("\n\n")
writeFileSync("dist/bin/THIRD_PARTY_NOTICES.txt", notices)
