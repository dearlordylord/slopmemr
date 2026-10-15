import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { Config, Console, Effect, Schema } from "effect"
import { AbsolutePath } from "../local-state/contracts.js"
import { InputError, readJson } from "../local-state/input.js"
import type { ProcessLaunch } from "../local-state/process-launch.js"
import { endpoint } from "../resident/endpoint.js"
import { send } from "../resident/startup.js"
import { maxFrameBytes } from "../resident/limits.js"
import { Hook, normalize, shouldCapture } from "./hook.js"
import type { Options as HookOptions } from "./hook.js"
import { ownerMarker } from "./ownership.js"
import { nativeOutput } from "./guidance.js"

const launchFields = {
  root: Schema.optionalKey(AbsolutePath),
  residentBin: Schema.optionalKey(AbsolutePath),
  residentEntry: Schema.optionalKey(AbsolutePath)
}
const Options = Schema.Union([
  Schema.Struct({ runtime: Schema.Literal("codex"), codexHome: Schema.optionalKey(AbsolutePath), ...launchFields }),
  Schema.Struct({ runtime: Schema.Literal("claude"), claudeHome: Schema.optionalKey(AbsolutePath), ...launchFields })
])
const keys: Readonly<Record<string, string>> = {
  "codex-home": "codexHome",
  "claude-home": "claudeHome",
  "resident-bin": "residentBin",
  "resident-entry": "residentEntry"
}
type Options = typeof Options.Type
const homes = {
  codex: { key: "CODEX_HOME", directory: ".codex" },
  claude: { key: "CLAUDE_CONFIG_DIR", directory: ".claude" }
}
const hookOptions = (options: Options, home: string): HookOptions => ({
  runtime: options.runtime,
  ...(options.root === undefined ? {} : { root: options.root }),
  auth:
    options.runtime === "codex" ? { codexHome: options.codexHome ?? home } : { claudeHome: options.claudeHome ?? home }
})
const residentLaunch = (options: Options, fallback: ProcessLaunch): ProcessLaunch => ({
  executable: options.residentBin ?? fallback.executable,
  entrypoint: options.residentEntry ?? fallback.entrypoint
})

const parse = Effect.fn("Hook.arguments")(function* (args: ReadonlyArray<string>) {
  const values = yield* Effect.try({
    try: () =>
      parseArgs({
        args: [...args],
        allowPositionals: false,
        options: {
          runtime: { type: "string" },
          root: { type: "string" },
          "codex-home": { type: "string" },
          "claude-home": { type: "string" },
          "resident-bin": { type: "string" },
          "resident-entry": { type: "string" },
          "hook-owner": { type: "string" }
        }
      }).values,
    catch: () => new InputError({ message: "Invalid hook arguments" })
  })
  if (values["hook-owner"] !== undefined && values["hook-owner"] !== ownerMarker)
    return yield* Effect.fail(new InputError({ message: "Invalid hook ownership marker" }))
  const mapped = Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => key !== "hook-owner")
      .map(([key, value]) => [keys[key] ?? key, value])
  )
  return yield* Schema.decodeUnknownEffect(Options, { onExcessProperty: "error" })(mapped)
})

const execute = Effect.fn("Hook.execute")(function* (
  args: ReadonlyArray<string>,
  resident: ProcessLaunch,
  source: AsyncIterable<unknown>
) {
  const options = yield* parse(args)
  const hook = yield* Schema.decodeUnknownEffect(Hook)(yield* readJson(source, maxFrameBytes))
  if (!shouldCapture(hook)) return
  const paths = endpoint(
    yield* Config.NonEmptyString("SLOPMEMR_RUNTIME_DIR").pipe(Config.withDefault(endpoint().directory))
  )
  const profile = homes[options.runtime]
  const home = yield* Config.NonEmptyString(profile.key).pipe(Config.withDefault(join(homedir(), profile.directory)))
  const input = normalize(hook, hookOptions(options, home), yield* Effect.sync(randomUUID))
  yield* send(paths, { _tag: "Append", ...input }, residentLaunch(options, resident))
  const output = nativeOutput(options.runtime, hook.hook_event_name, input.root)
  if (output !== undefined) yield* Console.log(output)
})

export const program = Effect.fn("Hook.program")(
  (args: ReadonlyArray<string>, resident: ProcessLaunch, source: AsyncIterable<unknown>) =>
    execute(args, resident, source).pipe(Effect.timeout("2500 millis"))
)
