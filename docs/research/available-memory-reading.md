# Available memory and progressive discovery

**Purpose:** Check feasibility of returning available memory while background compaction continues.
**Audience:** Product and implementation contributors.
**Status:** Research, 2026-10-14; wayfinder planning only, no implementation accepted here.
**Authority:** The user's latest requirement selects available memory plus freshness/update status. UNII owns its core semantics; proposed wrapper names below remain advisory.
**Lifecycle:** Revisit when timestamp semantics, UNII readiness or MCP exposure changes.

## Available prefix without changing UNII

The requested behavior is feasible with existing UNII methods. In one synchronous resident operation after acquiring the pool, capture status, request the desired snapshot, and, if incomplete, request its completed prefix:

```text
status = memory.status()
requestedBefore = suppliedBefore ?? status.count
requested = memory.snapshot({ before: requestedBefore, view })
available = requested.state === "ready"
  ? requested
  : memory.snapshot({ before: requested.coveredThrough, view })
```

`requested.coveredThrough` is `min(requestedBefore, status.cursor)` when these observations are made without an intervening asynchronous yield. The second snapshot is ready because it requests only the completed prefix. This preserves the strict UNII contract and adds availability behavior at the application boundary. An invalid supplied boundary still fails validation; it must not be silently clamped to the record count. [Snapshot implementation](../../../unii/src/memory.ts), [normative readiness contract](../../../unii/spec/MEMORY.md).

Keep the original requested boundary and readiness in the wrapper. Returning only the shorter snapshot would falsely imply that all requested records were included. Do not implement this as separate client RPCs: appends and compaction could advance between the status, snapshot and timestamp observations. The resident can perform the synchronous reads together without a second storage owner or a wait for inference.

If nothing is ready, `available.before` is zero, `view` is empty and UNII renders `<chat>\n</chat>`. This is logically empty memory, not a readiness error. It can mean either no records exist or records exist but none form a completed prefix; status must distinguish those cases. A failed leaf after an older completed prefix must not hide that older memory. Leaves completed beyond a hole are not part of the contiguous snapshot. [Snapshot and rendering](../../../unii/src/memory.ts), [tree renderer](../../../unii/src/tree.ts).

## Small wrapper proposal

The smallest change to the existing response is an envelope around the available snapshot, plus the original requested state and status. Avoid duplicating large data or requiring a second status call:

```text
{
  memory: <ready UNII snapshot at available boundary>,
  freshness: {
    requestedBefore,
    requestedState: "ready" | "pending" | "failed",
    recordCount,
    latestRecordReceivedAt: string | null,
    coveredRecordReceivedAt: string | null
  },
  compaction: { active, pending, failedCount }
}
```

`memory.before`/`memory.coveredThrough` identify what was actually returned. `requestedState` describes coverage of the user's requested boundary, not success of the API call. Missing requested coverage is `requestedBefore - memory.before`; distance from all recorded input is `recordCount - memory.before`. With an explicit historical boundary, these differ. A complete historical request can coexist with newer records outside that request.

`active`, `pending` and `failedCount` are the existing global UNII job observations, not mutually exclusive lifecycle states. Pending includes unresolved work and can include active/failed entries; do not add these counters together as a backlog total. Parent work can remain active or failed even when every record is covered. Consequently `requestedState: "ready"` does not mean background compression is idle, and `active: 0` alone does not mean everything is fresh. The wrapper should return normal success for pending/failed coverage and reserve operational errors for invalid input, inaccessible/corrupt storage or unavailable transport. [UNII status and scheduling](../../../unii/src/memory.ts).

If presenting friendly labels, `pending` with zero active jobs means waiting/unresolved work, not ongoing inference. `updating` can describe active UNII jobs, but even those can be local verbatim commits or wait inside the backend for admission; they do not prove a live provider request. `blocked` should describe a terminal failure preventing the requested prefix (`requestedState: "failed"`), not any failed parent anywhere. Background parent compression and prefix freshness are separate axes; a single status enum would hide valid combinations.

This proposal does not rename or remove zoom. Zoom remains aligned binary-tree navigation; a leaf returns raw input. If zoom is called only on an address returned in the available snapshot, its children already exist because recovered parent nodes require their children. An arbitrary other range may lack children. The user's snapshot availability requirement does not by itself specify a new result for such arbitrary zoom requests. [UNII open validation and zoom](../../../unii/src/memory.ts).

## Timestamp meaning and limits

`Memory.date(id)` returns the record's stored `date`. `append()` assigns it from `new Date(now()).toISOString()` when processing the append; every split record from that append receives the same value. Therefore:

- `latestRecordReceivedAt = count > 0 ? date(count - 1) : null`.
- `coveredRecordReceivedAt = coveredThrough > 0 ? date(coveredThrough - 1) : null`.
- These are **record ingestion times**. They are neither native event occurrence times nor summary creation/completion times.

