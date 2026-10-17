import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { makeAdmission } from "./admission.js"
import { makeCapacity } from "./capacity.js"
import { defaultConcurrency, defaultPerAuthConcurrency } from "./limits.js"

it.effect("waiting for one profile does not occupy global capacity needed by another runtime", () =>
  Effect.gen(function* () {
    const shared = yield* makeCapacity(2)
    const codex = yield* makeAdmission(2, 1, shared)
    const claude = yield* makeAdmission(2, 1, shared)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const active = yield* codex
      .withPermit("codex-login", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const waiting = yield* codex.withPermit("codex-login", Effect.succeed("later")).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    expect(yield* claude.withPermit("claude-login", Effect.succeed("available"))).toBe("available")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(active)
    expect(yield* Fiber.join(waiting)).toBe("later")
  }).pipe(Effect.scoped)
)

it.effect("bounds all profiles to thirty attempts and each profile to five", () =>
  Effect.gen(function* () {
    expect(defaultConcurrency).toBe(30)
    expect(defaultPerAuthConcurrency).toBe(5)
    const admission = yield* makeAdmission(defaultConcurrency, defaultPerAuthConcurrency)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const counts = new Map<number, number>()
    let total = 0
    const fibers = []
    for (let profile = 0; profile < 6; profile++) {
      for (let job = 0; job < 6; job++) {
        const index = profile
        fibers.push(
          yield* admission
            .withPermit(
              String(profile),
              Effect.gen(function* () {
                counts.set(index, (counts.get(index) ?? 0) + 1)
                total++
                if (total === 30) yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                total--
                counts.set(index, (counts.get(index) ?? 0) - 1)
              })
            )
            .pipe(Effect.forkScoped)
        )
      }
    }
    yield* Deferred.await(entered)
    expect(total).toBe(30)
    expect([...counts.values()]).toEqual([5, 5, 5, 5, 5, 5])
    yield* Deferred.succeed(release, undefined)
    for (const fiber of fibers) yield* Fiber.join(fiber)
    expect(total).toBe(0)
  }).pipe(Effect.scoped)
)

it.effect("admits older work before a hot project reacquires capacity", () =>
  Effect.gen(function* () {
    const admission = yield* makeAdmission(1, 1)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const run = (name: string) =>
      admission.withPermit(
        "profile",
        Effect.sync(() => calls.push(name))
      )
    const hot = yield* Effect.gen(function* () {
      yield* admission.withPermit(
        "profile",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      )
      for (let job = 0; job < 20; job++) yield* run("new")
    }).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const older = yield* run("older").pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(hot)
    yield* Fiber.join(older)
    expect(calls[0]).toBe("older")
  }).pipe(Effect.scoped)
)

it.effect("cancels waiting and admitted work without losing capacity", () =>
  Effect.gen(function* () {
    const admission = yield* makeAdmission(1, 1)
    const entered = yield* Deferred.make<void>()
    const active = yield* admission
      .withPermit("profile", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const waiting = yield* admission.withPermit("profile", Effect.never).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(waiting)
    yield* Fiber.interrupt(active)
    expect(yield* admission.withPermit("profile", Effect.succeed("recovered"))).toBe("recovered")
  }).pipe(Effect.scoped)
)
