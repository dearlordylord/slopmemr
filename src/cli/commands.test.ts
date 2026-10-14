import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { parseCommand } from "./commands.js"
import { ownerMarker } from "../installation/contracts.js"

const accepted: ReadonlyArray<readonly [ReadonlyArray<string>, unknown]> = [
  [[], { _tag: "Help" }],
  [["--help"], { _tag: "Help" }],
  [["start"], { _tag: "Start" }],
  [["setup", "codex"], { _tag: "Setup", runtime: "codex" }],
  [
    ["install", "--runtime", "claude", "--profile", "/profile"],
    { _tag: "Setup", runtime: "claude", profile: "/profile" }
  ],
  [["hook", "--runtime", "codex", "--hook-owner", ownerMarker], { _tag: "Hook", runtime: "codex" }],
  [
    ["zoom", "--root", "/root", "--first", "0", "--count", "2", "--page", "1"],
    { _tag: "Zoom", root: "/root", first: 0, count: 2, page: 1 }
  ],
  [
    ["snapshot", "--root", "/root", "--before", "10", "--view", "compaction"],
    { _tag: "Snapshot", root: "/root", before: 10, view: "compaction" }
  ],
  [["settle", "--root", "/root", "--wait-ms", "20000"], { _tag: "Settle", root: "/root", waitMs: 20000 }]
]
for (const [args, expected] of accepted)
  it.effect(`parses ${args.join(" ") || "default help"}`, () =>
    Effect.gen(function* () {
      expect(yield* parseCommand(args)).toEqual(expected)
    })
  )
const invalid: ReadonlyArray<ReadonlyArray<string>> = [
  ["unknown"],
  ["stop", "extra"],
  ["setup", "codex", "extra"],
  ["--bad"],
  ["setup"],
  ["setup", "codex", "--runtime", "claude"],
  ["setup", "claude", "--codex-home", "/foreign"],
  ["setup", "codex", "--claude-home", "/foreign"],
  ["hook", "--runtime", "pi"],
  ["hook", "--runtime", "codex", "--hook-owner", "other"],
  ["stop", "--hook-owner", ownerMarker],
  ["stop", "--root", "/root"],
  ["snapshot"],
  ["snapshot", "--root", "relative"],
  ["zoom", "--root", "/root", "--first", "", "--count", "2"],
  ["zoom", "--root", "/root", "--first", "1e2", "--count", "2"],
  ["zoom", "--root", "/root", "--first", "0", "--count", "0"],
  ["settle", "--root", "/root", "--wait-ms", "20001"],
  ["status", "--root", "/bad\0path"]
]
for (const args of invalid)
  it.effect(`rejects invalid ${args.join(" ")}`, () =>
    Effect.gen(function* () {
      const result = yield* parseCommand(args).pipe(Effect.flip)
      expect(result._tag).toBe("CliError")
    })
  )
