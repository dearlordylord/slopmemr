import { lstatSync, readFileSync, realpathSync } from "node:fs"
import type { Stats } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { Digest } from "../local-state/contracts.js"
import { contentDigest } from "./binding.js"
import { InstallationError } from "./contracts.js"
import type { ProcessLaunch } from "../local-state/process-launch.js"

const Artifact = Schema.Struct({ digest: Digest })
export const PackageManifest = Schema.Struct({
  application: Schema.Literal("slopmemr"),
  format: Schema.Literal(1),
  version: Schema.NonEmptyString,
  platform: Schema.Literals(["linux", "darwin"]),
  arch: Schema.Literals(["arm64", "x64"]),
  cli: Artifact,
  hook: Artifact,
  runtime: Artifact,
  notices: Artifact,
  runtimeNotices: Artifact
})
export type PackageManifest = typeof PackageManifest.Type
const files = {
  cli: "bin/slopmemr.mjs",
  hook: "bin/slopmemr-hook.mjs",
  runtime: "runtime/node",
  notices: "bin/THIRD_PARTY_NOTICES.txt",
  runtimeNotices: "NODE_LICENSE"
}
export interface PackageFiles {
  readonly stat: (path: string) => Stats
  readonly read: (path: string) => Uint8Array
  readonly canonical: (path: string) => string
  readonly platform: string
  readonly arch: string
}
export const packageFiles: PackageFiles = {
  stat: lstatSync,
  read: readFileSync,
  canonical: realpathSync,
  platform: process.platform,
  arch: process.arch
}

export const inspectPackage = (
  directory: string,
  io: PackageFiles
): { readonly manifest: PackageManifest; readonly launch: ProcessLaunch } => {
  const root = io.canonical(directory)
  const text = Buffer.from(io.read(join(root, "manifest.json"))).toString("utf8")
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest), { onExcessProperty: "error" })(text)
  if (manifest.platform !== io.platform || manifest.arch !== io.arch)
    throw new InstallationError({ operation: "package", message: "Package platform does not match this machine" })
  for (const [role, file] of Object.entries(files)) {
    const path = join(root, file)
    const stat = io.stat(path)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new InstallationError({ operation: "package", message: "Package contains an invalid artifact" })
    if (contentDigest(io.read(path)) !== roleDigest(manifest, role))
      throw new InstallationError({ operation: "package", message: "Package artifact checksum mismatch" })
  }
  return { manifest, launch: { executable: join(root, files.runtime), entrypoint: join(root, files.cli) } }
}

const roleDigest = (manifest: PackageManifest, role: string): string => {
  const roles: Readonly<Record<string, { readonly digest: string }>> = {
    cli: manifest.cli,
    hook: manifest.hook,
    runtime: manifest.runtime,
    notices: manifest.notices,
    runtimeNotices: manifest.runtimeNotices
  }
  const artifact = roles[role]
  if (artifact === undefined)
    throw new InstallationError({ operation: "package", message: "Unknown package artifact role" })
  return artifact.digest
}

export const targetPackage = Effect.fn("Installation.targetPackage")(function* (target: string) {
  return yield* Effect.try({
    try: () => inspectPackage(lstatSync(target).isDirectory() ? target : dirname(dirname(target)), packageFiles).launch,
    catch: (cause) =>
      cause instanceof InstallationError
        ? cause
        : new InstallationError({
            operation: "package",
            message: "Cannot read a ready-made package; pass its package directory to --target"
          })
  })
})
