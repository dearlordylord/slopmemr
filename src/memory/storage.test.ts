import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { SqliteStorage } from "./storage.js"

const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "slopmemr-store-"))
  fixtures.push(directory)
  return directory
}
const record = { id: 0, kind: "user", text: "Remember me", date: "2026-10-12T00:00:00.000Z" }

it("holds exclusive writer ownership and atomically persists receipts with records", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  const other = new SqliteStorage(directory, "/root")
  await storage.open()
  try {
    await expect(other.open()).rejects.toThrow()
    await storage.withEvent("event", "digest", { codexHome: "/profile" }, () => storage.appendRecords([record]))
    expect(storage.findEvent("event", "digest")).toEqual({ firstId: 0, ids: [0], endExclusive: 1 })
    expect(storage.authForRecord(0)).toEqual({ codexHome: "/profile" })
    expect(() => storage.findEvent("event", "different")).toThrow("different content")
    // The second insert violates contiguity after the first would have succeeded.
    await expect(
      storage.appendRecords([
        { ...record, id: 1 },
        { ...record, id: 99 }
      ])
    ).rejects.toThrow()
    expect((await storage.load()).records).toHaveLength(1)
  } finally {
    await storage.close()
  }
  await other.open()
  try {
    expect((await other.load()).records).toEqual([record])
  } finally {
    await other.close()
  }
})

it("rejects corrupt persisted records and another root's ownership", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  await storage.open()
  await storage.appendRecords([record])
  await storage.close()
  const db = new DatabaseSync(join(directory, "memory.sqlite"))
  db.prepare("UPDATE records SET value=? WHERE id=0").run('{"id":"bad"}')
  db.close()
  await storage.open()
  try {
    await expect(storage.load()).rejects.toThrow()
  } finally {
    await storage.close()
  }
  await expect(new SqliteStorage(directory, "/other").open()).rejects.toThrow("different root")
})

it("enforces immutable nodes and private directory ownership", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  await storage.open()
  try {
    await storage.appendRecords([record])
    await storage.appendNode({ level: 0, index: 0, text: "summary" })
    await expect(storage.appendNode({ level: 0, index: 0, text: "rewrite" })).rejects.toThrow()
  } finally {
    await storage.close()
  }
})

it("rejects a structurally valid receipt that overstates committed coverage", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  await storage.open()
  await storage.withEvent("event", "digest", undefined, () => storage.appendRecords([record]))
  await storage.close()
  const db = new DatabaseSync(join(directory, "memory.sqlite"))
  db.prepare("UPDATE events SET receipt=? WHERE key='event'").run(
    JSON.stringify({ firstId: 0, ids: [0, 1], endExclusive: 2 })
  )
  db.close()
  await storage.open()
  try {
    expect(() => storage.findEvent("event", "digest")).toThrow("committed contiguous")
  } finally {
    await storage.close()
  }
})

it("rejects closed storage, duplicate open, concurrent event scopes and empty event commits", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  await storage.close()
  await expect(storage.load()).rejects.toThrow("Storage closed")
  await storage.open()
  try {
    await expect(storage.open()).rejects.toThrow("already open")
    await expect(
      storage.withEvent("outer", "d", undefined, () =>
        storage.withEvent("inner", "d", undefined, () => storage.appendRecords([record]))
      )
    ).rejects.toThrow("Concurrent event")
    await expect(storage.withEvent("empty", "d", undefined, () => storage.appendRecords([]))).rejects.toThrow(
      "Empty event"
    )
    expect(storage.findEvent("empty", "d")).toBeUndefined()
    expect(() => storage.authForRecord(0)).toThrow("Missing compression source")
    await storage.appendRecords([record])
    expect(storage.authForRecord(0)).toBeUndefined()
  } finally {
    await storage.close()
  }
})

