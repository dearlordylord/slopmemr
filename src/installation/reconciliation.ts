import { Schema } from "effect"
import { hookEvents, hookTimeoutSeconds } from "../intake/events.js"
import { InstallationError } from "./contracts.js"

export const Configuration = Schema.Record(Schema.String, Schema.Json)
export type Configuration = typeof Configuration.Type
const Hooks = Schema.Record(Schema.String, Schema.Array(Schema.Json))
const ObjectValue = Schema.Record(Schema.String, Schema.Json)
const Handler = Schema.Struct({ command: Schema.optionalKey(Schema.String) })
const Group = Schema.Struct({ hooks: Schema.Array(Schema.Json) })

export const parseConfiguration = (text: string): Configuration =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Configuration))(text)

export const ownedGroup = (command: string): Schema.Json => ({
  hooks: [{ type: "command", command, timeout: hookTimeoutSeconds }]
})

const groupCommands = (value: Schema.Json): ReadonlyArray<string> => {
  const group = Schema.decodeUnknownSync(Group)(value)
  return group.hooks.flatMap((handler) => {
    const command = Schema.decodeUnknownSync(Handler)(handler).command
    return command === undefined ? [] : [command]
  })
}

const isOwned = (value: Schema.Json, command: string): boolean => {
  const launcherPrefix = command.slice(0, command.lastIndexOf(" --hook-owner "))
  return groupCommands(value).some(
    (candidate) => candidate === command || candidate === launcherPrefix || candidate.startsWith(launcherPrefix + " ")
  )
}
const canonical = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)])
    )
  return value
}
const matchesOwned = (value: Schema.Json, command: string): boolean =>
  JSON.stringify(canonical(value)) === JSON.stringify(canonical(ownedGroup(command)))

const reconcileEvent = (
  groups: ReadonlyArray<Schema.Json>,
  command: string,
  install: boolean,
  recorded: boolean
): ReadonlyArray<Schema.Json> => {
  const matching = groups.filter((group) => isOwned(group, command))
  if (matching.length > 1)
    throw new InstallationError({ operation: "reconcile", message: "Duplicate owned hooks require reconciliation" })
  if (matching.some((group) => !matchesOwned(group, command)))
    throw new InstallationError({
      operation: "reconcile",
      message: "Owned hook was modified; preserve it and reconcile before updating"
    })
  if (install && recorded && matching.length === 0)
    throw new InstallationError({
      operation: "reconcile",
      message: "Recorded hook is missing; reconcile the profile before updating"
    })
  const retained = groups.filter((group) => !isOwned(group, command))
  return install ? (matching.length === 0 ? [...retained, ownedGroup(command)] : groups) : retained
}

/** Only our event entries change; all unrelated configuration values survive. */
export const reconcile = (
  configuration: Configuration,
  command: string,
  install: boolean,
  recorded = false
): Configuration => {
  const hooks = configuration.hooks === undefined ? {} : Schema.decodeUnknownSync(Hooks)(configuration.hooks)
  const next = { ...hooks }
  for (const event of hookEvents) {
    const groups = reconcileEvent(hooks[event] ?? [], command, install, recorded)
    if (groups.length === 0) delete next[event]
    else next[event] = [...groups]
  }
  const result = { ...configuration }
  if (Object.keys(next).length === 0) delete result.hooks
  else result.hooks = Schema.decodeUnknownSync(ObjectValue)(next)
  return result
}

export const configurationText = (configuration: Configuration): string =>
  JSON.stringify(configuration, null, configurationIndentation) + "\n"

const configurationIndentation = 2
