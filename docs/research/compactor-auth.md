# Compactor authentication and worker isolation

**Purpose:** Identify feasible compaction adapters and authentication ownership.
**Audience:** Contributors and product owners.
**Status:** Research completed 2026-10-12; inference not exercised.
**Authority:** Source inspection and advisory findings; implementation owns the selected behavior.
**Expected use:** Choose and review the resident compactor boundary.
**Lifecycle:** Review when supported agent runtimes, Codex protocol, or credential handling changes.

Later implementation validation ran one synthetic `gpt-6-luna` compaction through the existing ChatGPT login. It returned a 303-byte summary without API keys or repository content. The sanitized [validation artifact](../validation/subscription-compaction.json) records that narrower evidence separately from this advisory investigation.

## Original Codex recommendation

This recommendation predates the user’s 2026-10-14 correction: Claude callers now use Claude subscription/Haiku, and Codex callers use Codex ChatGPT/Luna. No cross-runtime authentication fallback is allowed. The Codex findings below continue to apply to that adapter.

Use the calling Codex installation's app server and ChatGPT subscription credential profile first. The user explicitly excludes API-key usage; no API-key fallback is in scope. This reuses its authentication without extracting refresh tokens. Keep memory ownership separate: one memory belongs to the calling agent's canonical repository root, shared across that root's sessions and linked worktrees. Worker reuse belongs to a credential profile and configuration generation. Two profiles must never share an authenticated worker, even when they contribute to the same root memory.

This is a design recommendation. A resident does not automatically inherit the environment of later callers. Carry an explicit credential **reference**, such as the caller's absolute Codex home, with dispatch; do not assume the resident startup environment represents every caller.

## Candidate adapters

| Candidate | Classification | Finding |
| --- | --- | --- |
| Codex app server with caller profile | DEPEND ON | Best first adapter for Codex callers; delegate login lifecycle to Codex. |
| Explicit API credentials | REJECT | Excluded by the user's subscription-only requirement. |
| Host-managed ChatGPT tokens | OPTIONAL INTEGRATION | Experimental protocol; requires a real token refresh owner. |
| Scraping arbitrary agent OAuth stores | REJECT | No established cross-runtime contract; credentials need not be transferable provider API credentials. |
| UNII backend boundary | DEPEND ON | Already owns compression scheduling, retries, cancellation and observations. |

