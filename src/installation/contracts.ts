import { Schema } from "effect"
import { AbsolutePath, Digest } from "../local-state/contracts.js"
import { ProcessLaunch } from "../local-state/process-launch.js"
import { Runtime } from "../intake/events.js"

export const installationFormatVersion = 1
export { ownerMarker } from "../intake/ownership.js"

const SnapshotBase = { digest: Digest, directory: AbsolutePath, launch: ProcessLaunch }
export const CurrentSnapshot = Schema.Struct({
  ...SnapshotBase,
  hook: Schema.Struct({ launch: ProcessLaunch, digest: Digest }),
  dataDirectory: AbsolutePath,
  runtimeDigest: Digest
})
const LegacySnapshot = Schema.Struct({
  ...SnapshotBase,
  hook: Schema.optionalKey(Schema.Never),
  dataDirectory: Schema.optionalKey(Schema.Never),
  runtimeDigest: Schema.optionalKey(Schema.Never)
})
export const Snapshot = Schema.Union([CurrentSnapshot, LegacySnapshot])
export type Snapshot = typeof Snapshot.Type
export type CurrentSnapshot = typeof CurrentSnapshot.Type
export const Selection = Schema.Struct({
  runtime: Runtime,
  profile: AbsolutePath,
  codexHome: Schema.optionalKey(AbsolutePath),
  claudeHome: Schema.optionalKey(AbsolutePath),
  mcpConfiguration: Schema.optionalKey(AbsolutePath)
})
export type Selection = typeof Selection.Type
export const McpBinding = Schema.Struct({
  configuration: AbsolutePath,
  launcher: AbsolutePath,
  launcherDigest: Digest,
  entry: Schema.Record(Schema.String, Schema.Json)
})
export type McpBinding = typeof McpBinding.Type
export const Ownership = Schema.Struct({
  version: Schema.Literal(installationFormatVersion),
  selection: Selection,
  snapshot: Snapshot,
  command: Schema.NonEmptyString,
  launcherDigest: Digest,
  mcp: Schema.optionalKey(McpBinding)
})
export type Ownership = typeof Ownership.Type

export const Operation = Schema.TaggedUnion({
  Install: { ownership: Ownership, previousOwnership: Schema.optionalKey(Ownership) },
  Uninstall: { ownership: Ownership }
})
export type Operation = typeof Operation.Type

export const DeliveryIntent = Schema.Struct({
  action: Schema.Literals(["Setup", "Update"]),
  publicDirectory: AbsolutePath
})
export type DeliveryIntent = typeof DeliveryIntent.Type
export const Delivery = Schema.Struct({ intent: DeliveryIntent, ownership: Ownership })
export type Delivery = typeof Delivery.Type

export const Doctor = Schema.Struct({
  runtime: Runtime,
  profile: AbsolutePath,
  registration: Schema.Literals(["ready", "missing", "conflict", "recovery-required"]),
  hooks: Schema.optionalKey(Schema.Literals(["ready", "missing", "conflict"])),
  runtimeAvailable: Schema.Boolean,
  nativeTrust: Schema.Literal("host-owned-unchecked"),
  authentication: Schema.Literal("not-probed"),
  residentActivation: Schema.Literal("next-automatic-start"),
  problems: Schema.Array(Schema.NonEmptyString),
  mcp: Schema.optionalKey(Schema.Literals(["ready", "missing", "conflict", "recovery-required"]))
})
export type Doctor = typeof Doctor.Type

export class InstallationError extends Schema.TaggedError<InstallationError>()("InstallationError", {
  operation: Schema.String,
  message: Schema.String
}) {}
