import { makeCapacity, makeCapacityUnsafe, type Capacity } from "./capacity.js"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import type { CompressionRequest, Observation } from "@firfi/unii"
import { CompactionError, instructions, prompt } from "./compactor.js"
import type { Interface } from "./compactor.js"
import type { AuthReference } from "./profile.js"
import { runClaude } from "./claude-process.js"
import {
  defaultConcurrency,
  defaultPerAuthConcurrency,
  defaultAttemptTimeoutMs,
  maximumAuthProfiles
} from "./limits.js"

export class ClaudeCompactor extends Context.Service<ClaudeCompactor, Interface>()("slopmemr/ClaudeCompactor") {}

const Account = Schema.Struct({
  loggedIn: Schema.Literal(true),
  authMethod: Schema.Literal("claude.ai"),
  apiProvider: Schema.Literal("firstParty"),
  forcedLoginMethod: Schema.Literal("claudeai"),
  configDirectory: Schema.String,
  subscriptionType: Schema.NonEmptyString
})
const Envelope = Schema.Struct({ type: Schema.String })
const Initialization = Schema.Struct({ tools: Schema.Array(Schema.String), mcp_servers: Schema.Array(Schema.Json) })
const RateLimit = Schema.Struct({
  rate_limit_info: Schema.Struct({ status: Schema.Literals(["allowed", "allowed_warning"]) })
})
const Assistant = Schema.Struct({
  message: Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.String })) })
})
const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Counters = Schema.Struct({
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  cache_read_input_tokens: Schema.optionalKey(TokenCount),
  cache_creation_input_tokens: Schema.optionalKey(TokenCount)
})
const Result = Schema.Struct({
  subtype: Schema.Literal("success"),
  is_error: Schema.Literal(false),
  result: Schema.NonEmptyString,
  num_turns: Schema.Literal(1),
  usage: Counters,
  modelUsage: Schema.Record(Schema.String, Schema.Json)
})
const settings = JSON.stringify({ forceLoginMethod: "claudeai", disableAllHooks: true, apiKeyHelper: "", env: {} })
const restrictions = ["--safe-mode", "--restricted", "--settings", settings]

export interface Options {
  readonly executable?: string
  readonly concurrency?: number
  readonly perAuthConcurrency?: number
  readonly timeoutMs?: number
  readonly fallbackHome?: string
}

const collector = (emit: (event: Observation) => void) => {
  let initialized = false
  let result: string | undefined
  const receive = (line: string) => {
    const value: unknown = JSON.parse(line)
    const event = Schema.decodeUnknownSync(Envelope)(value)
    switch (event.type) {
      case "system": {
        verifyInitialization(value)
        initialized = true
        break
      }
      case "assistant": {
        verifyAssistant(value)
        break
      }
      case "result": {
        if (!initialized || result !== undefined) throw new Error("Unexpected Claude result")
        result = completeSummary(value, emit)
        break
      }
      case "rate_limit_event":
        Schema.decodeUnknownSync(RateLimit)(value)
        break
      default:
        throw new Error("Unsupported Claude compactor event")
    }
  }
  return {
    receive,
    summary: () => {
      if (!result) throw new Error("Claude did not complete with summary text")
      return result
    }
  }
}

const verifyInitialization = (value: unknown): void => {
  const initialization = Schema.decodeUnknownSync(Initialization)(value)
  if (initialization.tools.length !== 0 || initialization.mcp_servers.length !== 0)
    throw new Error("Claude compactor exposes tools or MCP")
}

const verifyAssistant = (value: unknown): void => {
  const assistant = Schema.decodeUnknownSync(Assistant)(value)
  if (assistant.message.content.some((item) => !["text", "thinking", "redacted_thinking"].includes(item.type)))
    throw new Error("Claude compactor attempted an action")
}

const completeSummary = (value: unknown, emit: (event: Observation) => void): string => {
  const completed = Schema.decodeUnknownSync(Result)(value)
  const models = Object.keys(completed.modelUsage)
  if (models.length !== 1 || !models.every((model) => /^claude-haiku-/u.test(model)))
    throw new Error("Claude compactor substituted a non-Haiku model")
  emit({
    kind: "usage",
    scope: "attempt",
    counters: {
      input: completed.usage.input_tokens,
      output: completed.usage.output_tokens,
      cachedInput: completed.usage.cache_read_input_tokens ?? 0,
      cacheWriteInput: completed.usage.cache_creation_input_tokens ?? 0
    }
  })
  return completed.result.trim()
}

