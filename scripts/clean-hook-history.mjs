// Explicit beta maintenance: requires exclusive storage ownership; never reads token stores.
import { DatabaseSync } from "node:sqlite"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { Effect, Schema } from "effect"
import { Hook, shouldCapture } from "../dist/intake/hook.js"
import { HookEvent } from "../dist/intake/events.js"
import { Agent, AuthReference } from "../dist/memory/contracts.js"
import { AbsolutePath } from "../dist/local-state/contracts.js"
import {
  JournalRecord,
  Node,
  ReceiptSchema,
  SqliteStorage,
  storedRoots,
  validateReceipt
} from "../dist/memory/storage.js"

const Provenance = Schema.Struct({ ...Agent.fields, kind: HookEvent })
const TerminalObservation = Schema.Struct({
  event: HookEvent,
  assistant: Schema.optionalKey(Schema.NullOr(Schema.String))
})
const RecordRow = Schema.Struct({
  id: Schema.Int,
  value: Schema.String,
  auth_home: Schema.NullOr(Schema.String),
  auth_reference: Schema.NullOr(Schema.String)
})
const EventRow = Schema.Struct({ key: Schema.String, digest: Schema.String, receipt: Schema.String })
const decode = (schema, text) => Schema.decodeUnknownSync(schema)(JSON.parse(text))

const retain = (record) => {
  try {
    const provenance = decode(Provenance, record.kind)
    if (!["SessionStart", "Stop", "SubagentStop"].includes(provenance.kind)) return true
    const base = {
      hook_event_name: provenance.kind,
      session_id: provenance.sessionId,
      cwd: "/",
      agent_id: provenance.agentId
    }
    if (provenance.kind === "SessionStart") return shouldCapture(Hook.make(base))
    // Partial long-message chunks and legacy/noncanonical payloads are never discarded.
    const text = Schema.decodeUnknownSync(TerminalObservation, { onExcessProperty: "error" })(JSON.parse(record.text))
    if (text.event !== provenance.kind) return true
    return shouldCapture(
      Hook.make({ ...base, ...(text.assistant === undefined ? {} : { last_assistant_message: text.assistant }) })
    )
  } catch {
    return true
  }
}

const readPlan = (db) => {
  const rows = db
    .prepare("SELECT id,value,auth_home,auth_reference FROM records ORDER BY id")
    .all()
    .map((row, index) => {
      const value = Schema.decodeUnknownSync(RecordRow)(row)
      const record = decode(JournalRecord, value.value)
      if (record.id !== value.id || record.id !== index) throw new Error("Noncontiguous record history")
      if (value.auth_home !== null) Schema.decodeUnknownSync(AbsolutePath)(value.auth_home)
      if (value.auth_reference !== null) decode(AuthReference, value.auth_reference)
      return { ...value, record }
    })
  const events = db
    .prepare("SELECT key,digest,receipt FROM events")
    .all()
    .map((row) => {
      const value = Schema.decodeUnknownSync(EventRow)(row)
      const receipt = decode(ReceiptSchema, value.receipt)
      validateReceipt(receipt)
      if (receipt.endExclusive > rows.length) throw new Error("Receipt outside committed history")
      return { ...value, receipt }
    })
  const discarded = new Set(rows.filter(({ record }) => !retain(record)).map(({ id }) => id))
  for (const { receipt } of events) {
    if (receipt.ids.some((id) => discarded.has(id)) && receipt.ids.some((id) => !discarded.has(id)))
      for (const id of receipt.ids) discarded.delete(id)
  }
  const kept = rows.filter(({ id }) => !discarded.has(id))
  const indices = new Map(kept.map(({ id }, index) => [id, index]))
  const receipts = events.flatMap((event) => {
    const ids = event.receipt.ids.flatMap((id) => (indices.has(id) ? [indices.get(id)] : []))
    const firstId = ids[0]
    if (firstId === undefined) return []
    const receipt = { firstId, ids, endExclusive: firstId + ids.length }
    validateReceipt(receipt)
    return [{ key: event.key, digest: event.digest, receipt }]
  })
  const nodes = db
    .prepare("SELECT level,idx,value FROM nodes")
    .all()
    .flatMap((row) => {
      const node = decode(Node, row.value)
      if (
        node.level !== row.level ||
        node.index !== row.idx ||
        node.level < 0 ||
        node.index < 0 ||
        !Number.isSafeInteger((node.index + 1) * 2 ** node.level) ||
        (node.index + 1) * 2 ** node.level > rows.length
      )
        throw new Error("Invalid summary address")
      const index = indices.get(node.index)
      return node.level === 0 && index !== undefined ? [{ ...node, index }] : []
    })
  return { before: rows.length, removed: discarded.size, kept, receipts, nodes }
}

const rewrite = (directory) => {
  const db = new DatabaseSync(join(directory, "memory.sqlite"))
  try {
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE")
    try {
      const plan = readPlan(db)
      if (plan.removed > 0) {
        db.exec("DELETE FROM records; DELETE FROM events; DELETE FROM nodes; DELETE FROM checkpoint;")
        const record = db.prepare("INSERT INTO records(id,value,auth_home,auth_reference) VALUES (?,?,?,?)")
        plan.kept.forEach((row, id) =>
          record.run(id, JSON.stringify({ ...row.record, id }), row.auth_home, row.auth_reference)
        )
        const event = db.prepare("INSERT INTO events(key,digest,receipt) VALUES (?,?,?)")
        for (const row of plan.receipts) event.run(row.key, row.digest, JSON.stringify(row.receipt))
        const node = db.prepare("INSERT INTO nodes(level,idx,value) VALUES (?,?,?)")
        for (const row of plan.nodes) node.run(row.level, row.index, JSON.stringify(row))
      }
      db.exec("COMMIT")
      return {
        before: plan.before,
        removed: plan.removed,
        after: plan.kept.length,
        retainedLeafSummaries: plan.nodes.length
      }
    } catch (cause) {
      db.exec("ROLLBACK")
      throw cause
    }
  } finally {
    db.close()
  }
}

export const cleanHistory = (directory) =>
  Effect.gen(function* () {
    const roots = yield* Effect.try({
      try: () => storedRoots(directory),
      catch: () => new Error("Cannot inspect memory pools")
    })
    const results = []
    for (const root of roots) {
      const storage = new SqliteStorage(join(directory, root.key), root.path, root.key)
      const result = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => storage.open(),
          catch: () => new Error("Memory pool is busy or invalid; stop the resident before cleanup")
        }),
        () =>
          Effect.try({
            try: () => rewrite(storage.directory),
            catch: () => new Error("Cannot rewrite memory pool; transaction rolled back")
          }),
        () => Effect.promise(() => storage.close())
      )
      results.push({ key: root.key, ...result })
    }
    return { pools: results, removed: results.reduce((sum, row) => sum + row.removed, 0) }
  })

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { positionals } = parseArgs({ allowPositionals: true, options: {} })
    if (positionals.length !== 1) throw new Error("Supply the memory data directory")
    const directory = Schema.decodeUnknownSync(AbsolutePath)(positionals[0])
    process.stdout.write(JSON.stringify(await Effect.runPromise(cleanHistory(directory))) + "\n")
  } catch {
    process.stderr.write("History cleanup failed; stop the resident and inspect storage ownership/data.\n")
    process.exitCode = 1
  }
}
