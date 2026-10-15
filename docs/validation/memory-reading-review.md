# Memory-reading acceptance

Baseline: completed milestone `3042806271479fe095687d5cdc4ae30d1368ad5e`; review includes the working-tree implementation and added files.

## Standards

The independent standards review identified a publication/selection race: public-command ownership ended before runtime activation. Publication now retains its scoped lease through selection and activation; selection retains its own lease through activation. A concurrent-publisher regression exercises the post-publication callback while ownership remains held. The optional duplicate legacy CLI hook workflow remains for compatibility; installed hooks use the separate intake artifact.

## Spec

Astra identified batch EOF response loss, invalid calendar freshness, stopped-resident update, ownership release during draining, repair's native-feature recovery, stale startup selection, partial activation reporting, and hooks winning an activation race. These were corrected. MCP EOF/calendar regression tests, actual installed update, and package-removal witnesses cover the relevant behavior; this is not exhaustive scheduling verification.

`pnpm check-all` passes: 217 tests across 30 files, strict TypeScript/Effect diagnostics, cycles/capability boundaries, complexity, lint/formatting, secret scanning and CRAP threshold 8, plus installed/bootstrap/package witnesses. The compact hook artifact is separately rebuilt and exercised by the installed witnesses. Actual package evidence is in [package-memory-reading.json](package-memory-reading.json).

The package witness checks native hook launch, four direct MCP schemas, snapshot parity with CLI, EOF resident survival, live runtime switching, retained embedded Node after deleting the source package, and preserved memory after uninstall. Hook timing is a host-dependent observation; one loaded run exceeded the 150 ms warm target, followed by successful runs. The numerical target is a witness check, not a universal latency guarantee.

Publication is pending. Linux arm64 is the package actually exercised here; other platform packages require their own build and witness. Legacy combined-bundle profiles require explicit migration. No paid inference or interactive host-trust acceptance was repeated for this feature.


## Review corrections and Effect audit

The user classifies the Standards findings as blocking P0. MCP limits now fail through `ProtocolLimitError`, with native Stdio adaptation through typed `PlatformError`; drain completion uses a scoped `Deferred`. Child readiness is a schema union coupling ready/string and pending-or-failed/null. The full SQLite ownership probe maps expected errors to `TransportError`; only busy/locked ownership retries.

Effect patterns were compared against actual sibling implementations: Hapsland `packages/resident-transport/src/resident/client.ts` and `packages/credential-storage/src/credentials/owner.ts`, and Huly `src/huly/client.ts`. These use `Effect.try`/`tryPromise` at native boundaries, explicit resource acquisition, and scoped ownership. Pinned Effect 4.0.3 uses `Schema.TaggedError`; the newer skill's `TaggedErrorClass` is not available in this cohort. Follow-up Standards review found no remaining blockers in the changed paths.

Spec corrections include atomic conditional shutdown checked by the receiving resident, rejection of mismatching identities, verified snapshot reconciliation, and retaining the last serving target across failed activations. Restart and update share an activation lease and reread selection under ownership. Repair verifies manifests, launch roles and artifact hashes before creating a new recovery journal or restoring bindings. Failure responses expose sanitized reason/guidance without reflecting provider messages.

The package witness retains every cold/warm/unavailable attempt, exit status, acknowledgement, artifact digests and environment, including failed runs. Its declared timing conditions are repeated replay of one real 4KiB prompt, ten fresh resident starts, thirty warm acknowledgements, and three unavailable-runtime attempts. The summarizer is an explicit synthetic Claude adapter; no paid inference is used. Append-only run history is `package-memory-reading-runs.jsonl`.

## Bounded corrective review

The requested limit was three additional review passes. Three independent Standards/Spec passes were used. The first found an untyped UNII leaf-page failure and doctor hiding recovery before initial ownership publication. Both were corrected with regression tests; the second reported zero actionable findings on each axis. The final pass rechecked the CLI repair extraction and its end-to-end regression after the CRAP gate required separating host-command responsibilities; it also reported zero findings on both axes.

Other corrections in this cycle: expected read-boundary/range failures use Result and retain parsed branded values; snapshot decoding permits either complete modern integrity metadata or an explicit legacy-none variant; activation/restart/doctor outputs have owning schemas. A separate delivery journal preserves setup/update intent through native/public publication, selection and activation. Ordinary repair cannot publish an older profile globally. Doctor inspects hooks, MCP and runtime independently, including when one component is missing or modified.

Delivery interruption witnesses use actual immutable built snapshots and filesystem journals with injected native/activation failures. They preserve the pending target and intent, reject premature uninstall, resume the publication callback, and remove both journals only after completion. These are synthetic failure witnesses, not exhaustive crash-schedule verification.

Final `pnpm check-all` completed with exit 0 after all corrections: 217 tests / 30 files; Effect diagnostics 101/101 files, zero warnings; CRAP 647 functions, maximum 8, no threshold breaches. Installed, bootstrap and package witnesses passed. Final package observations: cold p95 268 ms, warm p95 110 ms, unavailable-runtime acknowledgement 2.56–2.58 s.
