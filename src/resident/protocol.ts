import { Schema } from "effect"
import { AppendResult, MemorySnapshot, ZoomResult, MemoryStatus, ProjectRoot } from "../memory/views.js"
import { Ping } from "./identity.js"
import { Append } from "../memory/contracts.js"
import { AbsolutePath } from "../local-state/contracts.js"
import { maximumSettleWaitMs } from "../memory/limits.js"

const Root = AbsolutePath
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Request = Schema.TaggedUnion({
  Ping: {},
  Shutdown: {},
  Append: Append.fields,
  Snapshot: {
    root: Root,
    before: Schema.optionalKey(Index),
    view: Schema.optionalKey(Schema.Literals(["main", "compaction"]))
  },
  Zoom: { root: Root, first: Index, count: Schema.Int.check(Schema.isGreaterThan(0)), page: Schema.optionalKey(Index) },
  Status: { root: Root },
  Settle: { root: Root, waitMs: Schema.optionalKey(Index.check(Schema.isLessThanOrEqualTo(maximumSettleWaitMs))) },
  Roots: {}
})
export type Request = typeof Request.Type

const ShutdownResult = Schema.Struct({ stopping: Schema.Literal(true) })
const RootsResult = Schema.Array(ProjectRoot)
export const responseSchemas: Readonly<Record<Request["_tag"], Schema.ConstraintDecoder<unknown>>> = {
  Ping,
  Shutdown: ShutdownResult,
  Append: AppendResult,
  Snapshot: MemorySnapshot,
  Zoom: ZoomResult,
  Status: MemoryStatus,
  Settle: MemorySnapshot,
  Roots: RootsResult
}
export const ResponsePayload = Schema.Union([
  Ping,
  ShutdownResult,
  AppendResult,
  MemorySnapshot,
  ZoomResult,
  MemoryStatus,
  RootsResult
])
export const Response = Schema.TaggedUnion({ Success: { value: ResponsePayload }, Failure: { message: Schema.String } })
export type Response = typeof Response.Type

export { maxFrameBytes } from "./limits.js"
