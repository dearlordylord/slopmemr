# Installation contract

Purpose: install slopmemr hooks and a runtime that survives removal of the development checkout.
Authority: behavioral contract for src/installation; native hosts retain control of hook trust and authentication.
Expected use: consult before modifying setup/update/uninstall or their tests.
Lifecycle: update with installation format, launcher, native host or recovery changes.

`pnpm dev-install -- --runtime codex` builds a standalone Node 24 ESM bundle, runs setup and exposes `~/.local/bin/slopmemr`. For Claude use `--runtime claude`; its native profile supplies the existing Claude subscription for Haiku. Codex uses its own ChatGPT profile for Luna. CLI profile overrides must match the selected runtime. The parent development folder remains named slopmem.

Setup selects a native profile, preserves unrelated hook settings, and installs handlers for SessionStart, UserPromptSubmit, PostToolUse, Stop and SubagentStop. Codex owns enabling its hooks feature through `codex features enable hooks`. The user reviews trust in the native host when required. Setup does not login, request a key, start inference or start the resident. Claude defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`; its launcher embeds `--claude-home`. Old Claude installations are rebound on update without borrowing their former Codex login. The first observation starts the resident automatically.

The installed hook command always points to `/bin/sh` and a stable profile-local `.slopmemr/<runtime>/hook-launcher.sh`. The launcher points to an immutable bundle under the selected data directory's `runtime/<sha256>/slopmemr.mjs`. Codex and Claude registrations can coexist in one profile directory. The bundle includes Effect, the Node adapter and UNII; build rejects external non-Node dependencies. Their license notices accompany every immutable snapshot. Runtime paths are shell-quoted, including apostrophes.

The shared public command has its own destination-local `.slopmemr` lock, ownership and recovery journal, so choosing a different memory directory cannot create a second publisher for the same command. Public-command conflicts are checked before changing native registration.

A SQLite BEGIN IMMEDIATE transaction owns each profile installation until completion. Never unlink the lock database: contenders must open the same inode. Atomic file writes use private exclusive temporary files, fsync the file, rename, and fsync the directory. Journals contain expected ownership and runtime references, never complete native settings or credentials.

Install order is journal → launcher → native handlers → ownership → journal removal. Uninstall order is journal → handler removal → launcher removal → ownership removal → journal removal. A failed operation leaves a journal. Repeating the same operation reconciles the current configuration, preserving unrelated edits made after the interruption. Changing operation while recovery is pending fails. Recovery accepts only the journal's old/new launcher digests and exact owned handlers; changed or duplicate handlers require reconciliation.

Object key order does not determine ownership. Array order does. Repeated setup/update preserves the existing handler position. Missing handlers are permitted during recovery and uninstall; a normal update treats them as a conflict. Optimistic reread detects native configuration changes before publication, but external editors do not share the installation lock, so this is not a filesystem compare-and-swap.

`slopmemr doctor codex|claude` reads registration, launcher and snapshot state. It does not create directories, acquire a lock, launch the resident or probe authentication. `slopmemr uninstall ...` removes owned registration and its profile launcher, retaining project memory and immutable runtime snapshots. Codex's enabled hooks feature and the shared public command remain available for other registrations.

Update selects a new snapshot for subsequent launches. A running resident retains its current implementation until graceful shutdown or process exit; `slopmemr stop` drains accepted operations, and the next hook starts the selected runtime. Ping identifies application, protocol, version and implementation digest, and clients validate responses against the requested operation.

Offline installed-artifact validation is `pnpm test:installed`. Explicit live native-agent validation is `pnpm test:native`; it uses a synthetic project, a temporary native profile referencing Codex's existing ChatGPT login, and Luna. The live witness never decodes or copies credentials and retains source-free evidence in docs/validation/native-agent.json.
