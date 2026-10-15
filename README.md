# slopmemr

**Purpose:** Run persistent project memory for coding agents.
**Status:** Working resident and hook installation; validation is tracked below.
**Authority:** Operational guidance for this implementation; the user-requested scope and [architecture](docs/architecture.md) own behavior.
**Expected use:** Install native hooks, then inspect retained project memory.
**Lifecycle:** Update with changes to CLI commands, intake, storage, or authentication; review when supported agent protocols change.

slopmemr runs one local resident per operating-system user. Coding agents contribute observations to a shared memory for their real project root. Linked Git worktrees use the primary working copy's pool; independent clones have separate pools. Sessions and child agents carry provenance, rather than owning separate memories. Non-Git projects use the explicitly supplied physical launch root. A local `.slopmemr-id` file in that root holds the permanent identity; moving the project or initializing/removing Git does not reset memory. Linked worktrees use the primary working copy’s file. Keep this file when moving and do not commit it: a full filesystem copy containing the ID shares memory, while an ordinary Git clone gets a new ID. Creating the identity requires a writable root. Existing path-keyed memory is adopted on first access before relocation.

[UNII](../unii/README.md) owns immutable summary trees, compact views, zooming, and compression scheduling. slopmemr adds SQLite persistence, retry-safe intake, a private Unix socket, and Effect 4 services. Hooks capture supplied prompts, tool inputs/results, and assistant stop messages. SessionStart gives a tiny reading guide. Four direct MCP tools expose snapshot, zoom, status and roots; CLI is the fallback. Reads return available memory immediately with coverage, freshness and processing state. This phase has no advice, review classification, or automatic memory injection.

## Install

