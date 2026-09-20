# Folio execution context

This context defines Routine scheduling and Agent execution terminology. It describes business meaning only; implementation details belong in the relevant ADRs and code.

## Routine scheduling

**Routine**:
A recurring instruction that periodically asks an Agent to process a time-bounded slice of source data.

**Execution window**:
The source-data time range assigned to one Routine execution. It begins at the previous successful processing boundary, or at local midnight for the first window of a day, and never spans more than one hour.

**Check cycle**:
The configured `interval_minutes` cadence at which the scheduler checks whether a Routine should create or advance an execution window. It is not the size of the execution window.

**Processing boundary**:
The end timestamp of the last successfully completed execution window for a Routine. A later window starts from this boundary.

**Daily catch-up**:
At startup or the first check of a local calendar day, the Routine advances from its processing boundary (or local midnight when none exists) toward the current time. Each execution advances by at most one hour; it does not create all missed windows at once.

When a previous boundary predates today's local midnight, the automatic window starts at today's midnight; unfinished windows from an earlier date are handled by a separate repair task.

**Processing boundary advancement**:
Only a successful execution advances the processing boundary during ordinary automatic scheduling. Failed or interrupted windows retain their original range and are retried as that same window.

For a user-requested stop, the exception defined under **Cancelled execution** applies: the stopped window becomes a repair gap and the boundary advances to its `window_end` for automatic scheduling.

**Window delta**:
The duration from the current time to the latest automatic processing boundary. After success, a delta of at least one hour can trigger one immediate next window; below one hour waits for the next check. After a user stop, a delta at least as long as `interval_minutes` can trigger one immediate next window. Every window remains capped at one hour.

## Agent control

**Stop request**:
A user request to terminate the Agent execution associated with a Routine window. The request is recorded before the worker reaches its terminal state and is idempotent.

**Cancelled execution**:
An execution whose Agent has acknowledged termination. Partial messages are retained and marked incomplete. For a user-requested stop, its window becomes a repair gap and automatic processing may continue from that window's end; the stopped window is not retried automatically.

**Repair gap**:
A source-data range intentionally left for a separate repair task after an execution is stopped or otherwise abandoned. Automatic Routine scheduling does not reopen it.
