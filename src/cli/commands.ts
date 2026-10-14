import { parseArgs } from "node:util"
import type { ParseArgsOptionsConfig } from "node:util"
import { Effect, Schema } from "effect"
import { AbsolutePath } from "../local-state/contracts.js"
import { Runtime } from "../intake/events.js"
import { maximumSettleWaitMs } from "../memory/limits.js"
import { ownerMarker } from "../installation/contracts.js"
import { CliError } from "./errors.js"

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Root = { root: AbsolutePath }
const Host = {
  runtime: Runtime,
  profile: Schema.optionalKey(AbsolutePath),
  codexHome: Schema.optionalKey(AbsolutePath),
  claudeHome: Schema.optionalKey(AbsolutePath)
}
const Hook = {
  runtime: Runtime,
  root: Schema.optionalKey(AbsolutePath),
  codexHome: Schema.optionalKey(AbsolutePath),
  claudeHome: Schema.optionalKey(AbsolutePath)
}

export const Command = Schema.TaggedUnion({
  Help: {},
  Start: {},
  Resident: {},
  Stop: {},
  Roots: {},
  Append: {},
  Request: {},
  Setup: Host,
  Update: Host,
  Doctor: Host,
  Uninstall: Host,
  Hook,
  HookConfig: Hook,
  Snapshot: {
    ...Root,
    before: Schema.optionalKey(Index),
    view: Schema.optionalKey(Schema.Literals(["main", "compaction"]))
  },
  Zoom: { ...Root, first: Index, count: Index.check(Schema.isGreaterThan(0)), page: Schema.optionalKey(Index) },
  Status: Root,
  Settle: { ...Root, waitMs: Schema.optionalKey(Index.check(Schema.isLessThanOrEqualTo(maximumSettleWaitMs))) }
})
export type Command = typeof Command.Type

const tags: Readonly<Record<string, keyof typeof Command.cases>> = {
  help: "Help",
  start: "Start",
  resident: "Resident",
  stop: "Stop",
  roots: "Roots",
  append: "Append",
  request: "Request",
  setup: "Setup",
  install: "Setup",
  update: "Update",
  doctor: "Doctor",
  uninstall: "Uninstall",
  hook: "Hook",
  "hook-config": "HookConfig",
  snapshot: "Snapshot",
  zoom: "Zoom",
  status: "Status",
  settle: "Settle"
}
const installerTags: ReadonlySet<keyof typeof Command.cases> = new Set(["Setup", "Update", "Doctor", "Uninstall"])
const optionNames: ReadonlyArray<string> = [
  "root",
  "runtime",
  "profile",
  "codex-home",
  "claude-home",
  "first",
  "count",
  "page",
  "before",
  "view",
  "wait-ms",
  "hook-owner"
]
const installerPositionalCount = 2
const numericOptions: ReadonlySet<string> = new Set(["first", "count", "page", "before", "wait-ms"])
const fieldNames: Readonly<Record<string, string>> = {
  "codex-home": "codexHome",
  "claude-home": "claudeHome",
  "wait-ms": "waitMs"
}

const optionDefinitions: ParseArgsOptionsConfig = Object.fromEntries(
  optionNames.map((name) => [name, { type: "string" } satisfies { type: "string" }])
)

const supportedOptions: ParseArgsOptionsConfig = { ...optionDefinitions, help: { type: "boolean" } }

export const parseCommand = Effect.fn("CLI.parseCommand")(function* (args: ReadonlyArray<string>) {
  const parsed = yield* Effect.try({
    try: () => parseArgs({ args: [...args], allowPositionals: true, options: supportedOptions }),
    catch: () => new CliError({ message: "Invalid options; run slopmemr help" })
  })
  if (parsed.values.help === true) return Command.cases.Help.make({})
  const tag = tags[parsed.positionals[0] ?? "help"]
  if (tag === undefined) return yield* Effect.fail(new CliError({ message: "Unknown command; run slopmemr help" }))
  const positionals = installerTags.has(tag) ? parsed.positionals.slice(1) : []
  const maximumPositionals = installerTags.has(tag) ? installerPositionalCount : 1
  if (parsed.positionals.length > maximumPositionals)
    return yield* Effect.fail(new CliError({ message: "Unexpected positional arguments" }))
  yield* Effect.try({
    try: () => validateOptions(parsed.positionals, parsed.values, tag),
    catch: () => new CliError({ message: "Conflicting runtime or invalid hook ownership marker" })
  })
  const fields = Object.fromEntries(
    Object.entries(parsed.values)
      .filter(([name]) => name !== "hook-owner")
      .map(([name, value]) => [fieldNames[name] ?? name, numericOptions.has(name) ? numericOption(value) : value])
  )
  const command = yield* Schema.decodeUnknownEffect(Command, { onExcessProperty: "error" })({
    ...fields,
    _tag: tag,
    ...(positionals[0] === undefined ? {} : { runtime: positionals[0] })
  }).pipe(Effect.mapError(() => new CliError({ message: "Invalid or missing command arguments; run slopmemr help" })))
  yield* Effect.try({
    try: () => validateProfile(command),
    catch: () => new CliError({ message: "Login profile must match the selected runtime" })
  })
  return command
})

const validateProfile = (command: Command): void => {
  if (!("runtime" in command)) return
  if (command.runtime === "claude" && command.codexHome !== undefined) throw new Error("Foreign Codex profile")
  if (command.runtime === "codex" && command.claudeHome !== undefined) throw new Error("Foreign Claude profile")
}

const validateOptions = (
  positionals: ReadonlyArray<string>,
  values: Readonly<Record<string, string | boolean | ReadonlyArray<string | boolean> | undefined>>,
  tag: string
): void => {
  const positional = positionals[1]
  if (positional !== undefined && values.runtime !== undefined && positional !== values.runtime)
    throw new CliError({ message: "Conflicting runtime selections" })
  validateOwner(values["hook-owner"], tag)
}
const validateOwner = (owner: unknown, tag: string): void => {
  if (owner !== undefined && (tag !== "Hook" || owner !== ownerMarker))
    throw new CliError({ message: "Invalid hook ownership marker" })
}

const numericOption = (value: unknown): number =>
  typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN
