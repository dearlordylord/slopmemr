import { Schema } from "effect"
import { AbsolutePath, Digest } from "../local-state/contracts.js"
import { Runtime } from "../intake/events.js"
import { Doctor } from "../installation/contracts.js"
import { Ping } from "../resident/identity.js"

export const Activation = Schema.Union([
  Schema.Struct({ serving: Schema.Literal(false), changed: Schema.Literal(false), implementation: Digest }),
  Schema.Struct({ serving: Schema.Literal(true), changed: Schema.Boolean, implementation: Digest })
])
const installed = {
  installed: Schema.Literal(true),
  command: AbsolutePath,
  runtime: Runtime,
  profile: AbsolutePath,
  nativeTrust: Schema.Literal("approve-in-host-if-required"),
  selectedBuild: Digest
}
export const Installed = Schema.Union([
  Schema.Struct({
    ...installed,
    activation: Schema.Literal("first-native-hook"),
    serving: Schema.Literal(false),
    restarted: Schema.Literal(false)
  }),
  Schema.Struct({
    ...installed,
    activation: Schema.Literals(["first-native-hook", "immediate"]),
    serving: Schema.Literal(true),
    restarted: Schema.Boolean
  })
])
export const ActivationFailure = Schema.Struct({
  installed: Schema.Literal(true),
  command: AbsolutePath,
  selectedBuild: Digest,
  activation: Schema.Literal("failed"),
  serving: Schema.Null,
  recovery: Schema.NonEmptyString
})
export const Diagnostic = Schema.Struct({ ...Doctor.fields, serving: Schema.NullOr(Ping) })
export const Repaired = Schema.Struct({ repaired: Schema.Literal(true), removed: Schema.Boolean })
