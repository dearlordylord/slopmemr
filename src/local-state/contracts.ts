import { Schema } from "effect"

export const AbsolutePath = Schema.NonEmptyString.check(
  Schema.isPattern(/^\//u),
  Schema.makeFilter((value: string) => !value.includes("\0"))
)
export type AbsolutePath = typeof AbsolutePath.Type
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export type Digest = typeof Digest.Type
export const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type Milliseconds = typeof Milliseconds.Type
export const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type ByteCount = typeof ByteCount.Type

export const privateDirectoryMode = 0o700
export const privateFileMode = 0o600
export const otherUserPermissions = 0o077
