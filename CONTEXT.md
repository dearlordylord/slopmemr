# Project memory

Persistent memory for a calling agent's project, shared by agents working on that project. Available memory remains useful while newer observations are still being summarized.

## Language

**Project memory**:
The retained observations and summaries belonging to one real project root. Moving that root preserves its memory; linked worktrees belong to their primary working copy's memory.
_Avoid_: session memory, worktree memory

**Snapshot**:
A summary of the available contiguous prefix up to a requested record boundary, accompanied by actual coverage and processing status.
_Avoid_: complete history, relevance search result

**Covered prefix**:
The uninterrupted sequence of records from the beginning whose summaries are available. A later completed record cannot bridge an earlier missing summary.
_Avoid_: latest completed record

**Zoom**:
Navigation from a summarized range into its two child ranges, continuing down to original records. Available child summaries remain useful when a sibling is still being processed.
_Avoid_: full-range dump, search

**Coverage freshness**:
How much of the requested record sequence the available memory covers. It is separate from whether summary compression is currently running.
_Avoid_: last model call time

**Record ingestion time**:
The time an observation entered the retained record sequence. It does not establish when the original event occurred or when its summary was generated.
_Avoid_: summary creation time, source event time