const summarize = async (
  executable: string,
  home: string,
  request: CompressionRequest,
  emit: (event: Observation) => void,
  signal: AbortSignal,
  directory: string
): Promise<string> => {
  const base = { executable, home, directory, signal }
  const account = Schema.decodeUnknownSync(Account)(
    JSON.parse(await runClaude({ ...base, args: [...restrictions, "auth", "status"], input: "" }))
  )
  if ((await realpath(account.configDirectory)) !== home) throw new Error("Claude used another profile")
  const output = collector(emit)
  const args = [
    ...restrictions,
    "--print",
    "--model",
    "haiku",
    "--effort",
    "low",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-chrome",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    instructions
  ]
  emit({ kind: "submission", payload: { modelTask: "memory-compaction", runtime: "claude", model: "haiku" } })
  await runClaude({ ...base, args, input: prompt(request), receive: output.receive })
  return output.summary()
}

interface Attempt {
  readonly directory: string
  readonly controller: AbortController
  pending?: Promise<string>
}

const acquireAttempt = async (): Promise<Attempt> => ({
  directory: await mkdtemp(join(tmpdir(), "slopmemr-claude-")),
  controller: new AbortController()
})

const closeAttempt = async (worker: Attempt): Promise<void> => {
  worker.controller.abort()
  await worker.pending?.catch(() => {})
  await rm(worker.directory, { recursive: true, force: true })
}

const attempt = (executable: string, home: string, request: CompressionRequest, emit: (event: Observation) => void) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: acquireAttempt,
      catch: () => new CompactionError({ message: "Cannot create Claude compactor scratch directory" })
    }),
    (worker) =>
      Effect.tryPromise({
        try: (signal) => {
          const abort = () => worker.controller.abort()
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          worker.pending = summarize(executable, home, request, emit, worker.controller.signal, worker.directory)
          return worker.pending.finally(() => signal.removeEventListener("abort", abort))
        },
        catch: () =>
          new CompactionError({
            message: "Claude Haiku compaction failed; check subscription login and CLI compatibility"
          })
      }),
    (worker) => Effect.promise(() => closeAttempt(worker))
  )

export const layer = (options: Options = {}) =>
  Layer.effect(
    ClaudeCompactor,
    Effect.gen(function* () {
      const concurrency = options.concurrency ?? defaultConcurrency
      const perAuth = options.perAuthConcurrency ?? defaultPerAuthConcurrency
      const timeoutMs = options.timeoutMs ?? defaultAttemptTimeoutMs
      if (![concurrency, perAuth, timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0))
        return yield* Effect.fail(new CompactionError({ message: "Claude compactor limits must be positive integers" }))
      const global = yield* makeCapacity(concurrency)
      const profiles = new Map<string, Capacity>()
      const compress = Effect.fn("ClaudeCompactor.compress")(function* (
        auth: AuthReference | undefined,
        request: CompressionRequest,
        emit: (event: Observation) => void
      ) {
        if (auth !== undefined && !("claudeHome" in auth))
          return yield* Effect.fail(new CompactionError({ message: "Codex profiles cannot use the Claude compactor" }))
        const requestedHome = auth?.claudeHome ?? options.fallbackHome
        if (requestedHome === undefined || !isAbsolute(requestedHome))
          return yield* Effect.fail(new CompactionError({ message: "No usable caller Claude profile selected" }))
        const home = yield* Effect.tryPromise({
          try: () => realpath(requestedHome),
          catch: () => new CompactionError({ message: "Caller Claude profile unavailable" })
        })
        const permit = yield* Effect.suspend(() => {
          const existing = profiles.get(home)
          if (existing !== undefined) return Effect.succeed(existing)
          if (profiles.size >= maximumAuthProfiles)
            return Effect.fail(new CompactionError({ message: "Claude auth profile capacity reached" }))
          const created = makeCapacityUnsafe(perAuth)
          profiles.set(home, created)
          return Effect.succeed(created)
        })
        const work = attempt(options.executable ?? "claude", home, request, emit).pipe(
          Effect.timeout(`${timeoutMs} millis`),
          Effect.mapError((error) =>
            error instanceof CompactionError ? error : new CompactionError({ message: "Claude compaction timed out" })
          )
        )
        return yield* permit.withPermit(global.withPermit(work))
      })
      return ClaudeCompactor.of({ compress })
    })
  )