The names above make that distinction explicit. “Latest” means last record by ID, not the maximum wall-clock timestamp: clock adjustments can make timestamps nonmonotonic. Record counts and boundaries remain the authoritative freshness measures. `date()` avoids copying the whole `records()` array just to fetch endpoint timestamps. [Append/date implementation](../../../unii/src/memory.ts), [record and summary types](../../../unii/src/types.ts).

UNII summary nodes contain their address and text, with no summary-created timestamp. Existing persisted date decoding only requires a string, so imported/legacy values are not automatically proven to be valid ISO timestamps. A strict timestamp output schema needs explicit validation and an unknown/null policy, not an unchecked cast. Do not invent a completion time from a source record's date. Native event occurrence time would require additional provenance and a separate contract; it is not recoverable from `Memory.date()`. [UNII storage validation](../../../unii/src/memory.ts), [slopmemr record schema](../../src/memory/storage.ts).

The earlier lazy-open caveat remains: opening a pool can write identity/storage metadata and resume recovered provider work. The wrapper itself adds no new pump, wait or scheduler. [Memory manager](../../src/memory/manager.ts), [previous investigation](memory-reading-api.md#exact-read-only-and-lifetime-caveat).

## What Hulymcp progressive discovery actually does

Hulymcp's proxy surface has four catalog/dispatch operations:

| Operation | Information revealed |
| --- | --- |
| `list_tool_categories` | Categories, descriptions and counts. |
| `search_tools({query, limit?})` | Matching tool names, descriptions and required/optional parameter names. |
| `get_tool_schema({toolName})` | One exact input schema, output schema and annotations. |
| `invoke_tool({toolName, arguments?})` | Dispatch through the registered operation and its validation. |

Search matches catalog metadata, including parameter names. It does not search project content. Schema discovery does not dynamically install new MCP tools: operations remain callable through the generic invoker. A client already knowing the exact operation and arguments can invoke directly; discovery is not a mandatory handshake. [Proxy definitions and dispatch](../../../hulymcp/src/mcp/proxy-tools.ts), [catalog search](../../../hulymcp/src/mcp/proxy-tool-catalog.ts).

Hulymcp supports `auto`, `native` and `proxy` exposure. Its current auto mapping gives native exposure to exact `claude-code` clients and proxy exposure to Codex and most other clients. Scoped native exposure and proxy candidate exposure have separate logic; proxy defaults can expose the full registry. This is an implementation choice for a large application, not a requirement to copy its client-name branching or broad registry into slopmemr. Any slopmemr invoker must use only the intended reading registry, never the full resident/admin operation union. [Mode selection](../../../hulymcp/src/mcp/tool-mode.ts), [visibility and candidate selection](../../../hulymcp/src/mcp/protocol-tool-exposure.ts).

For a tiny catalog, the smallest equivalent progressive design is **two public MCP tools**, provisionally named `discover` and `invoke`:

```text
discover({ operation? })
  absent operation -> concise catalog: names, descriptions, parameter names
  exact operation  -> full input/output schema and annotations
invoke({ operation, arguments }) -> typed registered operation result
```

This preserves Hulymcp's catalog → exact schema → invocation sequence while combining its search/category/schema surface for a catalog small enough to list completely. No catalog search engine, categories or client-name heuristics are needed initially. It is an advisory minimal design, not an approved tool count. If literal Hulymcp compatibility is required, retain its four proxy names and shapes instead; do not call ordinary `roots` enumeration progressive capability discovery. CLI subcommands can use the same operation registry and schemas while exposing their details through `--help`.

## Remaining user decisions

The latest answer already resolves the main behavior: return the available completed prefix immediately, include freshness/update information, and return empty memory normally when that prefix is empty. No further question about waiting versus rejecting incomplete snapshots is needed.

Most remaining details are engineering choices: wrapper names, exact discovery names, zero-prefix rendering, registry reuse and coherent sampling. Recommend the small envelope and two-step catalog/schema discovery above without another naming questionnaire. The previous four direct tools are not an accepted constraint.

Only clarify these points if they are part of the intended product promise:

- If “like hulymcp” requires its exact four-tool protocol or its host-dependent native/proxy behavior, the minimal two-tool proposal is insufficient. Otherwise the progressive discovery principle is implementable without more user input.
- If freshness must mean original native-event time or summary completion time, ingestion timestamps do not satisfy it; additional provenance/persistence is required. Otherwise clearly labelled receipt times and record boundaries meet the available evidence.
- If “no readiness error” must cover arbitrary zoom ranges as well as the main memory read, the result for absent child summaries needs a separate choice. Navigating only addresses returned by available memory avoids that ambiguity.

No source files were changed or live provider calls performed for this investigation. The existing research note's strict-read recommendations are superseded for the user-facing memory read by the latest availability requirement; its description of UNII itself remains valid.
