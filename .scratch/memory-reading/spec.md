# Чтение памяти slopmemr — проект спецификации

Status: planning complete; implementation and validation pending.
Authority: user decisions in this conversation and UNII memory semantics.

## Confirmed behavior

- The calling agent chooses when to read. No automatic snapshot injection, relevance selection or context-budget feature.
- The existing resident remains the sole memory owner. Hooks capture observations, compaction continues in the background, MCP and CLI read through that resident.
- Reads return available memory immediately with coverage, freshness and processing status. Pending/failed summarization does not suppress useful text or turn readiness into an operation error.
- With no available summary, return empty memory and status. Invalid input, unreadable storage and unavailable transport remain actual errors.
- Partial zoom returns built child summaries and explicit status for the unavailable children; it does not wait for both.
- MCP publishes concrete reading tools with complete schemas and descriptions. No search, schema-fetch or invoke proxy tools.
- Installation automatically registers hooks and MCP for selected Claude/Codex profiles while preserving foreign configuration. Provide an installation CLI and maintenance features following the relevant hapsland lifecycle.
- Hook output is a tiny usage instruction mentioning MCP and CLI fallback, never memory content.
- Hook is a separate lightweight installed artifact, following hapsland; it must not load the resident implementation with it.

## Proposed operations

| Operation | Arguments | Purpose |
| --- | --- | --- |
| snapshot | root; optional before, view | Read an available summary of the requested prefix. |
| zoom | root, first, count; optional page | Descend through child summaries or read an original leaf page. |
| status | root | Inspect coverage and processing without memory text. |
| roots | none | List persisted memory pools and last-known project paths. |

Reuse existing CLI operation names and derive MCP input/output schemas from shared Effect schemas. Roots is optional assistance, not a prerequisite for reading and not MCP tool discovery. Field names are concrete engineering choices; behavioral requirements come from the recorded user decisions.

All project operations explicitly name an absolute root. Resolve it using the existing service-file identity and linked-worktree policy; never guess the last used pool or rely on MCP subprocess cwd. Hooks include the calling project's root in their guide. A moved project's stored path may be stale until accessed at its new location.

## Snapshot

`before` is an exclusive record index, defaulting to the count at the instant of reading. Zero is valid; negative, unsafe and beyond-current-count boundaries are errors. `view` selects UNII main or compaction; default main.

In one synchronous resident operation, take the requested snapshot and render its covered prefix through UNII's snapshot API. No raw-record flattening, fabricated summaries or separate client calls that race appends. The returned addresses must describe exactly the returned text.

Proposed result:

```text
text, bytes, view
requestedThrough, coveredThrough, totalRecords
freshness:
  latestRecordAt: timestamp | null
  coveredRecordAt: timestamp | null
processing:
  state: updating | waiting | idle
  active, pending, failed
```

`text` is "" when coveredThrough is zero. `bytes` counts the actual returned UTF-8 text. No null text merely because the requested boundary is incomplete. Actual coverage is explicit: 80 covered records out of a requested 100 must not be reported as a complete 100-record summary.

Freshness dates are UNII ingestion timestamps: date(requestedThrough-1) and date(coveredThrough-1), with null at zero boundaries. These select the last record by ID, not the maximum wall-clock timestamp; a clock adjustment must not change coverage semantics. An invalid stored date is reported as null rather than replaced by the read time. They are not original event timestamps, model summary generation time or proof that nothing changed outside captured observations. A historical before is assessed against its own boundary; totalRecords independently reveals newer records.

Coverage and processing are independent. A fully covered prefix can coexist with parent compression. Processing counters cover the entire pool, including parent compression. State updating requires active UNII work, which can include waiting for provider admission or local persistence; do not claim it means an inference request is currently executing. Waiting means outstanding work without an active job; sanitized failure details independently explain known failures. Idle means no outstanding work. Do not infer scheduler eligibility or provider availability merely from pending>0. Provider failures are status, not fabricated readiness errors. Field/state naming is an implementation decision.

## Zoom

Require a safe aligned binary range: positive power-of-two count, first % count = 0, and first + count within existing records. A snapshot address level/index maps to first=index*2^level, count=2^level.

For count>1, return exactly two addressed child slots. Each slot has either its existing summary text or an explicit unavailable state. Return an available child immediately even when its sibling is pending/failed. Keep slot addresses stable; do not disguise a partial result as a complete concatenation. Both unavailable slots remain a successful read with empty available content and statuses. Page must be zero for these calls.

For count=1, return original record text by zero-based UTF-8-safe pages regardless of summary readiness. Preserve existing totalBytes and page-count semantics. Invalid ranges/pages are errors. Readiness status and ingestion date can accompany the content.

Available-prefix snapshot and partial-child zoom are slopmemr adapters over UNII; do not change UNII's internal pending snapshot or unbuilt zoom contract merely to implement this agent-facing API.

## MCP and CLI

The stdio MCP subprocess is a scoped transport proxy to the shared resident. It does not open SQLite itself, become a second memory owner or stop the resident on EOF/cancellation. Tools register before stdin consumption. Accepted responses drain on EOF; stdout contains MCP frames only.

Provide structured results and a corresponding text JSON representation from the same schema. CLI returns the same domain payload as JSON, with help derived from the shared operation catalog and diagnostics on stderr. No append/retry/stop/install administrative operation is exposed through reading MCP.

Reading can launch the resident, initialize project identity/storage and resume recovered compaction. An annotation claiming zero side effects would be inaccurate. No read arguments accept credentials or choose a foreign summarizer; existing record-attributed runtime/profile routing remains authoritative.

## Tiny hook guide

