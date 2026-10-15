import { authorizeSnapshot, artifactFiles } from "../installation/artifacts.js"
import { TransportError } from "../resident/endpoint.js"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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
import { uninstall, repair } from "../installation/manager.js"
import { doctor } from "../installation/doctor.js"
import type { Selection, Snapshot } from "../installation/contracts.js"
import { configuration } from "./configuration.js"
import { send, start } from "./lifecycle.js"
import { selection as selectedRuntime } from "../resident/startup.js"
import { readSelection, selectionFiles, type RuntimeSelection } from "../local-state/runtime-selection.js"
import { Command, parseCommand } from "./commands.js"
import { readInput } from "./input.js"
import { Activation, Installed, ActivationFailure, Diagnostic, Repaired } from "./responses.js"
import { printResponse, printJson } from "./output.js"
import { help } from "./help.js"
import { commandHelp } from "../mcp/catalog.js"
import { layer as readerLayer } from "../mcp/reader.js"
import { run as runMcp } from "../mcp/stdio.js"
import { guidance } from "../intake/guidance.js"
import { deliver, pendingDelivery } from "../installation/delivery.js"
import { targetPackage } from "../installation/package.js"
import { selectRuntime, ownSelection } from "../installation/runtime-selection.js"
import { activate, inspect as inspectResident } from "../resident/maintenance.js"

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
    runtime: { ...launch, dataDirectory: config.memory.directory },
    onShutdown: () => {
      Effect.runSync(Deferred.succeed(shutdown, undefined))
    }
  }).pipe(Layer.provide(memory))
  yield* Deferred.await(shutdown).pipe(Effect.provide(resident))
})

const hostSelection = (
  command: Extract<Command, { _tag: "Setup" | "Update" | "Doctor" | "Uninstall" | "Repair" }>,
  callerHome: string,
  callerClaudeHome: string,
  callerClaudeMcpConfiguration: string
): Selection => ({
  runtime: command.runtime,
  profile: command.profile ?? (command.runtime === "codex" ? callerHome : callerClaudeHome),
  ...(command.codexHome === undefined ? {} : { codexHome: command.codexHome }),
  ...(command.claudeHome === undefined ? {} : { claudeHome: command.claudeHome }),
  ...(command.runtime === "claude"
    ? {
        mcpConfiguration:
          command.profile === undefined || command.profile === callerClaudeHome
            ? callerClaudeMcpConfiguration
            : join(command.profile, ".claude.json")
      }
    : {})
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
  if (hook.hook_event_name === "SessionStart") yield* Console.log(guidance(command.runtime, input.root))
  else if (commandRequiresAcknowledgement(command.runtime, hook.hook_event_name)) yield* Console.log("{}")
})

const runHost = Effect.fn("CLI.host")(function* (
  command: Extract<Command, { _tag: "Setup" | "Update" | "Doctor" | "Uninstall" | "Repair" }>,
  config: Effect.Success<typeof configuration>,
  launch: ProcessLaunch
) {
  const selection = hostSelection(
    command,
    config.callerHome,
    config.callerClaudeHome,
    config.callerClaudeMcpConfiguration
  )
  switch (command._tag) {
    case "Doctor":
      return yield* printResponse(Diagnostic, {
        ...(yield* doctor(selection)),
        serving: yield* inspectResident(config.endpoint)
      })
    case "Uninstall":
      return yield* printJson(yield* uninstall(selection))
    case "Repair":
      return yield* repairHost(selection, config)
    default: {
      const target = command.target === undefined ? launch : yield* targetPackage(command.target)
      yield* deliver(
        { action: command._tag, publicDirectory: config.publicDirectory },
        selection,
        target,
        config.memory.directory,
        (selected) => enableHooks(selected, config.compactor.executable),
        (action, snapshot) =>
          finishHostActivation({ _tag: action, runtime: selection.runtime }, config, selection, snapshot)
      )
    }
  }
})

