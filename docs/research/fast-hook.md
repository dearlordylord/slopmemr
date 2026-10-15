# Dedicated fast hook artifact

**Purpose:** Specify a minimal hook boundary based on Hapsland and identify checks that establish isolation and latency.
**Audience:** Implementation and installation owners.
**Status:** Research completed 2026-10-14; recommendations and budgets are proposed, not implemented.
**Authority:** User requirement for a fast standalone hook; source inspection owns baseline facts.
**Expected use:** Plan the hook composition and acceptance checks without continuing implementation.
**Lifecycle:** Recheck when artifacts, registration, resident startup, or native hook contracts change.

## Conclusion

Build and install a separate `slopmemr-hook.mjs`. Its composition should only decode a native observation, normalize it, ensure the separately launched resident is available, append the observation, and emit the host-required acknowledgement/instruction. It must never import resident serving, SQLite storage, summarizers, MCP implementation, or installation administration. Retain the general CLI as the resident/control artifact initially; a third dedicated resident artifact is optional later. This follows Hapsland's separation without copying its advice features or requiring Bun.

## What Hapsland establishes

Hapsland declares `@hapsland/hook-entry` as role `hook`, with its own `hapsland-hook` executable and assembly profiles. Its entry imports hook parsing/program execution and transport clock/runtime information, rather than the general CLI. The hook program supplies resident startup through a transport service; it does not compose the resident server. [Entry declaration](../../../jev/packages/hook-entry/package.json), [actual entry](../../../jev/packages/hook-entry/src/hook-main.ts), [hook program](../../../jev/packages/hook-runtime/src/hooks/program.ts).

Its release contract names the actual hook entry and forbids administration, credential mutation, provider execution, review orchestration and source analysis. Source contribution checks traverse imports and validate owner capabilities; standalone compilation also validates the actual build metafile inputs. This establishes two different facts: source closure authority and artifact contribution agreement. [Declared boundary](../../../jev/package.json), [source checks](../../../jev/scripts/check-build-boundaries.mjs), [assembly input checks](../../../jev/scripts/compile-standalone.mjs).

Its measurement selects the installed dedicated executable and rejects fallback to the general CLI. It distinguishes a healthy existing resident from a fresh resident, records parent monotonic wall time and handler readiness, verifies resident reuse, retains failures and artifact identity, and explicitly calls the OS file cache uncontrolled. Fresh resident means fresh process/state, not guaranteed cold filesystem cache. [Command selection](../../../jev/scripts/measure-hook-startup-commands.mjs), [measurement](../../../jev/scripts/measure-hook-startup.mjs), [summary](../../../jev/scripts/measure-hook-startup-summary.mjs).

## Current slopmemr gap

The build bundles only `src/cli/main.ts` into `dist/bin/slopmemr.mjs`. That entry imports `cli/program.ts`, whose static imports include resident serving, memory implementation, both compactor families, installation management and doctor. Choosing its `Hook` branch does not undo those module imports. The install snapshot captures that same single bundle, and the profile launcher invokes its `hook` subcommand. [Build](../../scripts/build.mjs), [CLI entry](../../src/cli/main.ts), [program](../../src/cli/program.ts), [capture](../../src/installation/snapshot.ts), [launcher](../../src/installation/binding.ts).

Existing boundary enforcement protects `intake/hook.ts` and `resident/client.ts`; neither is the executable entry. It therefore establishes their local closures, not isolation of the currently installed hook process. The existing client validates bounded responses, including request-specific success schemas; preserve that behavior. [Boundary checks](../../scripts/check-boundaries.mjs), [client](../../src/resident/client.ts).

`cli/lifecycle.ts` launches a resident in a separate detached process and waits for local readiness before appending. It does not await summarizer results. However, its launch descriptor currently identifies the same general CLI used by the hook; a dedicated hook must carry a separate resident launch descriptor instead of accidentally launching itself with `resident`. Also avoid importing `cli/configuration.ts`: it reads unrelated compactor and pool settings, so malformed unrelated settings can fail an otherwise valid hook invocation. [Lifecycle](../../src/cli/lifecycle.ts), [configuration](../../src/cli/configuration.ts).

## Minimal composition and installation plan

1. Add a dedicated hook entry and hook workflow with narrow argument/configuration parsing. It needs runtime/profile references, optional pinned root, socket path, native stdin limits, deadline, and the resident launch descriptor. Use narrow Effect module imports where practical and verify their effect in the build contribution report; import spelling alone does not prove a smaller artifact.
2. Move reusable ensure/start-and-append behavior to a transport-owned entry. Allow `node:child_process` only for launching the declared resident artifact; do not permit provider launch code. Keep root canonicalization and memory decisions in the resident. The hook client needs contracts, endpoint privacy, transport and intake normalization only.
3. Build two independent bundled outputs: the existing control/resident CLI and the new hook. Do not make the hook import the general CLI or the aggregate library index, even lazily. A filename split with a shared resident-bearing chunk would still violate the boundary.
4. Capture both artifacts and notices in one immutable install snapshot, with a manifest binding their independent digests and launch roles. Profile hook launchers select the hook artifact and provide the resident launch reference; the public control launcher continues selecting the general CLI. Update ownership, recovery and doctor checks for the pair, including an explicit old-single-artifact migration. Selecting the hook artifact must be part of installation evidence, not a fallback.
5. Keep native acknowledgement/output rules and stable event identity. Do not await snapshot readiness, `settle`, compaction, MCP connection, or model usage. A read-memory instruction, once agreed, is small static hook output and does not require loading a reading server.

