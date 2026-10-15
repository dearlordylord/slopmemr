# Installation and maintenance reference

**Purpose:** Identify the smallest useful Hapsland lifecycle for slopmemr.
**Audience:** Product/specification owners and contributors.
**Status:** Research completed 2026-10-14; planning only, no lifecycle changes implemented.
**Authority:** The user requested installation/maintenance like Hapsland and automatic Codex/Claude MCP registration. Command details below are proposals, not additional accepted requirements.
**Expected use:** Resolve the installation contract before implementation.
**Lifecycle:** Review when distribution, native registration or resident activation changes; consolidate accepted decisions into the maintained installation specification.

## Reference and observed behavior

`../jev` is the Hapsland checkout: its package is `@hapsland/hapsland`. Inspected revision: `a0773f79ffa4babdba219c773832fa3a61cc803c`. Hapsland's docs describe source snapshots, platform releases and npm channels, but explicitly separate those instructions from publication/platform evidence. This investigation reads local documentation and implementation; it does not verify current public package availability or native-host compatibility. [Package](../../../jev/package.json), [workflows](../../../jev/docs/installation-workflows.md).

| Mechanism | Hapsland evidence | Transfer classification |
| --- | --- | --- |
| Package acquisition versus registration | Downloads/stages or selects a target, checks it, then previews/applies profile changes; package installation alone does not configure every host. | **BORROW** the separation; distribution channel remains a slopmemr choice. |
| Lifecycle commands | `setup`, `update`, `doctor`, `repair`, `reinstall`, `uninstall`; optional client selects one profile, bare maintenance discovers registered profiles. | **BORROW** ordinary lifecycle and explicit scope; do not assume every command is necessary. |
| Ownership and recovery | Missing owned handlers can be repaired; modified/duplicate entries conflict under ordinary repair. Reinstall is a separate stronger operation. Uninstall preserves unrelated settings. | **BORROW** conservative repair and recovery. **REJECT** forceful replacement as a default. |
| Offline diagnosis | Doctor reports concrete stages and next actions without starting the resident, provider calls or repair; native trust can remain unknown. | **BORROW** diagnostic boundaries. |
| Shared resident update | Separately persists the selected target, replaces a different serving build and verifies the selected build is serving. Failed activation retains the target and reports partial. | **BORROW** selected/serving distinction; immediate replacement policy needs an explicit slopmemr contract. |
| Review products | Credentials UI, paid key check, rules, advice/analytics/dashboard and extra agent integrations. | **REJECT** for this memory installation scope. |

Evidence: [Codex lifecycle](../../../jev/docs/codex-installation.md), [Claude lifecycle](../../../jev/docs/claude-installation.md), [readiness](../../../jev/docs/status.md), [command definitions](../../../jev/packages/administration/src/onboarding/client-command.ts), [maintenance interpreter](../../../jev/packages/administration/src/onboarding/maintenance.ts), [update interpreter](../../../jev/packages/administration/src/onboarding/update.ts), [resident update](../../../jev/packages/administration/src/onboarding/resident-update.ts).

Hapsland has two distinct restart consequences. Profile updates leave the running agent/resident process alone and report host restart/trust steps. Shared resident update actually requests replacement; its preview states that transient work may be lost. Source code persists selection before activation, verifies the build after startup and retains selection on failure. Those are distinct outcomes, not one generic “updated” flag. [Codex update contract](../../../jev/docs/codex-installation.md), [resident activation implementation](../../../jev/packages/administration/src/onboarding/resident-update.ts).

## What slopmemr already has

`setup` (also parsed as `install`), `update`, `doctor` and `uninstall` require a selected runtime and accept a profile override. They already use immutable snapshots, stable profile launchers, ownership checks, a profile lock, atomic writes and resumable journals. `doctor` checks registration/runtime without resident startup or authentication probes. `uninstall` keeps memory, snapshots and the shared public command. `stop` requests shutdown; ordinary reads/hooks autostart the resident. There is no current `repair`, `restart`, release acquisition or all-profile maintenance command. [Commands](../../src/cli/commands.ts), [program](../../src/cli/program.ts), [installation contract](../installation.md), [doctor](../../src/installation/doctor.ts).

The development bootstrap builds a bundle, invokes setup/update, requires the installed profile to pass doctor, then publishes `~/.local/bin/slopmemr` under independent public-command ownership. This survives checkout removal, but the installed bundle still relies on its selected external Node 24 executable. Unlike Hapsland's packaged runtime, it is not self-contained at the operating-system runtime level. [Bootstrap](../../scripts/dev-install.mjs), [public command publisher](../../src/installation/public-command.ts), [doctor runtime probe](../../src/installation/doctor.ts).

**Current update gap:** `slopmemr update` captures the executable/bundle currently running the command. If the public command points at an old immutable snapshot, invoking it cannot discover or fetch a newer release. A new `dev-install` supplies new bytes, but that is a development acquisition path. Normal CLI setup/update also does not itself run the public-command publisher. New native MCP registration is requested scope, not an existing guarantee of these installation files. [Program dispatch](../../src/cli/program.ts), [snapshot installation](../../src/installation/manager.ts), [bootstrap](../../scripts/dev-install.mjs).

