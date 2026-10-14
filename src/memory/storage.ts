import { DatabaseSync } from "node:sqlite"
import { lstatSync, chmodSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import type { Checkpoint, MemoryRecord, Receipt, Storage, StoredMemory, Summary } from "@firfi/unii"
import { AuthReference } from "../compaction/profile.js"
import { AbsolutePath, Digest, privateFileMode } from "../local-state/contracts.js"
import { privateDirectory } from "../local-state/private-directory.js"
import { createHash } from "node:crypto"
import type { ProjectRoot } from "../project-root/root.js"

/** Adopt an existing path-keyed pool before publishing a permanent project ID. */
export const legacyPoolKey = async (directory: string, root: string): Promise<string | undefined> => {
  const key = createHash("sha256").update(root).digest("hex")
  return existsSync(join(directory, key, "memory.sqlite")) ? key : undefined
}

const Address = Schema.Struct({ level: Schema.Int, index: Schema.Int })
const JournalRecord = Schema.Struct({
  id: Schema.Int,
  kind: Schema.NonEmptyString,
  text: Schema.String,
  date: Schema.String
})
const Node = Schema.Struct({ level: Schema.Int, index: Schema.Int, text: Schema.String })
const CheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  cursor: Schema.Int,
  main: Schema.Array(Address),
  compaction: Schema.Array(Address),
  mainBatching: Schema.Boolean,
  compactionBatching: Schema.Boolean
})
const ReceiptSchema = Schema.Struct({ firstId: Schema.Int, ids: Schema.Array(Schema.Int), endExclusive: Schema.Int })

const database = (path: string, readOnly = false): DatabaseSync => {
  try {
    const stat = lstatSync(path)
    validateDatabaseFile(stat)
  } catch (cause) {
    if (!isMissing(cause) || readOnly) throw cause
  }
  const db = new DatabaseSync(path, { readOnly })
  if (!readOnly) chmodSync(path, privateFileMode)
  return db
}

/** Read-only pool discovery survives resident restarts and never runs a backend. */
export const storedRoots = (directory: string): ProjectRoot[] => {
  const roots: ProjectRoot[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue
    const pool = join(directory, entry.name)
    privateDirectory(pool)
    const db = database(join(pool, "memory.sqlite"), true)
    try {
      const value = db.prepare("SELECT value FROM metadata WHERE key='root'").get()?.value
      const root = Schema.decodeUnknownSync(AbsolutePath)(value)
      const key = poolIdentity(db, root)
      if (key !== entry.name) throw new Error("Invalid pool metadata")
      roots.push({ path: root, key })
    } finally {
      db.close()
    }
  }
  return roots.sort((a, b) => a.path.localeCompare(b.path))
}

/** SQLite's OS lock owns the writer lifetime. A separate database holds that
 * transaction so each UNII mutation can commit durably to the data database. */
export class SqliteStorage implements Storage {
  #db: DatabaseSync | undefined
  #ownership: DatabaseSync | undefined
  #event: { key: string; digest: string; auth: AuthReference | undefined } | undefined

  constructor(
    readonly directory: string,
    readonly root: string,
    readonly key?: string
  ) {}

  async open(): Promise<void> {
    if (this.#db !== undefined) throw new Error("Storage already open")
    privateDirectory(this.directory)
    const ownership = database(join(this.directory, "owner.sqlite"))
    try {
      ownership.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
      this.#ownership = ownership
      const db = database(join(this.directory, "memory.sqlite"))
      this.#db = db
      initializeDatabase(db, this.root, this.key)
    } catch (cause) {
      this.#db?.close()
      this.#db = undefined
      ownership.close()
      this.#ownership = undefined
      throw cause
    }
  }

  #database(): DatabaseSync {
    if (this.#db === undefined) throw new Error("Storage closed")
    return this.#db
  }

  relocate(root: string): void {
    this.#database().prepare("UPDATE metadata SET value=? WHERE key='root'").run(AbsolutePath.make(root))
  }

  #decode<A>(schema: Schema.Codec<A>, value: unknown): A {
    if (typeof value !== "string") throw new Error("Corrupt persisted row")
    return Schema.decodeUnknownSync(schema)(JSON.parse(value))
  }