These are recommendations derived from the inspected seams, not changes already made. [Existing native workflow](../../src/cli/program.ts), [event rules](../../src/intake/events.ts), [installation contracts](../../src/installation/contracts.ts), [public command binding](../../src/installation/public-command.ts).

## Acceptance checks

**Capability gate:** Traverse the actual hook entry source closure, including type-only, re-export and dynamic edges. Allow only named hook/intake contracts, transport, private local state and Effect execution needs. Reject memory implementation/storage, compaction implementations, resident server, MCP server/registration and installation workflows; allow only the narrowly owned auth-reference schema and read/wire contracts where needed. Check the hook output's esbuild metafile and external imports too. Add mutation fixtures proving that a forbidden static import, lazy import and installed-launcher fallback are caught. Hapsland provides the model for pairing source and artifact checks. [Source gate](../../../jev/scripts/check-build-boundaries.mjs), [artifact gate](../../../jev/scripts/compile-standalone.mjs).

**Behavior gate:** Invoke the installed shell launcher in a disposable copied snapshot with no repository `node_modules`. Assert native output, attribution and durable append acknowledgement against a controlled resident. Prove startup uses the resident launch role rather than the hook role, and a healthy resident is reused. Use a controllable fake backend that remains blocked after append; the hook must finish while compression is still blocked. Exercise missing/busy endpoint, malformed input, bounded deadline, disconnect, starter races and modified/missing paired artifacts. No real provider or installation into the user's profile is necessary for these tests. Existing lifecycle tests are a starting point. [Current lifecycle tests](../../src/cli/lifecycle.test.ts), [readiness tests](../../src/cli/readiness.test.ts), [resident tests](../../src/resident/server.test.ts).

**Proposed performance budget:** On declared supported Linux/macOS hardware and Node 24, installed launcher to successful exit for a fixed 4 KiB observation: warm resident **p95 ≤ 150 ms**; fresh resident **p95 ≤ 2,000 ms**; unavailable resident hook deadline **≤ 3,000 ms**. These are initial targets for approval and measurement, not achieved facts. Durable append completion is included; provider completion is excluded. The final deadline should be coordinated with native host timeouts and must explicitly define whether an unacknowledged observation fails or is safely retained for retry.

Measure at least 30 warm and 20 fresh-resident samples with a fresh hook process for every sample. Keep all samples, exit/output/ack outcomes and failures; do not discard slow starts. Alternate baseline/candidate order when comparing. Report median, nearest-rank p95, maximum, sample counts, artifact hashes/bytes, Node/OS/CPU and load. Fresh-resident fixtures must start without a resident and verify exactly one ready resident; warm samples must verify reuse. Record uncontrolled file-cache state instead of claiming cold-cache results. Also report no-op executable startup separately; it cannot substitute for hook latency. The sample policy and targets here are proposed refinements, while the warm/cold distinction comes from Hapsland's measurement. [Hapsland measurement](../../../jev/scripts/measure-hook-startup.mjs).

## Safe baseline observed

On 2026-10-14, the already-built general CLI was invoked as `node dist/bin/slopmemr.mjs --help`, without building, installing, sending hook events or calling a provider. Twenty sequential fresh processes all exited 0. Linux/aarch64, Node v24.20.0; uncontrolled OS file cache; no excluded warmups.

| Metric | Observed general CLI help startup |
| --- | --- |
| Median | 75.21 ms |
| Nearest-rank p95 | 88.66 ms |
| Maximum | 100.83 ms |
| Bundle bytes | 927,512 |
| SHA-256 | `0e4f9ac773f35dd85e827c31bc3737f640ea1413f15608ace80fdf74b0d7fe53` |

Individual durations in milliseconds: `100.83, 85.92, 84.97, 70.80, 70.21, 65.70, 77.97, 66.79, 77.83, 87.84, 73.56, 88.66, 66.35, 74.24, 80.65, 76.18, 72.13, 71.67, 83.72, 72.80`.

This is **general CLI no-op startup**, not installed hook latency, resident readiness, durable intake or evidence that any proposed budget is met. It also is not an A/B comparison or a throughput measurement. The command's entry/build definition is [scripts/build.mjs](../../scripts/build.mjs).
