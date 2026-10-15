import { failureDetails } from "./failures.js"
import { Result } from "effect"
import type { Memory } from "@firfi/unii"
import { AvailableSnapshot, AvailableZoom, ReadStatus, parseBoundary, parseZoom, zoomFailure } from "./reading.js"
import type { Processing, MemoryReadError } from "./reading.js"
import { binaryTreeBranchCount } from "./limits.js"

type Reader = Pick<Memory, "snapshot" | "status" | "date" | "nodes" | "zoom">
type Options = { readonly before?: number; readonly view?: "main" | "compaction" }

const processing = (status: ReturnType<Memory["status"]>): Processing => ({
  state: status.active > 0 ? "updating" : status.pending > 0 ? "waiting" : "idle",
  active: status.active,
  pending: status.pending,
  failed: status.failed.map(({ message, node }) => ({ node, ...failureDetails(message) })),
  storageAvailable: status.storageError === null
})

const recordedAt = (memory: Reader, boundary: number): string | null => {
  if (boundary === 0) return null
  const value = memory.date(boundary - 1)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null
}

const freshness = (memory: Reader, requested: number, covered: number) => ({
  latestRecordAt: recordedAt(memory, requested),
  coveredRecordAt: recordedAt(memory, covered)
})

export const availableSnapshot = (
  memory: Reader,
  options: Options = {}
): Result.Result<AvailableSnapshot, MemoryReadError> => {
  const status = memory.status()
  return Result.map(parseBoundary(options.before, status.count), (boundary) => {
    const requested = memory.snapshot({ ...options, before: boundary.before })
    const covered =
      requested.coveredThrough === requested.before
        ? requested
        : memory.snapshot({ ...options, before: requested.coveredThrough })
    const text = requested.coveredThrough === 0 ? "" : (covered.text ?? "")
    return AvailableSnapshot.make({
      text,
      bytes: Buffer.byteLength(text),
      view: covered.view,
      requestedThrough: requested.before,
      coveredThrough: requested.coveredThrough,
      totalRecords: status.count,
      coverage:
        requested.coveredThrough === requested.before ? "current" : requested.coveredThrough === 0 ? "empty" : "behind",
      freshness: freshness(memory, requested.before, requested.coveredThrough),
      processing: processing(status)
    })
  })
}

export const readingStatus = (memory: Reader): ReadStatus => {
  const status = memory.status()
  return ReadStatus.make({
    count: status.count,
    cursor: status.cursor,
    freshness: freshness(memory, status.count, status.cursor),
    processing: processing(status)
  })
}

export const availableZoom = (
  memory: Reader,
  first: number,
  count: number,
  page = 0
): Result.Result<AvailableZoom, MemoryReadError> => {
  const status = memory.status()
  return Result.flatMap(parseZoom(first, count, page, status.count), ({ count, first, page }) => {
    if (count === 1)
      return Result.map(
        Result.try({ try: () => memory.zoom(first, count, { page }), catch: zoomFailure }),
        (original) =>
          AvailableZoom.make({
            kind: "record",
            first,
            count: 1,
            ...original,
            page,
            recordedAt: recordedAt(memory, first + 1),
            processing: processing(status)
          })
      )
    const level = Math.log2(count) - 1
    const half = count / binaryTreeBranchCount
    const nodes = new Map(memory.nodes().map((node) => [`${node.level}:${node.index}`, node.text]))
    const child = (start: number): Extract<AvailableZoom, { kind: "children" }>["children"][number] => {
      const text = nodes.get(`${level}:${start / half}`) ?? null
      const failed = status.failed.some(({ node }) => node.level === level && node.index === start / half)
      return text !== null
        ? { first: start, count: half, state: "ready", text }
        : { first: start, count: half, state: failed ? "failed" : "pending", text: null }
    }
    return Result.succeed(
      AvailableZoom.make({
        kind: "children",
        first,
        count,
        children: [child(first), child(first + half)],
        processing: processing(status)
      })
    )
  })
}