  async load(): Promise<StoredMemory> {
    const db = this.#database()
    const row = db.prepare("SELECT value FROM checkpoint WHERE singleton=1").get()
    const records = db
      .prepare("SELECT id, value FROM records ORDER BY id")
      .all()
      .map((r) => {
        const value = this.#decode(JournalRecord, r.value)
        if (value.id !== r.id) throw new Error("Record identity does not match its row")
        return value
      })
    const nodes = db
      .prepare("SELECT level, idx, value FROM nodes ORDER BY level, idx")
      .all()
      .map((r) => {
        const value = this.#decode(Node, r.value)
        if (value.level !== r.level || value.index !== r.idx) throw new Error("Node identity does not match its row")
        return value
      })
    const decoded = row === undefined ? null : this.#decode(CheckpointSchema, row.value)
    const checkpoint =
      decoded === null ? null : { ...decoded, main: [...decoded.main], compaction: [...decoded.compaction] }
    return structuredClone({ records, nodes, checkpoint })
  }

  async appendRecords(records: readonly MemoryRecord[]): Promise<void> {
    const db = this.#database()
    db.exec("BEGIN IMMEDIATE")
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM records").get()?.count
      const insert = db.prepare("INSERT INTO records (id, value, auth_home, auth_reference) VALUES (?, ?, ?, ?)")
      const authHome = this.#authHome()
      for (const [index, record] of records.entries()) {
        if (typeof count !== "number" || record.id !== count + index) throw new Error("Noncontiguous record batch")
        insert.run(
          record.id,
          JSON.stringify(record),
          authHome,
          this.#event?.auth === undefined ? null : JSON.stringify(this.#event.auth)
        )
      }
      this.#recordEvent(db, records)
      db.exec("COMMIT")
    } catch (cause) {
      db.exec("ROLLBACK")
      throw cause
    }
  }

  #authHome(): string | null {
    const auth = this.#event?.auth
    return auth !== undefined && "codexHome" in auth ? auth.codexHome : null
  }

  #recordEvent(db: DatabaseSync, records: readonly MemoryRecord[]): void {
    if (this.#event === undefined) return
    const firstId = records[0]?.id
    if (firstId === undefined) throw new Error("Empty event batch")
    const receipt: Receipt = {
      firstId,
      ids: records.map((record) => record.id),
      endExclusive: firstId + records.length
    }
    db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(this.#event.key, this.#event.digest, JSON.stringify(receipt))
  }

  async appendNode(node: Summary): Promise<void> {
    this.#database().prepare("INSERT INTO nodes VALUES (?, ?, ?)").run(node.level, node.index, JSON.stringify(node))
  }

  async checkpoint(value: Checkpoint): Promise<void> {
    this.#database()
      .prepare("INSERT INTO checkpoint VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(value))
  }

  findEvent(key: string, digest: string): Receipt | undefined {
    const row = this.#database().prepare("SELECT digest, receipt FROM events WHERE key=?").get(key)
    if (row === undefined) return undefined
    if (row.digest !== digest) throw new Error("Event ID reused with different content")
    const receipt = this.#decode(ReceiptSchema, row.receipt)
    validateReceipt(receipt)
    const count = this.#database()
      .prepare("SELECT COUNT(*) AS count FROM records WHERE id >= ? AND id < ?")
      .get(receipt.firstId, receipt.endExclusive)?.count
    if (count !== receipt.ids.length)
      throw new Error("Event receipt does not cover a committed contiguous record batch")
    return { ...receipt, ids: [...receipt.ids] }
  }

  authForRecord(id: number): AuthReference | undefined {
    const row = this.#database().prepare("SELECT auth_home, auth_reference FROM records WHERE id=?").get(id)
    if (row === undefined) throw new Error("Missing compression source record")
    if (row.auth_reference !== null) return this.#decode(AuthReference, row.auth_reference)
    // Early versions attached Codex references to Claude observations. Never
    // reuse those: an explicit Claude fallback can recover their pending work.
    if (this.runtimeForRecord(id) === "claude") return undefined
    if (row.auth_home === null) return undefined
    if (typeof row.auth_home !== "string") throw new Error("Corrupt auth reference")
    return { codexHome: row.auth_home }
  }

  runtimeForRecord(id: number): string | undefined {
    const row = this.#database().prepare("SELECT value FROM records WHERE id=?").get(id)
    if (row === undefined) throw new Error("Missing compression source record")
    const record = this.#decode(JournalRecord, row.value)
    // Legacy direct UNII records had an opaque kind without agent provenance.
    if (!record.kind.startsWith("{")) return undefined
    return Schema.decodeUnknownSync(Schema.Struct({ runtime: Schema.NonEmptyString }))(JSON.parse(record.kind)).runtime
  }

  async withEvent<A>(
    key: string,
    digest: string,
    auth: AuthReference | undefined,
    action: () => Promise<A>
  ): Promise<A> {
    if (this.#event !== undefined) throw new Error("Concurrent event append")
    this.#event = { key, digest, auth }
    try {
      return await action()
    } finally {
      this.#event = undefined
    }
  }

  async close(): Promise<void> {
    try {
      this.#db?.close()
    } finally {
      this.#db = undefined
      this.#ownership?.close()
      this.#ownership = undefined
    }
  }
}

const initializeDatabase = (db: DatabaseSync, root: string, key?: string): void => {
  const version = db.prepare("PRAGMA user_version").get()
  if (version?.user_version !== 0 && version?.user_version !== 1) throw new Error("Unsupported memory format")
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, value TEXT NOT NULL, auth_home TEXT, auth_reference TEXT);
        CREATE TABLE IF NOT EXISTS nodes (level INTEGER NOT NULL, idx INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(level, idx));
        CREATE TABLE IF NOT EXISTS checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);`)
  upgradeAuthReferences(db)
  const existing = db.prepare("SELECT value FROM metadata WHERE key='root'").get()
  validatePoolIdentity(db, existing?.value, root, key)
  persistPoolLocation(db, root, key)
  db.exec("PRAGMA user_version = 1")
}

const upgradeAuthReferences = (db: DatabaseSync): void => {
  const columns = db.prepare("PRAGMA table_info(records)").all()
  if (!columns.some((column) => column.name === "auth_reference"))
    db.exec("ALTER TABLE records ADD COLUMN auth_reference TEXT")
}

const persistPoolLocation = (db: DatabaseSync, root: string, key?: string): void => {
  db.exec("BEGIN IMMEDIATE")
  try {
    db.prepare("INSERT INTO metadata VALUES ('root', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(root)
    if (key !== undefined) db.prepare("INSERT OR IGNORE INTO metadata VALUES ('root_key', ?)").run(Digest.make(key))
    db.exec("COMMIT")
  } catch (cause) {
    db.exec("ROLLBACK")
    throw cause
  }
}

const poolIdentity = (db: DatabaseSync, root: string): string => {
  const persisted = db.prepare("SELECT value FROM metadata WHERE key='root_key'").get()
  return persisted === undefined
    ? createHash("sha256").update(root).digest("hex")
    : Schema.decodeUnknownSync(Digest)(persisted.value)
}

const validatePoolIdentity = (db: DatabaseSync, existing: unknown, root: string, key?: string): void => {
  if (existing === undefined) return
  const previous = Schema.decodeUnknownSync(AbsolutePath)(existing)
  if (key === undefined ? previous !== root : poolIdentity(db, previous) !== key)
    throw new Error("Memory belongs to a different root")
}

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const validateReceipt = (receipt: typeof ReceiptSchema.Type): void => {
  if (
    receipt.firstId < 0 ||
    receipt.ids.length === 0 ||
    receipt.ids.some((id, index) => id !== receipt.firstId + index) ||
    receipt.endExclusive !== receipt.firstId + receipt.ids.length
  )
    throw new Error("Invalid contiguous event receipt")
}

const validateDatabaseFile = (stat: NonNullable<ReturnType<typeof lstatSync>>): void => {
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid !== undefined && stat.uid !== process.getuid()))
    throw new Error("Unsafe database file")
}
