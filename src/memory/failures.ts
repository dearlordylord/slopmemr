import { Schema } from "effect"
import { Address } from "./views.js"

const Reason = Schema.Literals(["authentication", "capacity", "timeout", "provider", "unknown"])
type Reason = typeof Reason.Type
export const SummaryFailure = Schema.Struct({ node: Address, reason: Reason, guidance: Schema.NonEmptyString })
const known: Readonly<Record<string, Reason>> = {
  "No usable caller Codex profile selected": "authentication",
  "No usable caller Claude profile selected": "authentication",
  "Caller Codex profile unavailable": "authentication",
  "Caller Claude profile unavailable": "authentication",
  "Compaction requires the caller's ChatGPT login; API-key profiles are unsupported": "authentication",
  "Login profile does not match the source agent runtime": "authentication",
  "Auth profile capacity reached": "capacity",
  "Claude auth profile capacity reached": "capacity",
  "Codex compaction timed out": "timeout",
  "Claude compaction timed out": "timeout",
  "Claude Haiku compaction failed; check subscription login and CLI compatibility": "provider",
  "Codex compaction failed; check profile, model availability, and protocol compatibility": "provider"
}
const guidance: Readonly<Record<Reason, string>> = {
  authentication: "Check the source agent's native subscription login and profile; originals remain available.",
  capacity: "Summarizer profile capacity is exhausted; retry after active work completes or restart the resident.",
  timeout: "Summarization timed out; check the native CLI and retry. Originals remain available.",
  provider:
    "The native summarizer failed; check subscription, model availability and CLI compatibility before retrying.",
  unknown: "Summary generation failed; inspect the native agent setup and retry. Originals remain available."
}
const prefix = "SLOPMEMR_SUMMARY_FAILURE:"
export const failureToken = (message: string): string => prefix + (known[message] ?? "unknown")
export const failureDetails = (message: string): Pick<typeof SummaryFailure.Type, "reason" | "guidance"> => {
  const token = message.match(/SLOPMEMR_SUMMARY_FAILURE:(authentication|capacity|timeout|provider|unknown)\b/u)?.[1]
  const reason = Schema.decodeUnknownOption(Reason)(token)
  // Foreign/legacy error strings are never reflected into agent-facing output.
  const value = reason._tag === "Some" ? reason.value : "unknown"
  return { reason: value, guidance: guidance[value] }
}

export class SummaryBackendFailure extends Schema.TaggedError<SummaryBackendFailure>()("SummaryBackendFailure", {
  message: Schema.String
}) {}
