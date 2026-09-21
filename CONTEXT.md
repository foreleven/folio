# Folio execution context

This context defines Routine scheduling, source ingestion, and Agent execution terminology. It describes business meaning only; implementation details belong in the relevant ADRs and code.

## Routine scheduling

**Routine**:
A recurring definition that coordinates bounded work. A Routine does not imply that every stage requires an Agent.

**Execution window**:
The source-data time range assigned to one Routine execution. It begins at the previous successful processing boundary, or at local midnight for the first window of a day, never spans more than one hour, and belongs to exactly one Routine-local calendar date.

**Check cycle**:
The configured `interval_minutes` cadence at which the scheduler checks whether a Routine should create or advance an execution window. It is not the size of the execution window.

**Processing boundary**:
The end timestamp of the last successfully completed execution window for a Routine. A later window starts from this boundary.

**Daily catch-up**:
At startup or the first check of a local calendar day, the Routine advances from its processing boundary (or local midnight when none exists) toward the current time. Each execution advances by at most one hour; it does not create all missed windows at once.

When a previous boundary predates today's local midnight, the automatic window starts at today's midnight; unfinished windows from an earlier date are handled by a separate repair task.

**Processing boundary advancement**:
Only a successful execution advances the processing boundary during ordinary automatic scheduling. Failed or interrupted windows retain their original range and are retried as that same window.

For a user-requested Agent stop, the exception defined under **Cancelled Agent execution** applies: the stopped window becomes a repair gap and the boundary advances to its `window_end` for automatic scheduling. Stopping Ingestion never advances its source boundary.

**Window delta**:
The duration from the current time to the latest automatic processing boundary. After success, a delta of at least one hour can trigger one immediate next window; below one hour waits for the next check. After a user stop, a delta at least as long as `interval_minutes` can trigger one immediate next window. Every window remains capped at one hour.

## Agent control

**Task**:
A durable, isolated unit of work. Its kind determines whether Folio executes it through an Integration or an Agent.

**Task configuration**:
The immutable inputs frozen when a Task is created. Execution state, errors, timestamps, and commit receipts are not configuration.

**Routine configuration**:
The editable, revisioned inputs for one Routine executor type. A Task freezes the Routine configuration revision used to create it.

**Agent Task**:
A Task executed through an Agent Session and one or more Runs. Knowledge Routines create Agent Tasks.

**Ingestion Task**:
A Task executed directly by Folio through one Integration resource in an ingestion worktree. Its identity represents one frozen source window across retries, and it never owns an Agent Session or Run.

**Ingestion attempt**:
One try to execute an Ingestion Task. Attempts reuse the Task and worktree rather than creating a new Task identity.

**Automatic Ingestion retry**:
A normal check-cycle retry of the same failed or safely interrupted Ingestion Task. User-cancelled and conflicted Tasks require an explicit manual retry.
_Avoid_: Immediate retry loop

**Ingestion receipt**:
The typed JSON execution outcome of an Ingestion Task, including its current attempt state, attempt count, durable stop intent, and links to any Git change or no-change observed head. Commit trees and publication conflicts remain owned by the Git journal and synchronization records.

**Stop request**:
A user request to terminate the Agent execution associated with a Routine window. The request is recorded before the worker reaches its terminal state and is idempotent.

**Cancelled Agent execution**:
An execution whose Agent has acknowledged termination. Partial messages are retained and marked incomplete. For a user-requested stop, its window becomes a repair gap and automatic processing may continue from that window's end; the stopped window is not retried automatically.

**Cancelled Ingestion attempt**:
An Ingestion attempt stopped before canonical publication. Its Task, worktree, and exact window are retained, and the source boundary does not advance; a stop received after publication cannot reverse the successful result.
_Avoid_: Repair gap

**Repair gap**:
A source-data range intentionally left for a separate repair task after an execution is stopped or otherwise abandoned. Automatic Routine scheduling does not reopen it.

## Personal knowledge flow

**Ingestion**:
An Agent-free provider operation that captures a bounded slice of source data as committed raw material. The selected Integration owns provider access and source-specific extraction.

**Integration ingestion**:
The provider implementation that writes source data directly into a host-provided ingestion worktree directory for an exact window. It does not expose extraction Skills, prompts, executables, or credentials to an Agent.

**No-change Ingestion**:
A successful Ingestion whose source window produces no raw file change. It advances the source window without creating a Git commit or pending Knowledge work.
_Avoid_: Empty failure

**Ingestion Routine**:
A Routine kind that exclusively owns the Ingestion window timeline for exactly one Integration resource within a Vault. It succeeds when the resulting raw changes are committed and does not create an Agent Task.

**Agent Routine**:
A Routine kind that schedules work through Agent Tasks, Sessions, and Runs. Its business goal may be Knowledge organization or another Agent-driven workflow.

**Ingestion worktree**:
A host-owned isolated Git checkout in which an Integration materializes raw changes. It is not a Task workspace and does not imply an Agent Session or Run.

**Ingestion commit**:
A validated Git commit created in an Ingestion worktree. It is retained as execution and conflict evidence but is not a processing checkpoint.

**Canonical raw commit**:
The canonical Vault workspace commit after a successful Ingestion publication. Raw records and processing checkpoints refer only to canonical raw commits.
_Avoid_: Ingestion commit, source commit

**Raw publication**:
The journaled application of an Ingestion commit to the canonical Vault workspace. Its durable receipt allows raw records and the Ingestion Task receipt to recover without fetching the source window again.

**Published Ingestion**:
An Ingestion whose canonical raw commit and raw-state receipt are durable. It is successful even if worktree alignment or release still requires recovery.
_Avoid_: Cleaned-up Ingestion

**Raw conflict**:
A failed publication in which an Ingestion commit cannot merge into the canonical Vault workspace. The source window remains unprocessed and its worktree and commit are retained for repair.
_Avoid_: Last-writer-wins overwrite

**Knowledge organization**:
An Agent operation that transforms committed raw changes into personal wiki knowledge. It consumes raw material but does not fetch source data from the provider.

**Knowledge Routine**:
An Agent Routine whose business goal is Knowledge organization from pending raw changes. Its processing and batching semantics are deferred until that workflow is implemented.

**Raw material**:
Provider-derived source content committed to the Vault for later processing. Raw material is immutable input from the perspective of Knowledge organization.
_Avoid_: Agent output

**Daily raw projection**:
A provider-owned file that accumulates one Routine date's source state across multiple Ingestion windows. The Integration merges each window into the existing projection, while Git records the resulting content diff.
_Avoid_: Per-window raw chunk

**Source record ID**:
A provider-native stable identity retained in a daily raw projection so an Integration can deterministically add, update, recall, and deduplicate source records across windows and retries.
_Avoid_: Content-derived identity

**Raw record**:
The durable identity and current Git position of one canonical raw file. A deleted file remains as a tombstone because its removal is still pending source information for consumers.
_Avoid_: Ingestion batch

**Raw namespace**:
The canonical directory owned by one Integration resource and Routine date: `raws/<integration_id>/<resource_id>/<routine_date>/`. An Ingestion Task may not modify files outside its dated resource namespace.
_Avoid_: Provider-specific top-level raw directory

**Raw processing checkpoint**:
The last raw commit processed by one Knowledge Routine. Checkpoints are consumer-specific, so processing by one Routine does not acknowledge changes for another.
_Avoid_: Global processed commit
