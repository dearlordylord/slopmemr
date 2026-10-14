import { fileURLToPath } from "node:url"
import { ConfigProvider, Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { program } from "./program.js"
import { reportFailure } from "./output.js"

const nodeArgumentPrefixLength = 2

NodeRuntime.runMain(
  program(process.argv.slice(nodeArgumentPrefixLength), {
    executable: process.execPath,
    entrypoint: fileURLToPath(import.meta.url)
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
    Effect.catch(reportFailure)
  )
)
