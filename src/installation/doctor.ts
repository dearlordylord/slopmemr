import { access } from "node:fs/promises"
import { constants, readFileSync, lstatSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { Ownership, InstallationError, type Doctor, type Selection, type Snapshot } from "./contracts.js"
import { contentDigest, installationPaths, makeOwnership } from "./binding.js"
import { readOptional, writeAtomic, removeOptional } from "./files.js"
import { configurationText, parseConfiguration, reconcile } from "./reconciliation.js"
import { inspectMcp } from "./mcp.js"

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
      const recovery = readOptional(paths.operation) !== undefined || readOptional(paths.delivery) !== undefined
      const text = readOptional(paths.ownership)
      if (text === undefined) return { report: { ...base, ...absentOwnership(recovery) } }
      const ownership = Schema.decodeUnknownSync(Schema.fromJsonString(Ownership))(text)
      const expected = makeOwnership(selection, ownership.snapshot)
      validateMcpScope(ownership, expected)
      const runtimeAvailable = inspectComponent(() => artifactsAvailable(ownership.snapshot)) === "ready"
      const hooks = inspectComponent(() => inspectOwnership(selection, text))
      const mcp = inspectComponent(() =>
        inspectMcp(ownership, { read: readOptional, write: writeAtomic, remove: removeOptional })
      )
      return {
        executable: ownership.snapshot.launch.executable,
        report: {
          ...base,
          registration: recovery ? "recovery-required" : hooks,
          hooks,
          runtimeAvailable,
          problems: componentProblems(recovery, runtimeAvailable, hooks, mcp),
          mcp
        }
      }
    } catch {
      return {
        report: {
          ...base,
          registration: "conflict",
          runtimeAvailable: false,
          mcp: "conflict",
          problems: ["Unsafe or modified installation files; preserve and reconcile them"]
        }
      }
    }
  })
  if (!inspected.report.runtimeAvailable || inspected.executable === undefined) return inspected.report
  const usable = yield* nodeUsable(inspected.executable, runtimeProbe)
  return usable
    ? inspected.report
    : {
        ...inspected.report,
        runtimeAvailable: false,
        problems: ["Installed Node executable is missing, not executable, or older than Node 24"]
      }
})

const artifactsAvailable = (snapshot: Snapshot): boolean => {
  const runtime = readOptional(snapshot.launch.entrypoint)
  const hook = snapshot.hook
  if (runtime === undefined || contentDigest(runtime) !== snapshot.digest || hook === undefined) return false
  const hookText = readOptional(hook.launch.entrypoint)
  if (
    hookText === undefined ||
    contentDigest(hookText) !== hook.digest ||
    hook.launch.executable !== snapshot.launch.executable
  )
    return false
  return runtimeAvailable(snapshot)
}

const runtimeAvailable = (snapshot: Snapshot): boolean => {
  if (snapshot.runtimeDigest === undefined) return false
  try {
    const stat = lstatSync(snapshot.launch.executable)
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      contentDigest(readFileSync(snapshot.launch.executable)) === snapshot.runtimeDigest
    )
  } catch {
    return false
  }
}

const inspectOwnership = (selection: Selection, text: string): boolean => {
  const paths = installationPaths(selection)
  const ownership = Schema.decodeUnknownSync(Schema.fromJsonString(Ownership))(text)
  const expected = makeOwnership(selection, ownership.snapshot)
  validateMcpScope(ownership, expected)
  const launcher = readOptional(paths.launcher)
  if (launcher === undefined) return false
  if (expected.command !== ownership.command || contentDigest(launcher) !== ownership.launcherDigest)
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
  return true
}

const execute = promisify(execFile)
const nodeProbeDeadlineMs = 3_000
const minimumNodeMajor = 24
export type RuntimeProbe = (executable: string, signal: AbortSignal) => Promise<string>
export const runtimeProbe: RuntimeProbe = async (executable, signal) => {
  await access(executable, constants.X_OK)
  const result = await execute(executable, ["--version"], {
    timeout: nodeProbeDeadlineMs,
    maxBuffer: 1024,
    signal,
    env: { ...process.env, NODE_OPTIONS: undefined }
  })
  return result.stdout
}

export const nodeUsable = Effect.fn("Installation.nodeUsable")(function* (executable: string, probe: RuntimeProbe) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const version = /^v(\d+)\.\d+\.\d+\s*$/u.exec(await probe(executable, signal))
      return version !== null && Number(version[1]) >= minimumNodeMajor
    },
    catch: () => new InstallationError({ operation: "node-probe", message: "Installed Node cannot be inspected" })
  }).pipe(Effect.orElseSucceed(() => false))
})

const validateMcpScope = (owned: Ownership, expected: Ownership): void => {
  if (owned.mcp !== undefined && expected.mcp?.configuration !== owned.mcp.configuration)
    throw new InstallationError({
      operation: "doctor",
      message: "MCP configuration scope differs from its installation"
    })
}

const inspectComponent = (inspect: () => boolean): "ready" | "missing" | "conflict" => {
  try {
    return inspect() ? "ready" : "missing"
  } catch {
    return "conflict"
  }
}

const absentOwnership = (
  recovery: boolean
): Pick<Doctor, "registration" | "runtimeAvailable" | "problems" | "mcp"> => ({
  registration: recovery ? "recovery-required" : "missing",
  runtimeAvailable: false,
  problems: recovery ? ["Interrupted installation; run repair"] : [],
  mcp: "missing"
})
const componentProblems = (recovery: boolean, runtime: boolean, hooks: string, mcp: string): string[] => [
  ...(recovery ? ["Interrupted installation; run repair"] : []),
  ...(runtime ? [] : ["Installed runtime is missing or modified"]),
  ...(hooks === "ready" ? [] : ["Hook registration is missing or modified"]),
  ...(mcp === "ready" ? [] : ["MCP registration is missing or modified"])
]