For a ready-made package, unpack the matching archive and run `./bin/slopmemr install codex` or `./bin/slopmemr install claude`. Node is included. The calling runtime’s installed CLI and subscription login are needed for compaction. Download packages from [GitHub Releases](https://github.com/dearlordylord/slopmemr/releases). Each release lists its available platform archives and native validation evidence. `pnpm package` builds an archive for the current platform.

For development, use Node 24 on Linux or macOS, pnpm and Git. Keep `../unii` beside this checkout for the build:

```sh
pnpm --dir ../unii install --ignore-scripts
pnpm --dir ../unii build
pnpm install
pnpm dev-install -- --runtime codex
```

The installer registers hooks and publishes an immutable runtime snapshot. **The first native hook starts memory automatically.** Add `~/.local/bin` to PATH to use the `slopmemr` inspection command. The installed hooks work without this checkout or its node_modules.

For Claude Code:

```sh
pnpm dev-install -- --runtime claude
```

Claude compacts through its own **Claude subscription with Haiku**; Codex compacts through its own **ChatGPT login with Luna**. No API key is requested or used. Use `--profile /absolute/claude-profile` for a non-default Claude profile; `CLAUDE_CONFIG_DIR` is respected. No Codex installation or login is needed for Claude-only use.

Use `--profile /absolute/host-profile` to select a non-default native profile. Codex defaults to CODEX_HOME or ~/.codex; Claude defaults to ~/.claude. Setup enables Codex's native hooks feature through its CLI. Complete the native host's hook trust review if required; the installer does not change trust decisions.

```sh
slopmemr doctor codex
slopmemr update codex --target /absolute/package-directory
slopmemr uninstall codex
```

Setup and update preserve unrelated handlers and reject modified owned entries. Interrupted operations recover when repeated. Uninstall retains memory. Update gracefully switches to the shared selected resident build. `slopmemr repair codex|claude` restores missing owned bindings while rejecting modified entries. See the [installation contract](docs/installation.md).

`pnpm check-all` runs the strict TypeScript/Effect, cycle, complexity, typed lint, duplication, formatting, CRAP risk and installed-artifact gates. Offline tests never call a provider. `pnpm test:native` is the explicit synthetic Codex live witness; `pnpm test:claude` checks live Claude/Haiku compaction.

## Connect coding agents

Installed user-wide hooks use each session's supplied cwd and resolve its real Git root. The calling runtime’s profile is embedded in its launcher, so observations do not borrow the resident starter’s identity. Cross-runtime login references are rejected.

For expert project-local wiring, `slopmemr hook-config --runtime codex --root /absolute/project --codex-home /absolute/codex-profile` prints handlers to merge into that project's native configuration. Preserve existing handlers and approve them in the native host. This route deliberately pins the calling root; normal installation does not pin a single project.

The observed events are `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SubagentStop`. Child identity is retained when the host supplies `agent_id`; common events without it are attributed to the session's root agent. The adapter does not infer missing child identity or read transcript files. Event IDs deduplicate retries when the host supplies a stable identity. Without one, a nonce preserves repeated identical prompts as distinct observations.

Hooks produce no model-facing memory or advice. Codex `Stop` and `SubagentStop` return only `{}` to acknowledge the native JSON protocol; other successful hook commands emit no stdout. Failures use exit code 1 and sanitized stderr, never a blocking decision. Only explicitly configured observations enter memory: supplied text is stored verbatim, and long material is later sent to ChatGPT for summarization.

## Inspect memory

```sh
slopmemr roots
slopmemr status --root /absolute/project
slopmemr snapshot --root /absolute/project
slopmemr snapshot --root /absolute/project --view compaction
slopmemr settle --root /absolute/project --wait-ms 20000
slopmemr zoom --root /absolute/project --first 0 --count 1 --page 0
```

`roots` discovers persisted pools across resident restarts without starting inference. `status` shows counts, active/pending work, terminal failures, and observed token usage. Usage counters are scoped to the resident lifetime, not a durable billing ledger.

A snapshot is `ready`, `pending`, or `failed`. Only a ready snapshot has usable text; the requested `--before N` is an exclusive record boundary. `settle` waits up to 20 seconds for currently active compression, then returns the current snapshot. A pending result retains its original records; compression continues independently, and a later query can obtain its completed view.

Zoom ranges are aligned powers of two: `first` must be divisible by `count`. `count=1` returns paginated original text. Larger ranges reveal the two child summaries so callers can progressively descend. Pagination defaults to 4,000 UTF-8 bytes; node summaries target 512 bytes. See [UNII's contract](../unii/spec/MEMORY.md) for splitting, exact-prefix views, and size-retry behavior.

## Append from any runtime

The `append` command accepts one JSON object on stdin. Roots and profile references must be absolute; a caller should supply its launch/project root, rather than a tool's temporary working directory.

```json
{
  "root": "/absolute/project",
  "agent": { "runtime": "codex", "sessionId": "session-1", "agentId": "root" },
  "eventId": "event-1",
  "kind": "decision",
  "text": "Use one pool per real project root.",
  "auth": { "codexHome": "/absolute/codex-profile" }
}
```

Run `slopmemr append < event.json`. An acknowledgement means the complete record batch and deduplication receipt committed atomically. Retrying the same agent/session/event identity with the same content returns that receipt; reusing it with different content fails. Authentication references cannot be changed by replaying an already committed event.

`auth` is optional. Missing/unavailable login never discards an otherwise valid observation. Short sources need no inference. Long sources retain original text and expose a compaction failure until a usable profile is available; opening memory after restart or a new append resumes eligible work.

`request` accepts the tagged resident protocol, for example `{"_tag":"Snapshot","root":"/absolute/project"}`. Library exports include `MemoryManager`, explicit compactor/resident layers, and narrow `resident-client`, `protocol`, and `hooks` entrypoints. The client and hook-normalization source closures exclude SQLite and provider execution.

## Authentication and configuration

Compaction follows the source agent runtime: **Codex/ChatGPT with `gpt-6-luna`**, or **Claude/claude.ai subscription with `haiku`**. slopmemr never reads/copies token stores, asks for API keys, or implements API-key login. Each CLI owns its authentication and refresh. There is no cross-runtime fallback. For Codex, API-key, logged-out, and other account modes are rejected before inference. The built-in provider and ChatGPT subscription endpoints are pinned. Inherited API-key and model-endpoint environment overrides are removed; apps, plugins, hooks, MCP servers, and execution features are disabled in the compactor configuration.

Claude uses a fresh nonpersistent CLI session in a private scratch directory. Safe/restricted mode, no built-in tools, strict empty MCP, disabled hooks/skills and subscription-only settings isolate the attempt. It checks `claude auth status`, rejects API-key/third-party modes, and validates that the output used a Haiku model. API/provider environment overrides are removed. Older CLI versions lacking the required isolation/profile protocol fail visibly. Claude Code 2.1.268 or later is required; validation uses 2.1.296.

Credentials and memory have different scopes. Each source record retains a profile reference; a parent summary uses the newest record’s runtime and profile in its covered range. Project memory remains shared, including earlier context from other runtimes; inference credentials and backend selection are separate. Workers use fresh ephemeral threads and separate processes, with global and per-profile concurrency limits. Their scratch directories contain no project checkout. Unexpected tool activity, auth changes, protocol errors, and timeouts fail the attempt. Raw provider errors and source-bearing request payloads are not printed in diagnostics.

| Variable | Default / meaning |
| --- | --- |
| `SLOPMEMR_RUNTIME_DIR` | `/tmp/slopmemr-<uid>`; private resident socket and ownership |
| `SLOPMEMR_DATA_DIR` | `~/.local/share/slopmemr`; durable root pools |
| `CODEX_HOME` | Calling Codex profile; defaults to `~/.codex` |
| `CLAUDE_CONFIG_DIR` | Calling Claude profile; defaults to `~/.claude` |
| `SLOPMEMR_CLAUDE_HOME` | Explicit Claude fallback for sources without a caller reference |
| `SLOPMEMR_CLAUDE_BIN` | `claude`; Claude compactor executable |
| `SLOPMEMR_CODEX_HOME` | Optional explicit fallback ChatGPT profile for records without a caller reference |
| `SLOPMEMR_CODEX_BIN` | `codex`; compactor executable |
| `SLOPMEMR_MODEL` | Codex model: `gpt-6-luna`; must be listed for the selected account |
| `SLOPMEMR_COMPACTION_CONCURRENCY` | `4` global attempts |
| `SLOPMEMR_AUTH_CONCURRENCY` | `2` attempts per canonical profile |
| `SLOPMEMR_COMPACTION_TIMEOUT_MS` | `120000` per attempt |
| `SLOPMEMR_MAX_ROOTS` | `32` open memories per resident |

Runtime/data directories must be absolute, private, and user-owned. Use distinct runtime directories when intentionally running separate resident configurations. Each root still has one OS-locked writer, even across residents. Source records remain loaded in memory while their pool is open; this version has no idle eviction, pruning, or retention policy.

The authentication/protocol adapter and installed native hooks were exercised against Codex CLI 0.162.1. [Native-agent evidence](docs/validation/native-agent.json) records a real Luna session, automatic resident startup, four retained observations and a ready snapshot. [Compaction evidence](docs/validation/subscription-compaction.json) records a successful synthetic Luna inference and provider usage. Both Codex witnesses use the existing ChatGPT login, without API keys or repository content. [Claude/Haiku evidence](docs/validation/claude-compaction.json) records a successful synthetic summary through the existing Claude subscription; it verifies the compactor, not a full native Claude session. These witnesses establish specific successful runs; they do not establish broad semantic quality or every operating system. [Authentication research](docs/research/compactor-auth.md) records primary sources and configuration traps.

Legacy Claude records carrying Codex-only profile references are retained, but those foreign references are not reused. An explicit `SLOPMEMR_CLAUDE_HOME` can recover their pending compaction. Updating the Claude registration replaces the old launcher’s Codex binding with its Claude profile.
