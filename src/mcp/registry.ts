import { Context, Effect, Schema } from "effect"
import * as McpServer from "effect/ai/McpServer"
import * as McpSchema from "effect/ai/McpSchema"
import { MemoryReadError } from "../memory/reading.js"
import { catalog, jsonSchema } from "./catalog.js"
import { Reader } from "./reader.js"

const result = (value: Schema.Json, isError: boolean) =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError
  })

export const register: () => Effect.Effect<void, Schema.SchemaError, McpServer.McpServer | Reader> = Effect.fn(
  "MCP.register"
)(function* () {
  const server = yield* McpServer.McpServer
  const reader = yield* Reader
  for (const entry of catalog) {
    const tool = new McpSchema.Tool({
      name: entry.name,
      description: entry.description,
      inputSchema: yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(jsonSchema(entry.input)),
      outputSchema: yield* Schema.decodeUnknownEffect(McpSchema.ToolOutputJson)(
        jsonSchema(Schema.Struct({ result: entry.output }))
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    })
    const handle = Effect.fn("MCP.read")(function* (input: unknown) {
      const request = yield* entry
        .decode(input ?? {})
        .pipe(
          Effect.mapError(
            () =>
              new MemoryReadError({
                code: "INVALID_INPUT",
                message: "Arguments do not match this tool's schema",
                retryable: false
              })
          )
        )
      const value = yield* reader.read(request)
      return yield* Schema.decodeUnknownEffect(Schema.Json)({ result: value }).pipe(
        Effect.map((payload) => result(payload, false)),
        Effect.mapError(
          () =>
            new MemoryReadError({
              code: "RESIDENT_UNAVAILABLE",
              message: "Memory response cannot be encoded",
              retryable: false
            })
        )
      )
    })
    yield* server.addTool({
      tool,
      annotations: Context.empty(),
      handle: (input: unknown) =>
        handle(input).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              result({ error: { code: error.code, message: error.message, retryable: error.retryable } }, true)
            )
          )
        )
    })
  }
})
