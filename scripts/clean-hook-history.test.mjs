import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { Memory } from "@firfi/unii"
import { SqliteStorage } from "../dist/memory/storage.js"
import { cleanHistory } from "./clean-hook-history.mjs"

const fixture = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr-clean-"))
  const key = "a".repeat(64)
  const storage = new SqliteStorage(join(directory, key), directory, key)
  await storage.open()
  try {
    await run({ directory, storage, key })
  } finally {
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  }
}
const record = (id, event, text) => ({
  id,
  kind: JSON.stringify({ runtime: "codex", sessionId: "s", agentId: "root", kind: event }),
  text: typeof text === "string" ? text : JSON.stringify(text),
  date: "2026-10-17T00:00:00.000Z"
})
const append = async (storage, records, key) =>
  storage.withEvent(key, "digest", { codexHome: "/profile" }, () => storage.appendRecords(records))

test("cleanup preserves useful originals, auth, summaries and replay receipts with dense IDs; repeat is inert", async () =>
  fixture(async ({ directory, storage }) => {
    const inputs = [
      record(0, "SessionStart", { event: "SessionStart" }),
      record(1, "UserPromptSubmit", { event: "UserPromptSubmit", prompt: "remember this" }),
      record(2, "Stop", { event: "Stop" }),
      record(3, "SubagentStop", { event: "SubagentStop", assistant: "  " }),
      record(4, "Stop", { event: "Stop", assistant: "useful answer" }),
      record(5, "Stop", "partial legacy text")
    ]
    for (const value of inputs) {
      await append(storage, [value], `e${value.id}`)
      await storage.appendNode({ level: 0, index: value.id, text: `summary${value.id}` })
    }
    await storage.appendNode({ level: 1, index: 0, text: "combined" })
    await storage.close()
    const result = await Effect.runPromise(cleanHistory(directory))
    assert.equal(result.removed, 3)
    await storage.open()
    const state = await storage.load()
    assert.deepEqual(
      state.records,
      [inputs[1], inputs[4], inputs[5]].map((r, id) => ({ ...r, id }))
    )
    assert.deepEqual(
      state.nodes.map((n) => [n.level, n.index, n.text]),
      [
        [0, 0, "summary1"],
        [0, 1, "summary4"],
        [0, 2, "summary5"]
      ]
    )
    assert.equal(storage.findEvent("e0", "digest"), undefined)
    assert.deepEqual(storage.findEvent("e4", "digest"), { firstId: 1, ids: [1], endExclusive: 2 })
    assert.deepEqual(storage.authForRecord(1), { codexHome: "/profile" })
    await storage.close()
    assert.equal((await Effect.runPromise(cleanHistory(directory))).removed, 0)
    await storage.open()
    assert.deepEqual(await storage.load(), state)
    await storage.close()
    const memory = await Memory.open({ storage })
    try {
      assert.equal(memory.status().count, 3)
      assert.equal(memory.snapshot().coveredThrough, 3)
      assert.ok(memory.zoom(1, 1).text.includes("useful answer"))
    } finally {
      await memory.close()
    }
  }))

test("live owner refuses cleanup without mutation", async () =>
  fixture(async ({ directory, storage }) => {
    await append(storage, [record(0, "SessionStart", { event: "SessionStart" })], "e")
    await assert.rejects(Effect.runPromise(cleanHistory(directory)), /busy or invalid/)
    assert.equal((await storage.load()).records.length, 1)
  }))

test("invalid receipt aborts the transaction and preserves records", async () =>
  fixture(async ({ directory, storage }) => {
    await append(storage, [record(0, "SessionStart", { event: "SessionStart" })], "e")
    await storage.close()
    const db = new DatabaseSync(join(storage.directory, "memory.sqlite"))
    db.prepare("UPDATE events SET receipt=?").run(JSON.stringify({ firstId: 0, ids: [0, 1], endExclusive: 2 }))
    db.close()
    await assert.rejects(Effect.runPromise(cleanHistory(directory)), /rolled back/)
    await storage.open()
    assert.equal((await storage.load()).records.length, 1)
  }))

test("a mixed event batch is retained atomically", async () =>
  fixture(async ({ directory, storage }) => {
    await append(
      storage,
      [record(0, "SessionStart", { event: "SessionStart" }), record(1, "Stop", { event: "Stop", assistant: "useful" })],
      "mixed"
    )
    await storage.close()
    assert.equal((await Effect.runPromise(cleanHistory(directory))).removed, 0)
    await storage.open()
    assert.deepEqual(storage.findEvent("mixed", "digest"), { firstId: 0, ids: [0, 1], endExclusive: 2 })
  }))
