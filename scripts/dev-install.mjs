import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { Doctor, Snapshot, InstallationError } from "../dist/installation/contracts.js"

const rawArguments = process.argv.slice(2).filter((value) => value !== "--")
const command = rawArguments.includes("--update") ? "update" : "setup"
const argumentsList = rawArguments.filter((value) => value !== "--update")
const source = resolve("dist/bin/slopmemr.mjs")
const prepare = Effect.try({
  try: () => {
    const result = spawnSync(process.execPath, [source, command, ...argumentsList], {
      stdio: "inherit",
      timeout: 30000
    })
    if (result.status !== 0)
      throw new InstallationError({ operation: "dev-install", message: "Native profile installation failed" })
    const runtime = spawnSync(process.execPath, [source, "doctor", ...argumentsList], {
      encoding: "utf8",
      timeout: 10000
    })
    if (runtime.status !== 0)
      throw new InstallationError({ operation: "dev-install", message: "Cannot inspect installed profile" })
    const report = Schema.decodeUnknownSync(Doctor)(JSON.parse(runtime.stdout))
    if (report.registration !== "ready" || !report.runtimeAvailable)
      throw new InstallationError({ operation: "dev-install", message: "Installed profile did not pass doctor" })
    const ownership = JSON.parse(
      readFileSync(join(report.profile, ".slopmemr", report.runtime, "ownership.json"), "utf8")
    )
    return Schema.decodeUnknownSync(Snapshot)(ownership.snapshot)
  },
  catch: () =>
    new InstallationError({
      operation: "dev-install",
      message: "Development installation failed; inspect the preceding diagnostic"
    })
})
try {
  await Effect.runPromise(prepare)
  const result = { path: join(homedir(), ".local", "bin", "slopmemr") }
  process.stdout.write(`Installed ${result.path}. Native hooks start memory automatically.\n`)
} catch {
  process.stderr.write("Cannot install slopmemr safely: inspect the selected profile and public command ownership.\n")
  process.exitCode = 1
}
