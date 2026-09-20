# Bound Routine windows and advance from the last successful boundary

Routine checks continue to use `interval_minutes`, but each execution window covers the time from the last successful processing boundary to now, capped at one hour. On the first check of a local calendar day, a Routine without a prior boundary starts at local midnight; if the gap is longer than one hour, later checks advance it incrementally instead of creating a backlog of tasks. This keeps startup bounded while preserving contiguous source-data coverage.

## Considered option

Creating every missed hourly window at startup was rejected because it can enqueue many Agent tasks at once and amplify provider load after an outage.

User-requested stopping is an explicit exception to ordinary failure retry: the stopped window is retained as a repair gap, automatic processing advances from its end when enough time has accumulated, and the repair task owns recovery of the abandoned range.

The scheduler computes `delta` as current time minus the latest automatic processing boundary. After a successful execution, it may create one next window immediately when `delta >= 1 hour`; otherwise the normal check cycle decides. After a user stop, it may create one next window immediately when `delta >= interval_minutes`. Each window is frozen at creation and capped at one hour; a Routine never has more than one queued, preparing, or running execution.

The Routine UI exposes a single idempotent “Stop Agent” action on the active execution row. It records the stop request, disables the action while termination is pending, and reports failure only when the underlying stop cannot be completed.
