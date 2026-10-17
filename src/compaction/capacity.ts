import { Effect, PartitionedSemaphore } from "effect"

export const makeCapacityUnsafe = (permits: number) => {
  const semaphore = PartitionedSemaphore.makeUnsafe<"compaction">({ permits })
  return { withPermit: semaphore.withPermit("compaction") }
}
export const makeCapacity = (permits: number) => Effect.sync(() => makeCapacityUnsafe(permits))
export type Capacity = ReturnType<typeof makeCapacityUnsafe>
