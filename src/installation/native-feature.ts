import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import { InstallationError, type Selection } from "./contracts.js"

const execute = promisify(execFile)
const featureDeadlineMs = 5_000
const maximumFeatureOutputKibibytes = 64
const maximumFeatureOutputBytes = maximumFeatureOutputKibibytes * 1024

/** Codex owns TOML parsing and persistence. This never logs in or starts inference. */
export const enableHooks = Effect.fn("Installation.enableHooks")(function* (selection: Selection, executable: string) {
  if (selection.runtime !== "codex") return
  yield* Effect.tryPromise({
    try: async () => {
      await execute(executable, ["features", "enable", "hooks"], {
        timeout: featureDeadlineMs,
        maxBuffer: maximumFeatureOutputBytes,
        env: { ...process.env, CODEX_HOME: selection.profile, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined }
      })
    },
    catch: () =>
      new InstallationError({
        operation: "native-feature",
        message: "Cannot enable native Codex hooks in the selected profile; inspect Codex configuration"
      })
  })
})
