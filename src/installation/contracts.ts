import { Schema } from "effect"
import { AbsolutePath, Digest } from "../local-state/contracts.js"
import { ProcessLaunch } from "../local-state/process-launch.js"
import { Runtime } from "../intake/events.js"

export const installationFormatVersion = 1
export const ownerMarker = "slopmemr-hook-owner-1"

export const Snapshot = Schema.Struct({ digest: Digest, directory: AbsolutePath, launch: ProcessLaunch })
export type Snapshot = typeof Snapshot.Type
export const Selection = Schema.Struct({
  runtime: Runtime,
  profile: AbsolutePath,
  codexHome: Schema.optionalKey(AbsolutePath),
  claudeHome: Schema.optionalKey(AbsolutePath)
})
export type Selection = typeof Selection.Type
export const Ownership = Schema.Struct({
  version: Schema.Literal(installationFormatVersion),
  selection: Selection,
  snapshot: Snapshot,
  command: Schema.NonEmptyString,
  launcherDigest: Digest
})
export type Ownership = typeof Ownership.Type

export const Operation = Schema.TaggedUnion({
  Install: { ownership: Ownership, previousOwnership: Schema.optionalKey(Ownership) },
  Uninstall: { ownership: Ownership }
})
export type Operation = typeof Operation.Type

export const Doctor = Schema.Struct({
  runtime: Runtime,
  profile: AbsolutePath,
  registration: Schema.Literals(["ready", "missing", "conflict", "recovery-required"]),
  runtimeAvailable: Schema.Boolean,
  nativeTrust: Schema.Literal("host-owned-unchecked"),
  authentication: Schema.Literal("not-probed"),
  residentActivation: Schema.Literal("next-automatic-start"),
  problems: Schema.Array(Schema.NonEmptyString)
})
export type Doctor = typeof Doctor.Type

export class InstallationError extends Schema.TaggedError<InstallationError>()("InstallationError", {
  operation: Schema.String,
  message: Schema.String
}) {}