Codex supports multiple authentication methods, but this project must accept only ChatGPT authentication. Its credential storage can be file, OS keyring, automatic, or process-only. File storage lives under `CODEX_HOME`; therefore reading `auth.json` alone cannot support every caller. Process-only authentication cannot be recovered by spawning a sibling process. The safe first scope is an explicitly selected local profile; missing subscription credentials produce a visible failure. [Official authentication documentation](https://learn.chatgpt.com/docs/auth).

Externally managed token login uses `account/login/start` with `chatgptAuthTokens` and experimental initialization. Its refresh request expects the host to supply renewed credentials. This is viable only if the calling integration already owns that lifecycle. It is not a general way to borrow another process's ephemeral login. The app server also exposes model discovery; model availability requires checking the selected account. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server).

A separate Sign in with ChatGPT integration can pass its own OAuth access token through a configured Responses provider, then restart the worker when the token changes. This requires a registered application and its own token management; it does not establish that arbitrary cached Codex credentials can be reused as API tokens. [Official token-sharing app-server guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

## Local evidence and implementation implications

- [`../../../unii/src/types.ts`](../../../unii/src/types.ts) defines `Backend(request, signal, emit): Promise<string>`, with source, context, prior responses and validation feedback. The adapter should return summary text and forward cancellation and usage. [`../../../unii/src/memory.ts`](../../../unii/src/memory.ts) owns scheduling; avoid adding a second durable compaction queue.
- [`../../../jev/packages/resident-runtime/src/resident/authorization/credentials.ts`](../../../jev/packages/resident-runtime/src/resident/authorization/credentials.ts) checks credential generation at dispatch. Borrow this stale-reference principle; do not import its advice-delivery machinery.
- The available `../slopchat` master checkout contains no app-server or Luna implementation in its maintained source or design documents. Reuse cannot be verified from this checkout.
- Installed `codex-cli 0.162.1` generated JSON schemas successfully with `codex app-server generate-json-schema --experimental`. `ThreadStartParams` includes `ephemeral`, `model`, `config`, `sandbox`, and `approvalPolicy`. This verifies protocol shape, not login or inference.

Use an ephemeral thread for each compression attempt, a dedicated harmless working directory, denied approval requests, and explicit tool/config restrictions. Accept summary text only after a completed turn; interruption, failure, unexpected execution, malformed output and timeout must reject the attempt. Close workers on resident shutdown and invalidate them when authentication selection changes. Keep credentials out of memory records, checkpoints and diagnostics.

The requested Luna family should remain an explicit configured model selection, resolved against the worker's model catalog. Do not silently substitute another model when it is unavailable. Live account entitlement and compaction quality remain unverified by this research.

## Codex local hook observation

`hooks.json` nests event arrays beneath `hooks`; each event entry contains optional `matcher` and a `hooks` handler array. Command handlers receive a JSON stdin object. User and trusted project hooks coexist; installing project hooks does not replace user hooks. Changed definitions require Codex hook trust review. [Official hook configuration](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks).

| Event | Additional input |
| --- | --- |
| `SessionStart` | `source`: startup, resume, clear, or compact |
| `UserPromptSubmit` | `turn_id`, `prompt` |
| `PostToolUse` | `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response` |
| `Stop` | `turn_id`, `stop_hook_active`, nullable `last_assistant_message` |

Shared fields are `session_id`, nullable `transcript_path`, `cwd`, `hook_event_name`, and `model`. The listed events also carry `permission_mode`. **`agent_id` is not a documented common field:** it belongs to `SubagentStart` and `SubagentStop`. Subagent hooks use their parent's `session_id`; those two events provide subagent identity, and `SubagentStop` provides nullable `agent_transcript_path` and `last_assistant_message`. Treat transcript formats as unstable. An observational hook should emit no model-facing context or blocking decision. [Official hook input and event contracts](https://learn.chatgpt.com/docs/hooks#common-input-fields).

## App-server configuration isolation on installed 0.162.1

`codex features list` establishes these actual flag names. Start the compactor with explicit false overrides for `shell_tool`, `unified_exec`, `apps`, `plugins`, `hooks`, `multi_agent`, `multi_agent_v2`, `code_mode`, `code_mode_host`, `browser_use`, `computer_use`, `image_generation`, `view_image`, `sleep_tool`, `goals`, `skill_search`, `tool_suggest`, and `memories`. Also disable any enabled experimental tool or execution features discovered in the effective profile. Do not use removed `js_repl` or `tool_search` switches as isolation controls. CLI `--disable NAME` supplies a process-local feature override; it does not persist the change. [Official CLI override contract](https://learn.chatgpt.com/docs/cli/reference).

Set `web_search="disabled"` and `tools.view_image=false`. Disable every effective MCP server using the whole-table inline override below. Disable plugins and apps at the feature level rather than relying on default app settings that individual app overrides can supersede. [Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

An offline stdio probe initialized app-server and called `config/read` without starting a thread or inference. It confirmed that `-c mcp_servers={}` **retains inherited MCP entries**, while `--disable plugins --disable apps --disable hooks` appeared false in the effective configuration. Therefore an empty table is insufficient. Discover effective MCP identifiers, then restart with explicit per-server overrides before creating a compression thread. Inspect `config/read` again and reject a worker whose effective restrictions differ from the requested restrictions. Avoid printing effective config values: credentials and source-bearing configuration may be present.

These controls substantially restrict available capabilities, but this research does not establish a single supported switch that removes every built-in tool. Read-only sandboxing still permits reads, and denied approvals do not intercept tools that need no approval. Reject unexpected tool activity and cancel the attempt, but do not describe that as proof that side effects could never occur. No live inference or tool-execution isolation test was performed.

## Subscription-only enforcement

Set process overrides `forced_login_method="chatgpt"`, `model_provider="openai"`, `openai_base_url="https://chatgpt.com/backend-api/codex"`, and `chatgpt_base_url="https://chatgpt.com/backend-api/"`. Remove `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, and `OPENAI_BASE_URL` from the child environment. Never expose API-key login, custom-provider selection, or fallback. Verify effective config before creating threads; reject a mismatch. These are recommendations for this user scope, rather than a claim that account type alone guarantees billing behavior.

The installed protocol's `account/read` response distinguishes `apiKey`, `chatgpt`, and `amazonBedrock`. Require `account.type === "chatgpt"` and `requiresOpenaiAuth === true`, with `refreshToken:false` for the admission check; reject null or any other account type. Monitor account updates and stop a worker when its mode changes away from ChatGPT. [Official account protocol](https://learn.chatgpt.com/docs/app-server#authentication-endpoints).

Built-in provider IDs are reserved: a custom `model_providers.openai` cannot replace the built-in. However, `openai_base_url` explicitly overrides that built-in's endpoint. Consequently, `model_provider="openai"` plus a ChatGPT account is insufficient to establish the intended destination when inherited endpoint overrides exist. Pin the Codex subscription endpoint rather than forwarding the caller's proxy or API URL. [Official provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference#model_providersid).

An isolated temporary `CODEX_HOME` probe on 0.162.1 accepted the forced ChatGPT login, built-in provider, and pinned Codex endpoint; `config/read` returned those exact values. With no credentials, `account/read` returned null and `requiresOpenaiAuth:true`. Adding `model_providers.openai.base_url` caused startup rejection. The probe performed no inference and never opened or mutated the user's auth store. It does not verify successful subscription usage or billing. Direct gateway routing can be valid for ChatGPT credentials, but validating arbitrary gateways is outside this project's initial scope. [Official ChatGPT gateway routing](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway).

A separate isolated mutation probe created `auth.json` with an invalid sentinel API key, started the forced-ChatGPT worker, initialized it, and requested `account/read` with refresh disabled. The account was null; after termination, the auth file still existed with identical bytes. This verifies no file mutation on that tested startup/read path in 0.162.1, rather than every credential-store implementation. Never send login/logout RPCs to a caller-owned profile. An unforced, no-refresh account preflight can distinguish incompatible login from absent login when useful, before starting the restricted worker.

Effective feature values need shape-aware validation: the installed `multi_agent_v2` setting may be an object with `enabled:false`, rather than a boolean. Validate its enabled member. Configuration responses may omit `tools.view_image`; validate the effective `features.view_image` disable flag instead of interpreting absence as proof of enforcement.

## Exact MCP override encoding

The CLI's dotted `-c` key parser does not honor TOML quoted path components. On 0.162.1, `mcp_servers."simple".enabled=false` creates the wrong key and fails startup with invalid transport; a quoted dotted identifier is also split incorrectly. Use one argv value containing a TOML inline table instead:

```text
mcp_servers={"simple"={enabled=false},"with.dot"={enabled=false}}
```

This merges the disabled state into each inherited server while preserving its existing command/URL configuration. Generate it only from discovered identifiers, using TOML basic-string escaping for keys; do not copy credential-bearing server values. For ordinary valid Unicode identifiers, `JSON.stringify(name)` provides suitable quoted keys. Reject malformed Unicode rather than constructing invalid TOML. Pass the generated string directly as an argv element following `-c`, never interpolate it into shell source.

An isolated offline probe verified exact identifiers containing dots, quotes, backslashes, spaces, and accented Unicode. All identifiers remained unchanged, all servers became disabled, and inherited transport fields remained present. No threads, MCP subprocesses, or inference were started. An empty table has no disabling effect; discovery followed by this merged override and effective-config validation is required.

## Claude adapter, 2026-10-14

Installed Claude Code 2.1.296 supports subscription-preserving safe/restricted mode, print-mode JSON streaming, disabling tools, strict empty MCP, custom system prompts, and nonpersistent sessions. The installed `--bare` help explicitly excludes OAuth/keychain authentication, so that mode is unsuitable here. `claude auth status` supplies account method, provider and config-directory evidence; only a matching profile with `claude.ai`, first-party provider and forced `claudeai` policy is admitted. API/provider environment overrides are removed. The adapter uses `haiku`, validates the actual Haiku model family, and accepts harmless rate-limit information without treating it as a tool action. [Official CLI reference](https://code.claude.com/docs/en/cli-reference), [official authentication](https://code.claude.com/docs/en/authentication).

The [synthetic witness](../validation/claude-compaction.json) verifies successful subscription inference with tools/MCP disabled and no repository content or API keys. Raw provider output and credential stores are not retained in the evidence. Shared memory still includes cross-runtime project context; only backend/auth selection is separated.
