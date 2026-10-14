import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { contentDigest } from "../installation/binding.js"
import { applicationName, applicationVersion } from "../resident/identity.js"
import type { Identity } from "../resident/identity.js"
import { CliError } from "./errors.js"
import { Console, Deferred, Effect, Layer, Schema } from "effect"
import { layer as compactorLayer } from "../compaction/backends.js"
import { Append } from "../memory/contracts.js"
import { layer as memoryLayer } from "../memory/manager.js"
import { Hook, hookConfiguration, normalize } from "../intake/hook.js"
import { commandRequiresAcknowledgement } from "../intake/events.js"
import { layer as residentLayer } from "../resident/server.js"
import { request } from "../resident/client.js"
import { Request } from "../resident/protocol.js"
import { settleClientDeadlineMs } from "../resident/limits.js"
import { launchCommand, shellQuote, type ProcessLaunch } from "../local-state/process-launch.js"
import { enableHooks } from "../installation/native-feature.js"
import { install, uninstall } from "../installation/manager.js"
import { doctor } from "../installation/doctor.js"
import type { Selection } from "../installation/contracts.js"
import { configuration } from "./configuration.js"
import { send, start } from "./lifecycle.js"
import { Command, parseCommand } from "./commands.js"
import { readInput } from "./input.js"
import { printJson } from "./output.js"
import { help } from "./help.js"

const serve = Effect.fn("CLI.serve")(function* (config: Effect.Success<typeof configuration>, launch: ProcessLaunch) {
  const implementation = yield* Effect.try({
    try: () => contentDigest(readFileSync(launch.entrypoint)),
    catch: () => new CliError({ message: "Cannot identify installed resident runtime" })
  })
  const identity = { application: applicationName, version: applicationVersion, implementation } satisfies Identity
  const shutdown = yield* Deferred.make<void>()
  const memory = memoryLayer(config.memory).pipe(
    Layer.provide(compactorLayer(config.compactor, config.claudeCompactor))
  )
  const resident = residentLayer({
    identity,
    endpoint: config.endpoint,
    onShutdown: () => {
      Effect.runSync(Deferred.succeed(shutdown, undefined))
    }
  }).pipe(Layer.provide(memory))
  yield* Deferred.await(shutdown).pipe(Effect.provide(resident))
})

const hostSelection = (
  command: Extract<Command, { _tag: "Setup" | "Update" | "Doctor" | "Uninstall" }>,
  callerHome: string,
  callerClaudeHome: string
): Selection => ({
  runtime: command.runtime,
  profile: command.profile ?? (command.runtime === "codex" ? callerHome : callerClaudeHome),
  ...(command.codexHome === undefined ? {} : { codexHome: command.codexHome }),
  ...(command.claudeHome === undefined ? {} : { claudeHome: command.claudeHome })
})

const runHook = Effect.fn("CLI.hook")(function* (
  command: Extract<Command, { _tag: "Hook" }>,
  config: Effect.Success<typeof configuration>,
  launch: ProcessLaunch,
  source: AsyncIterable<unknown>
) {
  const hook = yield* Schema.decodeUnknownEffect(Hook)(yield* readInput(source))
  const input = normalize(
    hook,
    {
      runtime: command.runtime,
      ...(command.root === undefined ? {} : { root: command.root }),
      auth:
        command.runtime === "codex"
          ? { codexHome: command.codexHome ?? config.callerHome }
          : { claudeHome: command.claudeHome ?? config.callerClaudeHome }
    },
    yield* Effect.sync(randomUUID)
  )
  yield* send(config.endpoint, { _tag: "Append", ...input }, launch)
  if (commandRequiresAcknowledgement(command.runtime, hook.hook_event_name)) yield* Console.log("{}")
})

const runHost = Effect.fn("CLI.host")(function* (
  command: Extract<Command, { _tag: "Setup" | "Update" | "Doctor" | "Uninstall" }>,
  config: Effect.Success<typeof configuration>,
  launch: ProcessLaunch
) {
  const selection = hostSelection(command, config.callerHome, config.callerClaudeHome)
  switch (command._tag) {
    case "Doctor":
      return yield* printJson(yield* doctor(selection))
    case "Uninstall":
      return yield* printJson(yield* uninstall(selection))
    default: {
      const ownership = yield* install(
        selection,
        launch,
        config.memory.directory,
        command._tag === "Update",
        undefined,
        (selected) => enableHooks(selected, config.compactor.executable)
      )
      yield* printJson({
        installed: true,
        runtime: ownership.selection.runtime,
        profile: ownership.selection.profile,
        activation: "first-native-hook",
        nativeTrust: "approve-in-host-if-required"
      })
    }
  }
})

const runControl = Effect.fn("CLI.control")(function* (
  command: Command,
  config: Effect.Success<typeof configuration>,
  launch: ProcessLaunch,
  source: AsyncIterable<unknown>
) {
  switch (command._tag) {
    case "Start":
      return yield* printJson(yield* start(config.endpoint, launch))
    case "Stop":
      return yield* printJson(yield* request(config.endpoint, { _tag: "Shutdown" }))
    case "Resident":
      return yield* serve(config, launch)
    case "Hook":
      return yield* runHook(command, config, launch, source)
    case "HookConfig": {
      const root = command.root === undefined ? "" : ` --root ${shellQuote(command.root)}`
      return yield* printJson(
        hookConfiguration(`${launchCommand(launch)} hook --runtime ${command.runtime}${root}${hookAuthFlags(command)}`)
      )
    }
    default:
      return false
  }
})

const hookAuthFlags = (command: Extract<Command, { _tag: "HookConfig" }>): string =>
  (command.codexHome === undefined ? "" : ` --codex-home ${shellQuote(command.codexHome)}`) +
  (command.claudeHome === undefined ? "" : ` --claude-home ${shellQuote(command.claudeHome)}`)

const memoryRequest = Effect.fn("CLI.memoryRequest")(function* (command: Command, source: AsyncIterable<unknown>) {
  if (command._tag === "Append")
    return {
      _tag: "Append",
      ...(yield* Schema.decodeUnknownEffect(Append)(yield* readInput(source)))
    } satisfies Request
  if (command._tag === "Request") return yield* Schema.decodeUnknownEffect(Request)(yield* readInput(source))
  return yield* Schema.decodeUnknownEffect(Request)(command)
})

export const program = Effect.fn("CLI.program")(function* (
  args: ReadonlyArray<string>,
  launch: ProcessLaunch,
  source: AsyncIterable<unknown> = process.stdin
) {
  const command = yield* parseCommand(args)
  if (command._tag === "Help") return yield* Console.log(help)
  const config = yield* configuration
  if (isHostCommand(command)) return yield* runHost(command, config, launch)
  const handled = yield* runControl(command, config, launch, source)
  if (handled !== false) return
  const value = yield* memoryRequest(command, source)
  yield* printJson(
    yield* send(config.endpoint, value, launch, value._tag === "Settle" ? settleClientDeadlineMs : undefined)
  )
})

const isHostCommand = Command.isAnyOf(["Setup", "Update", "Doctor", "Uninstall"])
