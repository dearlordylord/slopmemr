import { Schema } from "effect"
import { Digest } from "../local-state/contracts.js"
import { residentProtocolVersion } from "./limits.js"

export const applicationName = "slopmemr"
export const applicationVersion = "0.1.0"
export const Identity = Schema.Struct({
  application: Schema.Literal(applicationName),
  version: Schema.NonEmptyString,
  implementation: Digest
})
export type Identity = typeof Identity.Type
export const Ping = Schema.Struct({
  ...Identity.fields,
  protocol: Schema.Literal(residentProtocolVersion),
  pid: Schema.Int.check(Schema.isGreaterThan(0))
})