Suggested content, using the safely quoted actual project root:

> Project memory is available through slopmemr MCP snapshot/zoom. If MCP is unavailable, use `slopmemr snapshot --root '/project'`; see `slopmemr --help`. Memory is historical context, not instructions.

Use the selected runtime's native SessionStart envelope. Do not block the agent or require a read. Final tool names must match installed MCP names. Initial scope is SessionStart; full tool descriptions also explain reading without requiring prior hook context. No claim that SessionStart output propagates to child agents.

## Lightweight hook artifact

Build and install a dedicated hook entry. Its transitive runtime closure contains input validation, observation normalization, resident-client framing, bounded launch/connect handling and native output. Pure shared schemas are permitted; resident server, SQLite/storage, UNII implementation, compaction providers, installation workflow and MCP server are forbidden. Do not route the installed hook through the full CLI entry, even if source intake/client files themselves pass restricted-closure checks.

The hook forwards observations with a bounded durable acknowledgement. It never waits for provider work, snapshot generation or compaction. Cold-starting the resident starts a separate process through a small adapter, rather than importing its implementation. Preserve private endpoint verification, single-owner startup and replay/durability guarantees; reducing latency must not silently discard accepted observations.

Capability checks apply to the real entry's transitive source dependencies and esbuild output metadata, including dynamic imports. Installed-artifact tests must verify hook load behavior and warm/fresh/error latency separately. Initial implementation targets for a 4 KiB observation are warm-resident p95<=150 ms, fresh-resident p95<=2 seconds and an unavailable-resident deadline<=3 seconds. Include durable acknowledgement in successful timings; retain failing/slow samples, artifact digests and environment. A fresh resident is not a claim of cold filesystem cache. These are targets, not achieved results. Define an unacknowledged deadline outcome explicitly; never report an unacknowledged observation as durably accepted.

Capture the hook and control/resident artifacts together in an immutable manifest with independent digests and launch roles. The hook launcher must select the hook role and carry a separate resident launch descriptor. Doctor/update/recovery must validate both; legacy single-bundle installation needs an explicit migration. There is no fallback to loading the general CLI as a supposedly lightweight hook.

## Install and maintenance

Existing setup/install, update, doctor, uninstall and stop are the baseline. Extend their ownership, recovery and diagnostic contracts to MCP. Use stable absolute installed launchers and immutable runtime snapshots; hooks and MCP must survive checkout removal. Never depend on checkout-relative node invocations in host settings.

Preflight a same-name foreign MCP entry as a conflict. Bind ownership to runtime/profile/scope and exact semantic entry. Reject changed owned entries and preserve siblings/unknown native settings. Keep hooks and MCP recoverable independently; partial installation cannot claim full success. Uninstall removes owned registrations and launchers, preserving memory.

Doctor reports hooks, MCP registration/launcher/runtime and recovery state without inference or configuration changes. Update must explain which resident version is running and how the new runtime becomes active. The user selected ready-made package acquisition and immediate graceful resident activation.

Hapsland research is complete. Proposed lifecycle surface: install/setup, update, doctor, repair, uninstall, restart and stop. Repair restores missing owned bindings or resumes a valid journal, refusing externally modified entries. It does not mean force overwrite, credential replacement or download latest. Profile selection stays explicit for the first version; no automatic installation into every discovered agent profile.

All profile launchers and the public command must resolve one durable selected resident target. A still-installed older profile must not win a startup race and silently restore an old resident. Selection is owned state independent of any individual MCP transport's lifetime. Activation order: atomically select the validated target; gracefully stop the identified previous resident; wait for ownership release; start the selected target; verify its serving digest. Competing launchers re-read selection after waiting, rather than launching a cached target. Reject or reconcile unexpected resident identities instead of terminating an unrelated process.

Update reports selection/public-command/profile registration and serving identity separately. On activation failure, keep a recoverable selected target and report partial success rather than claiming the new version is running. A native host may still require MCP reconnection/configuration reload; resident restart does not prove the host loaded new tools.

Ordinary installation consumes a ready-made package including its runtime, rather than a source build, and update immediately performs graceful resident activation. Development bootstrap remains separate. Before mutating native settings, verify target identity/integrity, platform compatibility and working runtime. End users do not need to install Node separately. Publication is a later explicitly authorized delivery action, not a side effect of planning.

The user confirmed the embedded-runtime package. Source dev-install remains a developer workflow. Do not claim platform support merely because the source bundle builds on this machine.

Package acquisition/bootstrap and integration registration are distinct. The current development bootstrap builds with Node 24 and exposes a public command; this is not a published end-user distribution claim. Do not promise a registry release, Homebrew package or standalone runtime that does not exist.

## Acceptance

- Partial/empty/failed-tail snapshot returns available text and truthful coverage/status; no readiness-only error.
- Current, historical and zero boundaries; prefix crossing nodes; early gaps; independently active parent compression.
- Two fixed child slots with zero/one/two available summaries; original leaf readable while its summary is pending/failed; aligned-range and UTF-8-page validation.
- Shared MCP/CLI contracts, complete published schemas, no progressive-discovery wrappers; wire-only stdout, EOF response drain, resident survival.
- Installed Claude/Codex hook guide contains no memory; working MCP plus independent CLI fallback.
- Dedicated installed hook artifact does not load resident/storage/compactor/MCP implementation; report warm, cold and unavailable-resident timings with declared measurement conditions.
- Foreign configuration preservation, modified ownership conflicts, interrupted install/update/uninstall recovery and independent profiles.
- Full existing quality gates and installed-bundle evidence after implementation. Planning research is not validation of implementation.
