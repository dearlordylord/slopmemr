import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { makeCapacity } from "./capacity.js"

it.effect("reserves profile admission for older work when shared capacity remains available", () =>
  Effect.gen(function* () {
    const shared = yield* makeCapacity(8)
    const profile = yield* makeCapacity(1)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const admitted = (name: string) => shared.withPermit(profile.withPermit(Effect.sync(() => calls.push(name))))
    const holder = shared.withPermit(
      profile.withPermit(
        Effect.gen(function* () {
          calls.push("holder")
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        })
      )
    )
    const busy = yield* Effect.gen(function* () {
      yield* holder
      for (let index = 0; index < 20; index++) yield* admitted("new busy-project job")
    }).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const waiting = yield* admitted("older waiting project").pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(busy)
    yield* Fiber.join(waiting)
    expect(calls[1]).toBe("older waiting project")
    expect(calls).toHaveLength(22)
  }).pipe(Effect.scoped)
)
