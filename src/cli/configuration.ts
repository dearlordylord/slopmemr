import { homedir } from "node:os"
import { join } from "node:path"
import { Config, Effect, Option } from "effect"
import { defaultConcurrency, defaultPerAuthConcurrency, defaultAttemptTimeoutMs } from "../compaction/limits.js"
import { defaultMaximumRoots } from "../memory/limits.js"
import { endpoint } from "../resident/endpoint.js"

export const configuration = Effect.gen(function* () {
  const runtimeDirectory = yield* Config.NonEmptyString("SLOPMEMR_RUNTIME_DIR").pipe(
    Config.withDefault(endpoint().directory)
  )
  const dataDirectory = yield* Config.NonEmptyString("SLOPMEMR_DATA_DIR").pipe(
    Config.withDefault(join(homedir(), ".local", "share", "slopmemr"))
  )
  const callerHome = yield* Config.option(Config.NonEmptyString("CODEX_HOME"))
  const callerClaudeHome = yield* Config.NonEmptyString("CLAUDE_CONFIG_DIR").pipe(
    Config.withDefault(join(homedir(), ".claude"))
  )
  const fallback = yield* Config.option(Config.NonEmptyString("SLOPMEMR_CODEX_HOME"))
  const claudeFallback = yield* Config.option(Config.NonEmptyString("SLOPMEMR_CLAUDE_HOME"))
  const compactor = {
    executable: yield* Config.NonEmptyString("SLOPMEMR_CODEX_BIN").pipe(Config.withDefault("codex")),
    model: yield* Config.NonEmptyString("SLOPMEMR_MODEL").pipe(Config.withDefault("gpt-6-luna")),
    concurrency: yield* Config.Int("SLOPMEMR_COMPACTION_CONCURRENCY").pipe(Config.withDefault(defaultConcurrency)),
    perAuthConcurrency: yield* Config.Int("SLOPMEMR_AUTH_CONCURRENCY").pipe(
      Config.withDefault(defaultPerAuthConcurrency)
    ),
    timeoutMs: yield* Config.Int("SLOPMEMR_COMPACTION_TIMEOUT_MS").pipe(Config.withDefault(defaultAttemptTimeoutMs)),
    ...(Option.isSome(fallback) ? { fallbackHome: fallback.value } : {})
  }
  return {
    endpoint: endpoint(runtimeDirectory),
    memory: {
      directory: dataDirectory,
      maxRoots: yield* Config.Int("SLOPMEMR_MAX_ROOTS").pipe(Config.withDefault(defaultMaximumRoots))
    },
    compactor,
    claudeCompactor: {
      executable: yield* Config.NonEmptyString("SLOPMEMR_CLAUDE_BIN").pipe(Config.withDefault("claude")),
      concurrency: compactor.concurrency,
      perAuthConcurrency: compactor.perAuthConcurrency,
      timeoutMs: compactor.timeoutMs,
      ...(Option.isSome(claudeFallback) ? { fallbackHome: claudeFallback.value } : {})
    },
    callerClaudeHome,
    callerHome: Option.getOrElse(callerHome, () => join(homedir(), ".codex"))
  }
})
