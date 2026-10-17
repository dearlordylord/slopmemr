import { Schema } from "effect"
import type { CompressionRequest, Observation } from "@firfi/unii"
import type { AppServer, Notification } from "./app-server.js"
import { prompt } from "./compactor.js"

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
const isFinalMessage = (item: typeof ItemEvent.Type.item): boolean =>
  item.type === "agentMessage" && item.text !== undefined && item.phase !== "commentary"

export const runTurn = async (
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
