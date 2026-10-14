import { Schema } from "effect"
import { AbsolutePath } from "../local-state/contracts.js"

export const RecordIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Address = Schema.Struct({ level: RecordIndex, index: RecordIndex })
export const Receipt = Schema.Struct({
  firstId: RecordIndex,
  ids: Schema.Array(RecordIndex),
  endExclusive: RecordIndex
})
export const AppendResult = Schema.Struct({ root: AbsolutePath, receipt: Receipt, duplicate: Schema.Boolean })
const SnapshotCoverage = { before: RecordIndex, coveredThrough: RecordIndex, view: Schema.Array(Address) }
export const MemorySnapshot = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready"), ...SnapshotCoverage, text: Schema.String, bytes: RecordIndex }),
  Schema.Struct({
    state: Schema.Literals(["pending", "failed"]),
    ...SnapshotCoverage,
    text: Schema.Null,
    bytes: Schema.Null
  })
])
export const ZoomResult = Schema.Struct({ text: Schema.String, totalBytes: RecordIndex, pages: RecordIndex })
export const Usage = Schema.Struct({
  started: RecordIndex,
  input: RecordIndex,
  output: RecordIndex,
  cachedInput: RecordIndex,
  cacheWriteInput: RecordIndex,
  inputObserved: RecordIndex,
  outputObserved: RecordIndex,
  cachedInputObserved: RecordIndex,
  cacheWriteInputObserved: RecordIndex
})
export const MemoryStatus = Schema.Struct({
  count: RecordIndex,
  cursor: RecordIndex,
  active: RecordIndex,
  pending: RecordIndex,
  failed: Schema.Array(Schema.Struct({ node: Address, message: Schema.String })),
  storageError: Schema.NullOr(Schema.String),
  usage: Usage
})
export { ProjectRoot } from "../project-root/contracts.js"
