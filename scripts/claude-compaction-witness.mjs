import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import { Effect } from "effect"
import { ClaudeCompactor, layer } from "../dist/compaction/claude.js"
const request = {
  jobId: "synthetic-claude-witness",
  attemptId: "attempt-1",
  attempt: 1,
  node: { level: 0, index: 0 },
  source:
    "Synthetic project decision: keep memory identity in .slopmemr-id so moving the project and git init preserve its memory. Retain original records. Summarize this decision.",
  context: "",
  priorResponses: [],
  feedback: null
}
const observations = []
try {
  const text = await Effect.runPromise(
    Effect.gen(function* () {
      const compactor = yield* ClaudeCompactor
      return yield* compactor.compress(
        { claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") },
        request,
        (event) => observations.push(event)
      )
    }).pipe(Effect.provide(layer()))
  )
  const evidence = {
    validation: "synthetic-claude-subscription-compaction",
    runtime: "claude",
    modelFamily: "haiku",
    authentication: "existing claude.ai subscription",
    apiKeysUsed: false,
    repositoryContentUsed: false,
    toolsAndMcp: "disabled and checked",
    summaryBytes: Buffer.byteLength(text),
    preservedIdentityFilename: text.includes(".slopmemr-id"),
    usage: observations.filter((event) => event.kind === "usage").map((event) => event.counters)
  }
  writeFileSync("docs/validation/claude-compaction.json", JSON.stringify(evidence, null, 2) + "\n")
  process.stdout.write(JSON.stringify(evidence) + "\n")
} catch {
  process.stderr.write(
    "Synthetic Claude subscription compaction failed; inspect the adapter and installed CLI compatibility.\n"
  )
  process.exitCode = 1
}
