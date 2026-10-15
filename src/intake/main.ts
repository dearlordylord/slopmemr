import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigProvider, Console, Effect } from "effect"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { program } from "./program.js"

const commandArgumentOffset = 2
NodeRuntime.runMain(
  program(
    process.argv.slice(commandArgumentOffset),
    { executable: process.execPath, entrypoint: join(dirname(fileURLToPath(import.meta.url)), "slopmemr.mjs") },
    process.stdin
  ).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
    Effect.tapError(() => Console.error("slopmemr hook could not confirm durable intake; inspect resident status"))
  ),
  { disableErrorReporting: true }
)
