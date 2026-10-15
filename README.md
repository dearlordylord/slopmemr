# slopmemr

Persistent project memory for Codex and Claude Code. slopmemr captures observations through native hooks, keeps the original records locally, and builds compact summaries that agents can read through MCP or the CLI.

Memory belongs to the project: sessions, child agents, and both supported runtimes share the same pool. Linked Git worktrees share their primary working copy's memory; independent clones get separate pools.

## Install

An npm package is prepared for publication as `@firfi/slopmemr` (Node 24+). Until it is published, use the standalone archives below.

Download and unpack the archive for your platform from [GitHub Releases](https://github.com/dearlordylord/slopmemr/releases), then register your agent:

```sh
./bin/slopmemr install codex
# or
./bin/slopmemr install claude
```

The archives include Node. You need the selected agent's CLI and an existing subscription login:

- **Codex:** ChatGPT login, with Luna for compaction.
- **Claude Code:** Claude subscription, with Haiku for compaction. Claude Code 2.1.268 or later is required.

No API key is requested or used. Each runtime uses its own login; Claude-only use does not require Codex.

Installation registers native hooks and four MCP tools. The first observation starts the local resident automatically. Complete the agent's native hook trust review if prompted, and add `~/.local/bin` to your PATH for the inspection commands below.

Use `--profile /absolute/profile` to select a different agent profile. Defaults follow `CODEX_HOME` or `~/.codex` for Codex, and `CLAUDE_CONFIG_DIR` or `~/.claude` for Claude.

The v0.1.3 archives cover Linux arm64/x64 and macOS arm64/x64. Linux and Apple Silicon passed the recorded native package checks. **Intel macOS is experimental for hook latency:** functionality passed, but warm-hook p95 measured 439 ms against a 150 ms target. See the [platform evidence](https://github.com/dearlordylord/slopmemr/blob/master/docs/validation/platform-release.json).

## Use memory

At session start, the agent receives a tiny guide to reading memory. The installed MCP tools are:

| MCP tool | Purpose |
| --- | --- |
| `slopmemr_snapshot` | Read available project memory |
| `slopmemr_zoom` | Explore summaries or original records |
| `slopmemr_status` | Inspect processing, failures, and usage |
| `slopmemr_roots` | List remembered projects |

Memory snapshots are never injected automatically. Ask your agent to read memory when useful, or use the CLI:

```sh
slopmemr roots
slopmemr snapshot --root /absolute/project
slopmemr status --root /absolute/project
slopmemr zoom --root /absolute/project --first 0 --count 1 --page 0
```

Snapshots return available memory immediately, alongside coverage, freshness, and processing state. Newer records may still be awaiting compaction. An empty pool returns empty text. `slopmemr settle --root /absolute/project --wait-ms 20000` waits up to 20 seconds for active compaction and then returns the current snapshot.

Zoom uses aligned power-of-two record ranges: `first` must be divisible by `count`. A single record (`count=1`) returns a page of original text; larger ranges expose child summaries so the agent can descend into detail.

## What is retained

Hooks capture supplied prompts, tool inputs/results, and assistant stop messages. Records retain their runtime, session, and child identity when the host provides one. Reading slopmemr's own MCP tools does not feed their responses back into memory.

Original text is stored locally in SQLite. Material requiring compaction is sent through the source runtime's subscription to Luna or Haiku. Missing login or failed compaction preserves the originals. slopmemr delegates authentication and refresh to the native CLI and never copies token stores or falls back to the other runtime's credentials.

A local `.slopmemr-id` file gives each project a stable identity. Keep it when moving the project, and **do not commit it**. Linked worktrees use the primary working copy's file. A full filesystem copy that includes the file shares memory; a normal Git clone gets a new identity. Creating an identity requires a writable project root. For projects using older path-based memory, access the original location once after upgrading before moving it.

Memory defaults to `~/.local/share/slopmemr`. There is currently no automatic pruning or retention policy.

## Manage the installation

```sh
slopmemr doctor codex
slopmemr update codex --target /absolute/unpacked-package
slopmemr repair codex
slopmemr uninstall codex
```

Replace `codex` with `claude` as appropriate. Archive updates consume a downloaded package; they do not fetch releases. After upgrading the npm package, apply its build explicitly with `"$(npm prefix -g)/bin/slopmemr" update codex` to avoid selecting an older public launcher from PATH. Setup and updates preserve unrelated agent settings and reject modified slopmemr-owned handlers or launchers. Repeat an interrupted operation to recover. Uninstall retains memory.

For custom storage, set `SLOPMEMR_DATA_DIR` to an absolute private directory. `SLOPMEMR_RUNTIME_DIR` selects the private socket directory, normally `/tmp/slopmemr-<uid>`. See the [installation contract](https://github.com/dearlordylord/slopmemr/blob/master/docs/installation.md) for recovery, profiles, and resident lifecycle details.

## Development

slopmemr uses Effect 4 and UNII. Development requires Node 24, pnpm, Git, and a sibling `../unii` checkout:

```sh
pnpm --dir ../unii install --ignore-scripts
pnpm --dir ../unii build
pnpm install
pnpm dev-install -- --runtime codex
pnpm check-all
```

`pnpm npm:pack` creates the self-contained CLI tarball in `dist/npm`. `pnpm test:npm` installs it offline in a temporary npm prefix and exercises both native registrations after removing the npm installation. The development manifest stays private; publish only the staged tarball with `npm publish dist/npm/firfi-slopmemr-0.1.3.tgz --access public`.

Use `--runtime claude` for Claude Code. The installed runtime is an immutable snapshot and works independently of the development checkout.

`pnpm check-all` runs the repository's quality and installed-artifact gates. Provider witnesses are explicit opt-ins: `pnpm test:native` exercises a synthetic Codex session; `pnpm test:claude` exercises synthetic Claude/Haiku compaction. They use the existing subscription login.

See the [architecture](https://github.com/dearlordylord/slopmemr/blob/master/docs/architecture.md) and [authentication research](https://github.com/dearlordylord/slopmemr/blob/master/docs/research/compactor-auth.md) for implementation contracts and verification limits.
