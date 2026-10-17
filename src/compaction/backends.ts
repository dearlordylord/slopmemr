import { Effect, Layer } from "effect"
import { CompactionError, Compactor } from "./compactor.js"
import { ClaudeCompactor, layer as claudeLayer } from "./claude.js"
import type { Options as ClaudeOptions } from "./claude.js"
import { layer as codexLayer } from "./codex.js"
import type { Options as CodexOptions } from "./codex.js"
import { authRuntime } from "./profile.js"
import { makeCapacity } from "./capacity.js"
import { defaultConcurrency } from "./limits.js"

/** Root memory remains shared. Inference never falls back across runtimes. */
export const routing = () =>
  Layer.effect(
    Compactor,
    Effect.gen(function* () {
      const codex = yield* Compactor
      const claude = yield* ClaudeCompactor
      return Compactor.of({
        compress: Effect.fn("Compactor.route")(function* (auth, request, emit, runtime) {
          const selected = runtime ?? (auth === undefined ? "codex" : authRuntime(auth))
          if (auth !== undefined && authRuntime(auth) !== selected)
            return yield* Effect.fail(
              new CompactionError({ message: "Login profile does not match the source agent runtime" })
            )
          if (selected !== "codex" && selected !== "claude")
            return yield* Effect.fail(new CompactionError({ message: "Unsupported source agent runtime" }))
          return yield* (selected === "codex" ? codex : claude).compress(auth, request, emit, selected)
        })
      })
    })
  )

export const layer = (codex: CodexOptions = {}, claude: ClaudeOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const concurrency = codex.concurrency ?? defaultConcurrency
      if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
        return yield* Effect.fail(new CompactionError({ message: "Shared compaction capacity must be positive" }))
      const shared = yield* makeCapacity(concurrency)
      return routing().pipe(Layer.provide(codexLayer(codex, shared)), Layer.provide(claudeLayer(claude, shared)))
    })
  )
