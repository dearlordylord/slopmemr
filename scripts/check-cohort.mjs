import { readFileSync } from "node:fs"
const manifest = JSON.parse(readFileSync("package.json", "utf8"))
const packages = { ...manifest.dependencies, ...manifest.devDependencies }
const expected = {
  "@crap4ts/crap4ts": "1.1.0",
  effect: "4.0.3",
  "@effect/platform-node": "4.0.3",
  "@effect/vitest": "4.0.3",
  typescript: "7.0.2",
  oxlint: "1.87.0",
  "oxlint-tsgolint": "7.0.2003",
  "@effect/tsgo": "0.51.1",
  vitest: "5.0.4",
  "@vitest/coverage-v8": "5.0.4"
}
for (const [name, version] of Object.entries(expected)) {
  if (packages[name] !== version) throw new Error(`Incompatible cohort declaration ${name}`)
  const installed = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"))
  if (installed.version !== version) throw new Error(`Incompatible installed cohort ${name}`)
}
for (const name of Object.keys(packages))
  if (["@effect/platform", "@effect/schema", "@typescript/native-preview"].includes(name))
    throw new Error(`Unexpected compatibility package ${name}`)
process.stdout.write("Pinned Effect 4 / TypeScript 7 / typed Oxlint / Vitest cohort verified.\n")
