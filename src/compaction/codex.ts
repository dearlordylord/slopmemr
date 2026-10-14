import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Effect, Layer, Schema, Semaphore } from "effect"
import type { CompressionRequest, Observation } from "@firfi/unii"
import type { AuthReference } from "./profile.js"
import { AppServer, disabledFeatures } from "./app-server.js"
import type { Notification } from "./app-server.js"
import {
  defaultConcurrency,
  defaultPerAuthConcurrency,
  defaultAttemptTimeoutMs,
  maximumAuthProfiles,
  maximumModelPages
} from "./limits.js"
import { CompactionError, Compactor, instructions, prompt } from "./compactor.js"

const Thread = Schema.Struct({ thread: Schema.Struct({ id: Schema.NonEmptyString }) })
const ModelPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ model: Schema.String })),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String))
})
const ItemEvent = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Struct({
    type: Schema.String,
    text: Schema.optionalKey(Schema.String),
    phase: Schema.optionalKey(Schema.NullOr(Schema.String))
  })
})
const Completed = Schema.Struct({ threadId: Schema.String, turn: Schema.Struct({ status: Schema.String }) })
const Usage = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: Schema.Struct({
    total: Schema.Struct({
      inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      cachedInputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    })
  })
})
const EffectiveConfig = Schema.Struct({
  config: Schema.Struct({
    model_provider: Schema.Literal("openai"),
    forced_login_method: Schema.Literal("chatgpt"),
    openai_base_url: Schema.Literal("https://chatgpt.com/backend-api/codex"),
    chatgpt_base_url: Schema.Literal("https://chatgpt.com/backend-api/"),
    web_search: Schema.String,
    features: Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Union([Schema.Boolean, Schema.Struct({ enabled: Schema.Boolean })]))
    ),
    mcp_servers: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }))
    )
  })
})
const Account = Schema.Struct({
  account: Schema.optionalKey(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
  requiresOpenaiAuth: Schema.Boolean
})
const AccountUpdate = Schema.Struct({ authMode: Schema.optionalKey(Schema.NullOr(Schema.String)) })

const initialize = async (server: AppServer) => {
  await server.request("initialize", {
    clientInfo: { name: "slopmemr", version: "0.1.0" },
    capabilities: { experimentalApi: true }
  })
  server.notify("initialized")
  const account = Schema.decodeUnknownSync(Account)(await server.request("account/read", { refreshToken: false }))
  if (account.account?.type !== "chatgpt" || !account.requiresOpenaiAuth) {
    throw new CompactionError({
      message: "Compaction requires the caller's ChatGPT login; API-key profiles are unsupported"
    })
  }
  server.notifications.on("notification", (notification: Notification) => {
    if (notification.method !== "account/updated") return
    try {
      const update = Schema.decodeUnknownSync(AccountUpdate)(notification.params)
      if (update.authMode !== undefined && update.authMode !== "chatgpt") {
        server.invalidate("Compactor authentication changed away from ChatGPT")
      }
    } catch {
      server.invalidate("Invalid compactor authentication update")
    }
  })
  const effective = Schema.decodeUnknownSync(EffectiveConfig)(
    await server.request("config/read", { includeLayers: false, cwd: server.directory })
  )
  if (
    effective.config.web_search !== "disabled" ||
    disabledFeatures.some((feature) => {
      const value = effective.config.features[feature]
      return value !== false && !(typeof value === "object" && value !== null && value.enabled === false)
    })
  )
    throw new Error("Compactor restrictions not applied")
  return effective.config.mcp_servers ?? {}
}

export interface Options {
  readonly executable?: string
  readonly model?: string
  readonly concurrency?: number
  readonly perAuthConcurrency?: number
  readonly timeoutMs?: number
  readonly fallbackHome?: string
}

const isFinalMessage = (item: typeof ItemEvent.Type.item): boolean =>
  item.type === "agentMessage" && item.text !== undefined && item.phase !== "commentary"

const runTurn = async (
  server: AppServer,
  threadId: string,
  request: CompressionRequest,
  emit: (event: Observation) => void,
  signal: AbortSignal
): Promise<string> => {
  let finalText = ""
  let resolveTurn: (text: string) => void = () => {}
  let rejectTurn: (cause: Error) => void = () => {}
  const completed = new Promise<string>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })
  // Install before turn/start: a fast server can complete before its RPC reply.
  const item = (event: Notification): void => {
    const data = Schema.decodeUnknownSync(ItemEvent)(event.params)
    if (data.threadId !== threadId) return
    if (!["userMessage", "agentMessage", "reasoning"].includes(data.item.type))
      throw new Error("Compactor attempted a tool or unsupported action")
    if (event.method === "item/completed" && isFinalMessage(data.item)) finalText = data.item.text ?? ""
  }
  const turn = (event: Notification): void => {
    const data = Schema.decodeUnknownSync(Completed)(event.params)
    if (data.threadId !== threadId) return
    if (data.turn.status !== "completed" || !finalText.trim())
      rejectTurn(new Error("Compaction did not complete with summary text"))
    else resolveTurn(finalText)
  }
  const usage = (event: Notification): void => {
    const data = Schema.decodeUnknownSync(Usage)(event.params)
    if (data.threadId !== threadId) return
    emit({
      kind: "usage",
      scope: "attempt",
      counters: {
        input: data.tokenUsage.total.inputTokens,
        output: data.tokenUsage.total.outputTokens,
        cachedInput: data.tokenUsage.total.cachedInputTokens
      }
    })
  }
  const handlers: Readonly<Record<string, (event: Notification) => void>> = {
    "item/started": item,
    "item/completed": item,
    "turn/completed": turn,
    "thread/tokenUsage/updated": usage
  }
  const notification = (event: Notification) => {
    try {
      handlers[event.method]?.(event)
    } catch {
      rejectTurn(new Error("Malformed or unsupported compactor notification"))
    }
  }
  const failure = () => rejectTurn(new Error("Compactor transport failed"))
  const aborted = () => rejectTurn(new Error("Compaction interrupted"))
  server.notifications.on("notification", notification)
  server.notifications.on("failure", failure)
  signal.addEventListener("abort", aborted, { once: true })
  // A rejection may arrive while turn/start is outstanding; attach immediately.
  const result = completed.then((value) => value)
  void result.catch(() => {})
  try {
    if (signal.aborted) throw new Error("Compaction interrupted")
    const params = {
      threadId,
      input: [{ type: "text", text: prompt(request), text_elements: [] }],
      effort: "low",
      environments: []
    }
    emit({ kind: "submission", payload: { modelTask: "memory-compaction", ...params } })
    await server.request("turn/start", params)
    return await result
  } finally {
    server.notifications.off("notification", notification)
    server.notifications.off("failure", failure)
    signal.removeEventListener("abort", aborted)
  }
}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Compactor,
    Effect.gen(function* () {
      const concurrency = options.concurrency ?? defaultConcurrency
      const perAuth = options.perAuthConcurrency ?? defaultPerAuthConcurrency
      const timeoutMs = options.timeoutMs ?? defaultAttemptTimeoutMs
      if (![concurrency, perAuth, timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
        return yield* Effect.fail(new CompactionError({ message: "Compactor limits must be positive integers" }))
      }
      const global = yield* Semaphore.make(concurrency)
      const servers = new Set<AppServer>()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...servers].map((server) => server.close()))
        })
      )
      // These are reusable capacity permits, not worker credentials. Eviction while
      // active could multiply per-profile capacity, so retain a bounded registry.
      const profiles = new Map<string, Semaphore.Semaphore>()
      const compress = Effect.fn("Compactor.compress")(function* (
        auth: AuthReference | undefined,
        request: CompressionRequest,
        emit: (event: Observation) => void
      ) {
        if (auth !== undefined && !("codexHome" in auth))
          return yield* Effect.fail(new CompactionError({ message: "Claude profiles cannot use the Codex compactor" }))
        const requestedHome = auth?.codexHome ?? options.fallbackHome
        if (requestedHome === undefined || !isAbsolute(requestedHome)) {
          return yield* Effect.fail(new CompactionError({ message: "No usable caller Codex profile selected" }))
        }
        const home = yield* Effect.tryPromise({
          try: () => realpath(requestedHome),
          catch: () => new CompactionError({ message: "Caller Codex profile unavailable" })
        })
        const permit = yield* Effect.suspend(() => {
          const existing = profiles.get(home)
          if (existing !== undefined) return Effect.succeed(existing)
          if (profiles.size >= maximumAuthProfiles)
            return Effect.fail(new CompactionError({ message: "Auth profile capacity reached" }))
          const created = Semaphore.makeUnsafe(perAuth)
          profiles.set(home, created)
          return Effect.succeed(created)
        })
        const acquire = (mcp: readonly string[]) =>
            Effect.tryPromise({
              try: () => AppServer.open(options.executable ?? "codex", home, mcp),
              catch: () => new CompactionError({ message: "Cannot start Codex compactor" })
            }).pipe(Effect.tap((server) => Effect.sync(() => servers.add(server)))),
          release = (server: AppServer) =>
            Effect.promise(async () => {
              try {
                await server.close()
              } finally {
                servers.delete(server)
              }
            })
        const summarize = (server: AppServer) =>
          Effect.tryPromise({
            try: async (signal) => {
              const model = options.model ?? "gpt-6-luna"
              let cursor: string | undefined
              let found = false
              for (let page = 0; page < maximumModelPages; page++) {
                const models = Schema.decodeUnknownSync(ModelPage)(
                  await server.request("model/list", cursor === undefined ? {} : { cursor })
                )
                found ||= models.data.some((item) => item.model === model)
                if (found || models.nextCursor == null) break
                cursor = models.nextCursor
              }
              if (!found) throw new Error("Configured compactor model unavailable")
              const thread = Schema.decodeUnknownSync(Thread)(
                await server.request("thread/start", {
                  model,
                  allowProviderModelFallback: false,
                  ephemeral: true,
                  cwd: server.directory,
                  modelProvider: "openai",
                  approvalPolicy: "never",
                  sandbox: "read-only",
                  environments: [],
                  baseInstructions: instructions,
                  developerInstructions: instructions
                })
              )
              return runTurn(server, thread.thread.id, request, emit, signal)
            },
            catch: () =>
              new CompactionError({
                message: "Codex compaction failed; check profile, model availability, and protocol compatibility"
              })
          })
        const inspect = (server: AppServer) =>
          Effect.tryPromise({
            try: () => initialize(server),
            catch: (cause) =>
              cause instanceof CompactionError
                ? cause
                : new CompactionError({ message: "Cannot verify compactor restrictions" })
          })
        const work = Effect.acquireUseRelease(
          acquire([]),
          (discovery) =>
            Effect.gen(function* () {
              const mcp = yield* inspect(discovery)
              const names = Object.keys(mcp)
              if (names.length === 0) return yield* summarize(discovery)
              yield* release(discovery)
              return yield* Effect.acquireUseRelease(
                acquire(names),
                (server) =>
                  Effect.gen(function* () {
                    const effective = yield* inspect(server)
                    if (Object.values(effective).some((entry) => entry.enabled !== false)) {
                      return yield* Effect.fail(
                        new CompactionError({ message: "Inherited MCP servers remain enabled" })
                      )
                    }
                    return yield* summarize(server)
                  }),
                release
              )
            }),
          release
        ).pipe(
          Effect.timeout(`${timeoutMs} millis`),
          Effect.mapError((error) =>
            error instanceof CompactionError ? error : new CompactionError({ message: "Codex compaction timed out" })
          )
        )
        return yield* permit.withPermit(global.withPermit(work))
      })
      return Compactor.of({ compress })
    })
  )
