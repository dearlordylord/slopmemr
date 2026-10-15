import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader, layer } from "./reader.js"
import { TransportError } from "../resident/endpoint.js"

it.effect("validates resident payloads and preserves only public transport failures", () =>
  Effect.gen(function* () {
    const roots = yield* Effect.gen(function* () {
      return yield* (yield* Reader).read({ _tag: "Roots" })
    }).pipe(Effect.provide(layer(() => Effect.succeed([]))))
    expect(roots).toEqual([])
    for (const error of [
      new TransportError({ message: "private" }),
      new TransportError({ code: "ROOT_UNAVAILABLE", message: "Public failure", retryable: false })
    ]) {
      const failure = yield* Effect.gen(function* () {
        return yield* (yield* Reader).read({ _tag: "Roots" }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer(() => Effect.fail(error))))
      expect(failure.message).not.toContain("private")
    }
    const invalid = yield* Effect.gen(function* () {
      return yield* (yield* Reader).read({ _tag: "Roots" }).pipe(Effect.flip)
    }).pipe(Effect.provide(layer(() => Effect.succeed("invalid"))))
    expect(invalid.retryable).toBe(false)
  })
)
