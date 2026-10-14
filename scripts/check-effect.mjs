import { spawnSync } from "node:child_process"
const result = spawnSync(
  "pnpm",
  ["exec", "effect-tsgo", "diagnostics", "--project", "tsconfig.json", "--strict", "--format", "json"],
  { encoding: "utf8", timeout: 60000 }
)
if (result.error) throw result.error
const report = JSON.parse(result.stdout)
const { summary } = report
if (
  !summary ||
  summary.filesChecked <= 0 ||
  summary.filesWithoutPlugin !== 0 ||
  summary.filesChecked !== summary.totalFiles
)
  throw new Error("Effect diagnostics did not check every source file")
for (const diagnostic of report.diagnostics)
  if (["error", "warning"].includes(diagnostic.severity))
    process.stderr.write(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.name}: ${diagnostic.message}\n`)
process.stdout.write(
  `Effect diagnostics checked ${summary.filesChecked}/${summary.totalFiles} files; ${summary.errors} errors, ${summary.warnings} warnings.\n`
)
if (result.status !== 0 || summary.errors !== 0 || summary.warnings !== 0) process.exitCode = 1
