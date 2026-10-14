import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { Ownership, InstallationError, type Doctor, type Selection } from "./contracts.js"
import { contentDigest, installationPaths, makeOwnership } from "./binding.js"
import { readOptional } from "./files.js"
import { configurationText, parseConfiguration, reconcile } from "./reconciliation.js"

/** Read-only: no directory creation, lock acquisition, resident launch or auth probe. */
export const doctor = Effect.fn("Installation.doctor")(function* (selection: Selection) {
  const inspected = yield* Effect.sync((): { report: Doctor; executable?: string } => {
    const paths = installationPaths(selection)
    const base = {
      runtime: selection.runtime,
      profile: selection.profile,
      nativeTrust: "host-owned-unchecked",
      authentication: "not-probed",
      residentActivation: "next-automatic-start"
    } satisfies Pick<Doctor, "runtime" | "profile" | "nativeTrust" | "authentication" | "residentActivation">
    try {
      if (readOptional(paths.operation) !== undefined)
        return {
          report: {
            ...base,
            registration: "recovery-required",
            runtimeAvailable: false,
            problems: ["Interrupted installation; repeat the same setup/update/uninstall operation"]
          }
        }
      const text = readOptional(paths.ownership)
      if (text === undefined)
        return { report: { ...base, registration: "missing", runtimeAvailable: false, problems: [] } }
      const ownership = inspectOwnership(selection, text)
      const runtime = readOptional(ownership.snapshot.launch.entrypoint)
      const runtimeAvailable = runtime !== undefined && contentDigest(runtime) === ownership.snapshot.digest
      return {
        executable: ownership.snapshot.launch.executable,
        report: {
          ...base,
          registration: "ready",
          runtimeAvailable,
          problems: runtimeAvailable ? [] : ["Installed runtime is missing or modified"]
        }
      }
    } catch {
      return {
        report: {
          ...base,
          registration: "conflict",
          runtimeAvailable: false,
          problems: ["Unsafe or modified installation files; preserve and reconcile them"]
        }
      }
    }
  })
  if (!inspected.report.runtimeAvailable || inspected.executable === undefined) return inspected.report
  const usable = yield* nodeUsable(inspected.executable)
  return usable
    ? inspected.report
    : {
        ...inspected.report,
        runtimeAvailable: false,
        problems: ["Installed Node executable is missing, not executable, or older than Node 24"]
      }
})

const inspectOwnership = (selection: Selection, text: string): Ownership => {
  const paths = installationPaths(selection)
  const ownership = Schema.decodeUnknownSync(Schema.fromJsonString(Ownership))(text)
  const expected = makeOwnership(selection, ownership.snapshot)
  const launcher = readOptional(paths.launcher)
  if (
    expected.command !== ownership.command ||
    launcher === undefined ||
    contentDigest(launcher) !== ownership.launcherDigest
  )
    throw new InstallationError({
      operation: "doctor",
      message: "Profile launcher or ownership differs from its installation"
    })
  const config = parseConfiguration(readOptional(paths.configuration) ?? "{}")
  if (configurationText(reconcile(config, ownership.command, true, true)) !== configurationText(config))
    throw new InstallationError({
      operation: "doctor",
      message: "Profile hook registration differs from its installation"
    })
  return ownership
}

const execute = promisify(execFile)
const nodeProbeDeadlineMs = 3_000
const minimumNodeMajor = 24
const nodeUsable = Effect.fn("Installation.nodeUsable")(function* (executable: string) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      await access(executable, constants.X_OK)
      const result = await execute(executable, ["--version"], {
        timeout: nodeProbeDeadlineMs,
        maxBuffer: 1024,
        signal,
        env: { ...process.env, NODE_OPTIONS: undefined }
      })
      const version = /^v(\d+)\.\d+\.\d+\s*$/u.exec(result.stdout)
      return version !== null && Number(version[1]) >= minimumNodeMajor
    },
    catch: () => new InstallationError({ operation: "node-probe", message: "Installed Node cannot be inspected" })
  }).pipe(Effect.orElseSucceed(() => false))
})
