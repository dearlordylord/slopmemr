import { Schema } from "effect"
import { AppendResult, MemorySnapshot, ZoomResult, MemoryStatus, ProjectRoot } from "../memory/views.js"
import { Ping, ServingIdentity } from "./identity.js"
import { Append } from "../memory/contracts.js"
import { AbsolutePath } from "../local-state/contracts.js"
import { maximumSettleWaitMs } from "../memory/limits.js"
import {
  SnapshotInput,
  ZoomInput,
  StatusInput,
  ReadCode,
  AvailableSnapshot,
  AvailableZoom,
  ReadStatus
} from "../memory/reading.js"

const Root = AbsolutePath
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Request = Schema.TaggedUnion({
  Ping: {},
  Shutdown: { expected: Schema.optionalKey(ServingIdentity) },
  Append: Append.fields,
  Snapshot: SnapshotInput.fields,
  Zoom: ZoomInput.fields,
  Status: StatusInput.fields,
  ReadSnapshot: SnapshotInput.fields,
  ReadZoom: ZoomInput.fields,
  ReadStatus: StatusInput.fields,
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
  ReadSnapshot: AvailableSnapshot,
  ReadZoom: AvailableZoom,
  ReadStatus,
  Settle: MemorySnapshot,
  Roots: RootsResult
}
export const ResponsePayload = Schema.Union([
  AvailableSnapshot,
  AvailableZoom,
  ReadStatus,
  Ping,
  ShutdownResult,
  AppendResult,
  MemorySnapshot,
  ZoomResult,
  MemoryStatus,
  RootsResult
])
export const Response = Schema.TaggedUnion({
  Success: { value: ResponsePayload },
  Failure: { message: Schema.String, code: Schema.optionalKey(ReadCode), retryable: Schema.optionalKey(Schema.Boolean) }
})
export type Response = typeof Response.Type

export { maxFrameBytes } from "./limits.js"