## Minimal proposed user contract

Separate **publication/acquisition**, **host configuration**, and **resident activation**, even when a convenient bootstrap performs them consecutively:

1. Acquire or build a concrete package; validate identity, digest, executable prerequisites and retained contents. Publish a stable public command with ownership checks. Report its exact path and whether its directory must be added to PATH. Do not silently overwrite an unrelated command or edit shell startup files.
2. `setup codex|claude [--profile PATH]` installs that profile's owned hooks and MCP entry together. Keep `install` only as the existing alias. The user has already requested automatic MCP registration; do not make it a separate mandatory manual command. Report incomplete stages without claiming complete setup.
3. `update codex|claude` selects a **new concrete target**, validates it, and updates owned bindings. Before a release channel exists, an explicit retained target is an honest acquisition mechanism. Re-running the old immutable executable alone is not an update mechanism. Separate the reported package/public-command result from each profile result.
4. `doctor codex|claude` remains passive. Report public CLI/bundle availability, hooks, MCP registration, recovery/conflict state and native trust as separately inspected facts. A passive resident probe can show selected versus serving identity without starting it. Memory freshness/status is a separate query that may lazy-open a pool.
5. `repair codex|claude` resumes a valid journal or restores missing exact-owned bindings using the retained target. Refuse changed foreign/owned entries, duplicate ownership markers and ambiguous journals. Never restore an old complete host configuration or silently switch credentials/target during recovery. It should not mean “download latest” or “force overwrite”.
6. `uninstall codex|claude` removes owned hook/MCP registrations before profile launchers. Keep project memory and unrelated native settings; the shared public CLI and retained runtime can remain for another profile and recovery. Package removal is a separate distribution action, not hidden data deletion.
7. Keep `stop` for explicit maintenance; add `restart` only with a precise shared-resident contract: request graceful shutdown, await release of the previous owner, start the selected retained build and verify its identity. Routine installation/use requires no manual `start` and no `node dist/...` command.

A single selected profile is a sufficient first contract. Hapsland's bare all-profile operations are useful later, but require a trustworthy registration inventory, per-profile results and a clear partial-success rule. They must never install an unselected runtime simply because its home directory exists. A `reinstall` that overwrites modified marked entries is not needed to provide safe repair; keep manual reconciliation until that stronger operation is explicitly specified.

## Update, restart and running sessions

Current slopmemr update selects launch bytes for future starts; it does not replace a running resident. A successful response therefore cannot claim that the new build is serving. Report `selectedBuild`, observed `servingBuild` (or unavailable/unknown), and an activation action. This distinction also prevents a successful profile update from masking a failed public-command publication. [Current installation behavior](../installation.md), [lifecycle](../../src/cli/lifecycle.ts).

For the smallest policy, recommend staged update plus explicit graceful restart, with the command explaining the remaining action. An immediate-activation update is also feasible, but must include the same shutdown/start/identity verification and a recoverable partial result. Hapsland's transient review replacement semantics should not be copied as permission to lose memory. slopmemr must retain durable records/checkpoints, drain accepted operations, cancel scoped compaction and recover eligible work from its existing storage contract. Restart may reset runtime diagnostics/usage; it is not equivalent to deleting memory. [slopmemr lifetime contract](../architecture.md), [UNII close/recovery contract](../../../unii/spec/MEMORY.md).

Restarting the resident and restarting/reconnecting Codex or Claude are different actions. Running stdio MCP clients can still use an older client bundle after a resident restart; native hosts also own configuration reload and trust. Installation output should explain any required host reconnection without attempting to grant native trust. A stable registration can reduce configuration changes, but does not prove that an existing host session loaded the new tools. [Hapsland workflow guidance](../../../jev/docs/installation-workflows.md), [Claude guidance](../../../jev/docs/claude-installation.md).

Stable profile launchers and the public command must agree on the intended shared-resident target. Otherwise an older still-installed profile can win the next startup race and restart the old build. Either update all participating launch targets coherently or introduce one owned durable resident-target selection that every launcher resolves. The latter is the Hapsland pattern; it is an architectural proposal, not already implemented slopmemr behavior. [Hapsland resident selection use](../../../jev/packages/administration/src/onboarding/resident-update.ts), [slopmemr spawn source](../../src/cli/lifecycle.ts).

## Decisions still needed and evidence boundary

The user has already selected automatic MCP registration, installation/maintenance scope, memory preservation and preservation of unrelated host configuration. Do not ask these again. Two material choices remain: the initial end-user acquisition route (local packaged bootstrap versus an actually published distribution), and whether update activates the shared resident immediately or reports a pending explicit restart. Exact command aliases, result fields and help layout can be resolved during specification without a separate questionnaire.

Before declaring implementation complete, exercise the installed public command outside the checkout, both host registrations, update from old to new bytes, recovery after interruption, foreign-entry preservation, uninstall without memory loss, and selected-versus-serving identity across restart. These are proposed acceptance checks. This research ran no installers, native hosts, package publication probes or provider calls; only the owned research artifacts changed.
