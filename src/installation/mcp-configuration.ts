import { Schema } from "effect"
import { parse, stringify } from "smol-toml"
import type { Runtime } from "../intake/events.js"
import { InstallationError } from "./contracts.js"
import { canonical } from "./reconciliation.js"

const ObjectValue = Schema.Record(Schema.String, Schema.Json)
const Table = Schema.Record(Schema.String, Schema.Unknown)
const name = "slopmemr"
const jsonIndentation = 2

export interface Document {
  readonly runtime: Runtime
  readonly configuration: Readonly<Record<string, unknown>>
  readonly servers: Readonly<Record<string, unknown>>
  readonly entry: Schema.Json | undefined
}

/** Parsing retains unowned native values; publication receives that state explicitly. */
export const document = (runtime: Runtime, text: string | undefined): Document => {
  const configuration =
    text === undefined
      ? {}
      : runtime === "codex"
        ? parse(text)
        : Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue))(text)
  const section = configuration[runtime === "codex" ? "mcp_servers" : "mcpServers"]
  const servers = section === undefined ? {} : Schema.decodeUnknownSync(Table)(section)
  const current = servers[name]
  return {
    runtime,
    configuration,
    servers,
    entry: current === undefined ? undefined : Schema.decodeUnknownSync(Schema.Json)(current)
  }
}

export const replaceEntry = (parsed: Document, entry: Schema.Json | undefined): string => {
  const next = { ...parsed.servers }
  if (entry === undefined) delete next[name]
  else next[name] = entry
  const result = { ...parsed.configuration }
  const section = parsed.runtime === "codex" ? "mcp_servers" : "mcpServers"
  if (Object.keys(next).length === 0) delete result[section]
  else result[section] = next
  return parsed.runtime === "codex" ? stringify(result) : JSON.stringify(result, null, jsonIndentation) + "\n"
}

export const sameEntry = (left: Schema.Json, right: Schema.Json): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

export const validateEntry = (
  current: Schema.Json | undefined,
  allowed: ReadonlyArray<Schema.Json>,
  missingAllowed: boolean
): void => {
  if (current === undefined) {
    if (missingAllowed) return
    throw new InstallationError({ operation: "mcp", message: "Recorded MCP entry is missing; run repair" })
  }
  if (!allowed.some((entry) => sameEntry(current, entry)))
    throw new InstallationError({
      operation: "mcp",
      message: "MCP name is foreign or the owned entry was modified; preserve and reconcile it"
    })
}