const repairHost = Effect.fn("CLI.repairHost")(function* (
  selection: Selection,
  config: Effect.Success<typeof configuration>
) {
  const pending = yield* pendingDelivery(selection)
  if (pending === undefined)
    return yield* printResponse(
      Repaired,
      yield* repair(selection, undefined, (selected) => enableHooks(selected, config.compactor.executable))
    )
  if (
    pending.ownership.snapshot.dataDirectory !== config.memory.directory ||
    pending.intent.publicDirectory !== config.publicDirectory
  )
    return yield* Effect.fail(
      new CliError({ message: "Repair requires the original memory and public-command directories" })
    )
  yield* deliver(
    pending.intent,
    selection,
    pending.ownership.snapshot.launch,
    config.memory.directory,
    (selected) => enableHooks(selected, config.compactor.executable),
    (action, snapshot) =>
      finishHostActivation({ _tag: action, runtime: selection.runtime }, config, selection, snapshot)
  )
  return
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
    case "Restart":
      return yield* restart(config.endpoint, yield* selectedRuntime())
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
  const reading = readTags[command._tag]
  if (reading !== undefined) return yield* Schema.decodeUnknownEffect(Request)({ ...command, _tag: reading })
  return yield* Schema.decodeUnknownEffect(Request)(command)
})

const readTags: Readonly<Partial<Record<Command["_tag"], Request["_tag"]>>> = {
  Snapshot: "ReadSnapshot",
  Zoom: "ReadZoom",
  Status: "ReadStatus"
}

export const program = Effect.fn("CLI.program")(function* (
  args: ReadonlyArray<string>,
  launch: ProcessLaunch,
  source: AsyncIterable<unknown> = process.stdin
) {
  const command = yield* parseCommand(args)
  if (command._tag === "Help") return yield* Console.log(helpText(command.topic))
  const config = yield* configuration
  if (command._tag === "Mcp")
    return yield* runMcp().pipe(Effect.provide(readerLayer((value) => send(config.endpoint, value, launch))))
  if (isHostCommand(command)) return yield* runHost(command, config, launch)
  const handled = yield* runControl(command, config, launch, source)
  if (handled !== false) return
  const value = yield* memoryRequest(command, source)
  yield* printJson(
    yield* send(config.endpoint, value, launch, value._tag === "Settle" ? settleClientDeadlineMs : undefined)
  )
})

const isHostCommand = Command.isAnyOf(["Setup", "Update", "Doctor", "Uninstall", "Repair"])
const restart = Effect.fn("CLI.restart")(function* (
  paths: Effect.Success<typeof configuration>["endpoint"],
  selected: RuntimeSelection | undefined
) {
  if (selected === undefined)
    return yield* Effect.fail(new CliError({ message: "No installed resident target; run install first" }))
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* ownSelection(selected.dataDirectory)
      const current = yield* Effect.try({
        try: () => readSelection(selected.dataDirectory, selectionFiles),
        catch: () => new CliError({ message: "Cannot read the selected resident under its activation lock" })
      })
      if (current === undefined)
        return yield* Effect.fail(new CliError({ message: "No installed resident target; run install first" }))
      yield* printResponse(
        Activation,
        yield* activate(paths, current, true, true, reconcileOwner(current.dataDirectory))
      )
    })
  )
})

const helpText = (topic: string | undefined): string => (topic === undefined ? help : (commandHelp(topic) ?? help))

const finishHostActivation = Effect.fn("CLI.finishHostActivation")(function* (
  command: Extract<Command, { _tag: "Setup" | "Update" }>,
  config: Effect.Success<typeof configuration>,
  selection: Selection,
  snapshot: Snapshot
) {
  const path = join(config.publicDirectory, "slopmemr")
  const { activation, selected } = yield* selectRuntime(snapshot, (selected) =>
    activate(config.endpoint, selected, command._tag === "Update", false, reconcileOwner(config.memory.directory)).pipe(
      Effect.tapError(() =>
        printResponse(ActivationFailure, {
          installed: true,
          command: path,
          selectedBuild: selected.implementation,
          activation: "failed",
          serving: null,
          recovery:
            "Inspect the diagnostic; explicitly stop a legacy resident if requested, then repeat update or restart. Registrations and memory are preserved"
        })
      )
    )
  )
  yield* printResponse(Installed, {
    installed: true,
    command: path,
    runtime: selection.runtime,
    profile: selection.profile,
    activation: command._tag === "Update" ? "immediate" : "first-native-hook",
    nativeTrust: "approve-in-host-if-required",
    selectedBuild: selected.implementation,
    serving: activation.serving,
    restarted: activation.changed
  })
})

const reconcileOwner = (directory: string) => (observed: Parameters<typeof authorizeSnapshot>[0]) =>
  authorizeSnapshot(observed, directory, artifactFiles).pipe(
    Effect.mapError(
      () =>
        new TransportError({
          message: "Endpoint does not match a verified installation for this memory directory; refusing shutdown",
          retryable: false
        })
    )
  )
