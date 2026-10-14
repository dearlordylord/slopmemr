import { test } from "node:test"
import { deepEqual, ok } from "node:assert/strict"
import { checkBoundaries } from "./check-boundaries.mjs"

test("detects the original reverse profile dependency, including type-only imports", () => {
  const violations = checkBoundaries(
    new Map([
      ["compaction/compactor.ts", 'import type { AuthReference } from "../memory/contracts.js"'],
      ["memory/contracts.ts", "export interface AuthReference {}"]
    ])
  )
  ok(violations.some((value) => value.includes("compaction must not depend on memory")))
})

test("detects SQLite entering the client closure through a private-directory helper", () => {
  const violations = checkBoundaries(
    new Map([
      ["resident/client.ts", 'import "./endpoint.js"'],
      ["resident/endpoint.ts", 'import "../memory/storage.js"'],
      ["memory/storage.ts", 'import "node:sqlite"']
    ])
  )
  ok(violations.some((value) => value.includes("restricted closure reaches node:sqlite")))
})

test("accepts a shared filesystem policy and a compaction-owned profile contract", () => {
  deepEqual(
    checkBoundaries(
      new Map([
        ["resident/client.ts", 'import "./endpoint.js"'],
        ["resident/endpoint.ts", 'import "../local-state/private-directory.js"'],
        ["local-state/private-directory.ts", 'import "node:fs"'],
        ["memory/contracts.ts", 'import type { AuthReference } from "../compaction/profile.js"'],
        ["compaction/profile.ts", 'import "effect"']
      ])
    ),
    []
  )
})

test("rejects a cycle within one slice even if every edge is type-only", () => {
  const violations = checkBoundaries(
    new Map([
      ["memory/a.ts", 'import type { B } from "./b.js"'],
      ["memory/b.ts", 'export type { C } from "./c.js"'],
      ["memory/c.ts", 'type A = import("./a.js").A']
    ])
  )
  ok(violations.some((value) => value.includes("Dependency cycle")))
})
