import { mkdtemp, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { CompressionRequest, Observation } from "@firfi/unii"
import { AppServer, disabledFeatures } from "./app-server.js"
import type { Notification } from "./app-server.js"
import { CompactionError, instructions } from "./compactor.js"
import { maximumModelPages } from "./limits.js"
import { runTurn } from "./codex-turn.js"

const Thread = Schema.Struct({ thread: Schema.Struct({ id: Schema.NonEmptyString }) })
const ModelPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ model: Schema.String })),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String))
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

const inspect = async (server: AppServer) => {
  const account = Schema.decodeUnknownSync(Account)(await server.request("account/read", { refreshToken: false }))
  if (account.account?.type !== "chatgpt" || !account.requiresOpenaiAuth) {
    throw new CompactionError({
      message: "Compaction requires the caller's ChatGPT login; API-key profiles are unsupported"
    })
  }
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

const initialize = async (server: AppServer) => {
  await server.request("initialize", {
    clientInfo: { name: "slopmemr", version: "0.1.4" },
    capabilities: { experimentalApi: true }
  })
  server.notify("initialized")
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
  return inspect(server)
}

export interface WorkerOptions {
  readonly executable?: string
  readonly model?: string
}

type ProfileGeneration = string

const profileGeneration = async (home: string): Promise<ProfileGeneration> =>
  JSON.stringify(
    await Promise.all(
      [join(home, "config.toml"), join(home, "auth.json"), "/etc/codex/config.toml"].map(async (path) => {
        try {
          const value = await stat(path, { bigint: true })
          return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String)
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null
          throw cause
        }
      })
    )
  )

const acquireServer = (home: string, options: WorkerOptions, mcp: readonly string[]) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => AppServer.open(options.executable ?? "codex", home, mcp),
      catch: () => new CompactionError({ message: "Cannot start Codex compactor" })
    }),
    (server) => Effect.promise(() => server.close())
  )

const verifyModel = async (server: AppServer, model: string): Promise<void> => {
  let cursor: string | undefined
  for (let page = 0; page < maximumModelPages; page++) {
    const models = Schema.decodeUnknownSync(ModelPage)(
      await server.request("model/list", cursor === undefined ? {} : { cursor })
    )
    if (models.data.some((item) => item.model === model)) return
    if (models.nextCursor == null) break
    cursor = models.nextCursor
  }
  throw new Error("Configured compactor model unavailable")
}

const inspectEffect = (server: AppServer) =>
  Effect.tryPromise({
    try: () => initialize(server),
    catch: (cause) =>
      cause instanceof CompactionError
        ? cause
        : new CompactionError({ message: "Cannot verify compactor restrictions" })
  })

export const acquireWorker = (home: string, options: WorkerOptions) =>
  Effect.gen(function* () {
    const generation = yield* Effect.tryPromise({
      try: () => profileGeneration(home),
      catch: () => new CompactionError({ message: "Caller Codex profile unavailable" })
    })
    const discovery = yield* acquireServer(home, options, [])
    const inherited = yield* inspectEffect(discovery)
    const names = Object.keys(inherited)
    const server = yield* Effect.gen(function* () {
      if (names.length === 0) return discovery
      yield* Effect.tryPromise({
        try: () => discovery.close(),
        catch: () => new CompactionError({ message: "Cannot replace discovery worker" })
      })
      const restricted = yield* acquireServer(home, options, names)
      const effective = yield* inspectEffect(restricted)
      if (Object.values(effective).some((entry) => entry.enabled !== false))
        return yield* Effect.fail(new CompactionError({ message: "Inherited MCP servers remain enabled" }))
      return restricted
    })
    const model = options.model ?? "gpt-6-luna"
    yield* Effect.tryPromise({
      try: () => verifyModel(server, model),
      catch: () => new CompactionError({ message: "Configured compactor model unavailable" })
    })
    return { server, home, generation, model }
  })
export type Worker = Effect.Success<ReturnType<typeof acquireWorker>>

const verifyMcp = (entries: Awaited<ReturnType<typeof inspect>>): void => {
  if (Object.values(entries).some((entry) => entry.enabled !== false))
    throw new Error("Inherited MCP servers remain enabled")
}

export const reusable = (worker: Worker) =>
  Effect.tryPromise({
    try: async () => {
      if (!worker.server.healthy || worker.generation !== (await profileGeneration(worker.home))) return false
      worker.server.beginAttempt()
      try {
        verifyMcp(await inspect(worker.server))
        return true
      } catch (cause) {
        if (!worker.server.healthy) return false
        throw cause
      }
    },
    catch: (cause) =>
      cause instanceof CompactionError ? cause : new CompactionError({ message: "Cannot verify reusable compactor" })
  })

const Unsubscribed = Schema.Struct({ status: Schema.Literals(["notLoaded", "notSubscribed", "unsubscribed"]) })
const summarize = async (
  worker: Worker,
  directory: string,
  request: CompressionRequest,
  emit: (event: Observation) => void,
  signal: AbortSignal
): Promise<string> => {
  const server = worker.server
  const thread = Schema.decodeUnknownSync(Thread)(
    await server.request("thread/start", {
      model: worker.model,
      allowProviderModelFallback: false,
      ephemeral: true,
      cwd: directory,
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      baseInstructions: instructions,
      developerInstructions: instructions
    })
  )
  const result = await runTurn(server, thread.thread.id, request, emit, signal)
  Schema.decodeUnknownSync(Unsubscribed)(await server.request("thread/unsubscribe", { threadId: thread.thread.id }))
  return result
}

export const useWorker = (worker: Worker, request: CompressionRequest, emit: (event: Observation) => void) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(worker.server.directory, "attempt-")),
      catch: () => new CompactionError({ message: "Cannot create compactor attempt directory" })
    }),
    (directory) =>
      Effect.tryPromise({
        try: (signal) => summarize(worker, directory, request, emit, signal),
        catch: (cause) =>
          cause instanceof CompactionError
            ? cause
            : new CompactionError({
                message: "Codex compaction failed; check profile, model availability, and protocol compatibility"
              })
      }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )
