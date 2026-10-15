import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { makeDrain } from "./drain.js"

it.effect("holds EOF open until every batch response has been written", () =>
  Effect.gen(function* () {
    const drain = yield* makeDrain({ frameBytes: 1024, requests: 4 })
    yield* drain.input(Buffer.from('[{"id":1},{"method":"notification"},{"id":"two"}]\n'))
    yield* drain.end
    const waiter = yield* drain.await.pipe(Effect.forkScoped)
    yield* drain.output('{"id":1}\n')
    expect(yield* Effect.sync(() => waiter.pollUnsafe())).toBeUndefined()
    yield* drain.output('[{"id":"two"}]\n')
    yield* Fiber.join(waiter)
  })
)

it.effect("reports frame and admission limits as typed failures, including incomplete frames", () =>
  Effect.gen(function* () {
    const bounded = yield* makeDrain({ frameBytes: 16, requests: 1 })
    expect((yield* bounded.input(Buffer.from("x".repeat(17))).pipe(Effect.flip)).reason).toBe("frame")
    const complete = yield* makeDrain({ frameBytes: 16, requests: 1 })
    expect((yield* complete.input(Buffer.from("x".repeat(17) + "\n")).pipe(Effect.flip)).reason).toBe("frame")
    const admitted = yield* makeDrain({ frameBytes: 1024, requests: 1 })
    expect((yield* admitted.input(Buffer.from('[{"id":1},{"id":2}]\n')).pipe(Effect.flip)).reason).toBe("requests")
  })
)
