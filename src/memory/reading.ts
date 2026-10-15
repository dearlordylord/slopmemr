import { SummaryFailure } from "./failures.js"
import { Schema, Result } from "effect"
import { AbsolutePath } from "../local-state/contracts.js"
import { RecordIndex, Address, ProjectRoot } from "./views.js"

const Root = AbsolutePath.annotate({
  description: "Absolute project root. Linked Git worktrees share the primary root's memory."
})
const Index = RecordIndex.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const SnapshotInput = Schema.Struct({
  root: Root,
  before: Schema.optionalKey(
    Index.annotate({
      description: "Exclusive record boundary: read [0,before). Defaults to the current record count; never clamped."
    })
  ),
  view: Schema.optionalKey(
    Schema.Literals(["main", "compaction"]).annotate({
      description:
        "Two representations of the same full prefix. Default main; compaction is more compact, not relevance filtering."
    })
  )
})
export const ZoomInput = Schema.Struct({
  root: Root,
  first: Index.annotate({ description: "First zero-based record ID. Must be divisible by count." }),
  count: Index.check(Schema.isGreaterThan(0)).annotate({
    description:
      "Aligned power-of-two span, not a result limit. 1 reads the original; larger spans reveal two child summaries."
  }),
  page: Schema.optionalKey(
    Index.annotate({
      description: "Zero-based original-text page for count=1. For larger ranges only page=0 is valid."
    })
  )
})
export const StatusInput = Schema.Struct({ root: Root })
export const ReadRequest = Schema.TaggedUnion({
  Roots: {},
  ReadSnapshot: SnapshotInput.fields,
  ReadZoom: ZoomInput.fields,
  ReadStatus: StatusInput.fields
})
export type ReadRequest = typeof ReadRequest.Type
export const RootsResult = Schema.Array(ProjectRoot)
export const Processing = Schema.Struct({
  state: Schema.Literals(["updating", "waiting", "idle"]),
  active: Index,
  pending: Index,
  failed: Schema.Array(SummaryFailure),
  storageAvailable: Schema.Boolean
})
export type Processing = typeof Processing.Type
export const Freshness = Schema.Struct({
  latestRecordAt: Schema.NullOr(Schema.String),
  coveredRecordAt: Schema.NullOr(Schema.String)
})
export const AvailableSnapshot = Schema.Struct({
  text: Schema.String,
  bytes: Index,
  view: Schema.Array(Address),
  requestedThrough: Index,
  coveredThrough: Index,
  totalRecords: Index,
  coverage: Schema.Literals(["current", "behind", "empty"]),
  freshness: Freshness,
  processing: Processing
})
export type AvailableSnapshot = typeof AvailableSnapshot.Type
export const ReadStatus = Schema.Struct({ count: Index, cursor: Index, freshness: Freshness, processing: Processing })
export type ReadStatus = typeof ReadStatus.Type
const Child = Schema.Union([
  Schema.Struct({ first: Index, count: Index, state: Schema.Literal("ready"), text: Schema.String }),
  Schema.Struct({ first: Index, count: Index, state: Schema.Literals(["pending", "failed"]), text: Schema.Null })
])
export const AvailableZoom = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("children"),
    first: Index,
    count: Index,
    children: Schema.Tuple([Child, Child]),
    processing: Processing
  }),
  Schema.Struct({
    kind: Schema.Literal("record"),
    first: Index,
    count: Schema.Literal(1),
    text: Schema.String,
    totalBytes: Index,
    pages: Index,
    page: Index,
    recordedAt: Schema.NullOr(Schema.String),
    processing: Processing
  })
])
export type AvailableZoom = typeof AvailableZoom.Type
export const ReadResult = Schema.Union([RootsResult, AvailableSnapshot, ReadStatus, AvailableZoom])
export type ReadResult = typeof ReadResult.Type
export const ReadCode = Schema.Literals([
  "INVALID_INPUT",
  "INVALID_BOUNDARY",
  "INVALID_RANGE",
  "INVALID_PAGE",
  "RANGE_NOT_READY",
  "ROOT_UNAVAILABLE",
  "RESIDENT_UNAVAILABLE"
])
export const ReadFailure = Schema.Struct({ code: ReadCode, message: Schema.String, retryable: Schema.Boolean })
export class MemoryReadError extends Schema.TaggedError<MemoryReadError>()("MemoryReadError", ReadFailure.fields) {}

const Boundary = Schema.Struct({ before: Index }).pipe(Schema.brand("ReadBoundary"))
const Range = Schema.Struct({ first: Index, count: Index, page: Index }).pipe(Schema.brand("ReadRange"))
export const parseBoundary = (
  before: number | undefined,
  count: number
): Result.Result<typeof Boundary.Type, MemoryReadError> => {
  const boundary = before ?? count
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > count)
    return Result.fail(
      new MemoryReadError({
        code: "INVALID_BOUNDARY",
        message: "before must be an exclusive boundary between 0 and the record count",
        retryable: false
      })
    )
  return Result.succeed(Boundary.make({ before: boundary }))
}
export const parseZoom = (
  first: number,
  count: number,
  page: number,
  available: number
): Result.Result<typeof Range.Type, MemoryReadError> => {
  if (!validRange(first, count, available))
    return Result.fail(
      new MemoryReadError({
        code: "INVALID_RANGE",
        message: "Choose an existing aligned power-of-two record range; first must be divisible by count",
        retryable: false
      })
    )
  if (!Number.isSafeInteger(page) || page < 0 || (count > 1 && page !== 0))
    return Result.fail(
      new MemoryReadError({
        code: "INVALID_PAGE",
        message: "Pages are zero-based; ranges larger than one record have only page 0",
        retryable: false
      })
    )
  return Result.succeed(Range.make({ first, count, page }))
}

const nonnegativeIndex = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const validRange = (first: number, count: number, available: number): boolean =>
  nonnegativeIndex(first) &&
  nonnegativeIndex(count) &&
  count > 0 &&
  Number.isInteger(Math.log2(count)) &&
  first % count === 0 &&
  count <= available - first

export const zoomFailure = (cause: unknown): MemoryReadError => {
  if (cause instanceof MemoryReadError) return cause
  if (cause instanceof Error && cause.message === "Invalid page")
    return new MemoryReadError({
      code: "INVALID_PAGE",
      message: "The requested original-text page does not exist",
      retryable: false
    })
  if (cause instanceof Error && cause.message === "Unbuilt range")
    return new MemoryReadError({
      code: "RANGE_NOT_READY",
      message: "Child summaries are not ready; inspect status or read originals with count=1",
      retryable: true
    })
  return new MemoryReadError({ code: "ROOT_UNAVAILABLE", message: "Project memory is unavailable", retryable: false })
}