const corruptRow = async (directory: string, sql: string, value: string | Buffer): Promise<void> => {
  const db = new DatabaseSync(join(directory, "memory.sqlite"))
  try {
    db.prepare(sql).run(value)
  } finally {
    db.close()
  }
}
for (const [name, sql, value] of [
  ["record row identity", "UPDATE records SET value=? WHERE id=0", JSON.stringify({ ...record, id: 1 })],
  ["nontext record payload", "UPDATE records SET value=? WHERE id=0", Buffer.from("binary")],
  [
    "node row identity",
    "UPDATE nodes SET value=? WHERE level=0 AND idx=0",
    JSON.stringify({ level: 0, index: 1, text: "node" })
  ]
] as const)
  it(`rejects corrupted ${name} during load`, async () => {
    const directory = await fixture()
    const storage = new SqliteStorage(directory, "/root")
    await storage.open()
    await storage.appendRecords([record])
    await storage.appendNode({ level: 0, index: 0, text: "node" })
    await storage.close()
    await corruptRow(directory, sql, value)
    await storage.open()
    try {
      await expect(storage.load()).rejects.toThrow()
    } finally {
      await storage.close()
    }
  })

for (const receipt of [
  { firstId: -1, ids: [0], endExclusive: 1 },
  { firstId: 0, ids: [], endExclusive: 0 },
  { firstId: 0, ids: [1], endExclusive: 1 },
  { firstId: 0, ids: [0], endExclusive: 2 }
])
  it(`rejects a corrupt receipt ${JSON.stringify(receipt)}`, async () => {
    const directory = await fixture()
    const storage = new SqliteStorage(directory, "/root")
    await storage.open()
    await storage.withEvent("event", "digest", undefined, () => storage.appendRecords([record]))
    await storage.close()
    await corruptRow(directory, "UPDATE events SET receipt=? WHERE key='event'", JSON.stringify(receipt))
    await storage.open()
    try {
      expect(() => storage.findEvent("event", "digest")).toThrow()
    } finally {
      await storage.close()
    }
  })

it("rejects unsupported persistence versions, corrupted auth references and unsafe database paths", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  await storage.open()
  await storage.appendRecords([record])
  await storage.close()
  await corruptRow(directory, "UPDATE records SET auth_home=? WHERE id=0", Buffer.from("invalid"))
  await storage.open()
  try {
    expect(() => storage.authForRecord(0)).toThrow("Corrupt auth")
  } finally {
    await storage.close()
  }
  const db = new DatabaseSync(join(directory, "memory.sqlite"))
  db.exec("PRAGMA user_version=2")
  db.close()
  await expect(storage.open()).rejects.toThrow("Unsupported memory format")
  await rm(join(directory, "memory.sqlite"))
  await mkdir(join(directory, "memory.sqlite"))
  await expect(storage.open()).rejects.toThrow("Unsafe database")
})

it("upgrades legacy rows and discards foreign Claude auth while preserving Codex references and raw text", async () => {
  const directory = await fixture()
  const storage = new SqliteStorage(directory, "/root")
  await storage.open()
  await storage.withEvent("codex", "digest", { codexHome: "/codex" }, () => storage.appendRecords([record]))
  await storage.withEvent("claude", "digest", { codexHome: "/wrong-codex" }, () =>
    storage.appendRecords([{ ...record, id: 1, kind: JSON.stringify({ runtime: "claude" }) }])
  )
  await storage.close()
  const db = new DatabaseSync(join(directory, "memory.sqlite"))
  db.exec("ALTER TABLE records DROP COLUMN auth_reference")
  db.close()
  await storage.open()
  try {
    expect(storage.authForRecord(0)).toEqual({ codexHome: "/codex" })
    expect(storage.authForRecord(1)).toBeUndefined()
    expect(storage.runtimeForRecord(1)).toBe("claude")
    expect((await storage.load()).records[1]?.text).toBe("Remember me")
    await storage.withEvent("new-claude", "digest", { claudeHome: "/claude" }, () =>
      storage.appendRecords([{ ...record, id: 2, kind: JSON.stringify({ runtime: "claude" }) }])
    )
    expect(storage.authForRecord(2)).toEqual({ claudeHome: "/claude" })
  } finally {
    await storage.close()
  }
})
