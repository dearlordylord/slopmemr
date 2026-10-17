import { Effect } from "effect"
import { makeCapacity, makeCapacityUnsafe } from "./capacity.js"
import type { Capacity } from "./capacity.js"
import { CompactionError } from "./compactor.js"
import { maximumAuthProfiles } from "./limits.js"

export const makeAdmission = (concurrency: number, perAuth: number, shared?: Capacity) =>
  Effect.gen(function* () {
    const global = shared ?? (yield* makeCapacity(concurrency))
    const profiles = new Map<string, Capacity>()
    const profile = Effect.fn("Compaction.profileAdmission")((home: string) =>
      Effect.suspend(() => {
        const existing = profiles.get(home)
        if (existing !== undefined) return Effect.succeed(existing)
        if (profiles.size >= maximumAuthProfiles)
          return Effect.fail(new CompactionError({ message: "Auth profile capacity reached" }))
        const created = makeCapacityUnsafe(perAuth)
        profiles.set(home, created)
        return Effect.succeed(created)
      })
    )
    return {
      withPermit: <A, E, R>(home: string, work: Effect.Effect<A, E, R>) =>
        Effect.flatMap(profile(home), (permit) => permit.withPermit(global.withPermit(work)))
    }
  })
