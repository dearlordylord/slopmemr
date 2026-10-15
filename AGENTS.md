# slopmemr development

Purpose: persistent memory per calling agent's real project root, implemented with Effect 4 and UNII.
Authority: user instructions and `docs/architecture.md` define product behavior; this file defines development standards.
Read `docs/architecture.md` before changing root identity, credential routing, storage, resident lifetime or intake.
Read `docs/research/compactor-auth.md` before changing Codex authentication or app-server restrictions.
Read `docs/installation.md` before changing setup, update, recovery or removal.

## Required workflow

For creating tasks, planning work or updating completion status, use GitHub Issues as configured in `docs/agents/issue-tracker.md`.

Use pnpm and the exact dependency cohort in package.json. Consult the pinned Effect sources before selecting an API.
Run `pnpm check-all` after implementation. A task is complete only when every gate succeeds and relevant built-artifact evidence exists.
Report failing gates and the evidence actually collected; never describe a partial or skipped run as passing.
Exercise installation and resident changes through the installed bundle. Provider tests remain explicit opt-in synthetic witnesses.

## TypeScript and Effect

These standards adopt the reusable harness and review rules from `../hulymcp`, without its Huly application contracts.

- Decode untrusted input and persisted state with canonical `import { Schema } from "effect"`. Derive boundary types from schemas, including outbound responses.
- Give named domain values constrained schemas or explicit aliases. Keep constants and limits beside the domain that owns them.
- Keep core transformations independent of I/O. Put filesystem, socket, process and configuration access at named adapter boundaries.
- Use `Effect.fn`, typed errors, scoped layers and explicit ports. Hold resource ownership for the entire operation; release it on failure and interruption.
- Read runtime configuration with Config. Use Effect Console and injected services for observations and testing.
- Preserve the pinned unstable API allowlist: NodeRuntime.runMain, @effect/vitest.it, and exact file-scoped MCP/Stdio APIs in tsconfig.json. Do not allow whole unstable namespaces. Every source file must be checked by Effect diagnostics.
- Keep imports acyclic, including type-only imports. Capability slice dependencies are enforced by scripts/check-boundaries.mjs.
- Fix complexity above the configured limit by separating responsibilities. Do not suppress rules or introduce an allowed-violations baseline.
- Test behavioral invariants and failure recovery through layers or ports. Place fast-check tests in *.property.test.ts. vi/jest mocks, casts and clock reads are rejected by the project plugin.
- Use @crap4ts/crap4ts with the project threshold and strict missing-evidence policy. Its gate regenerates coverage; there are no percentage coverage thresholds. Include every selected source file in instrumentation. Built process shells also need artifact evidence.
- Preserve the duplication gate, typed lint, formatting, cohort verification, pre-commit staged checks and secret scanning.

## Product boundaries

Linked Git worktrees share their primary working copy's memory. Independent clones remain separate.
Observations must remain attributable to runtime, session and supplied child identity. Keep raw records and atomic replay receipts durable.
Compaction delegates login/refresh to the source runtime: Codex/ChatGPT with Luna or Claude/claude.ai with Haiku. Never implement API-key usage, cross-runtime auth fallback or copy token stores.
Hooks acknowledge the native protocol and may emit a tiny SessionStart memory-reading guide with CLI fallback. Never inject memory snapshots, advice or blocking decisions. Install a dedicated lightweight hook artifact, without resident/storage/compactor/MCP implementations.
Publish immutable installed runtime snapshots. Preserve unrelated native settings and reject modified owned handlers or launchers.
