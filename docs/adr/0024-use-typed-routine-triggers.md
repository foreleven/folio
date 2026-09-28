# Use typed Routine triggers and keep schedule state separate from Tasks

Routine execution is no longer modeled as an interval-only scheduler. A Routine owns a typed `trigger`: `schedule` carries its check cadence, while the first supported event trigger is `{ type: "event", signal: "raws-changed" }`. This Signal is a Vault-scoped wake-up hint whose delivery and reconciliation semantics are defined in ADR-0025; the trigger deliberately has no provider-specific matching fields.

The `raws-changed` trigger is also the persisted identity of the Vault's system Raw knowledge intake Routine. Folio adds no `system`, `builtin`, or Knowledge-specific Routine type column: a database uniqueness constraint permits at most one Routine with this trigger, and Vault initialization ensures that one exists. The trigger therefore determines its protected system behavior as well as its wake-up source.

Schedule configuration keeps its interval and named time zone together inside `trigger`, rather than requiring a top-level Routine time zone for future non-schedule triggers. The global display time zone seeds a newly created schedule; editing that global setting later does not rewrite the Routine. Each schedule row freezes the time zone actually used for its window.

Tasks remain the durable work units. They keep their `routine_id`, but no longer store scheduler-only `routine_date`, `window_start`, `window_end`, or `is_end` columns. A schedule-created Task reads its frozen window from its associated schedule record, not a duplicate in Task configuration; retries and workers use that original input even if the Routine changes later. The local date is derived from that window and its frozen timezone.

The remaining Task-level Routine provenance is `routine_id` and the revision frozen when the Task was created. Scheduled trigger time and timezone belong to `routine_schedules`; `first_trigger_time`, `trigger_count`, and `routine_updated_at` are removed rather than kept as duplicate or presentation-only Task state. Event-created Tasks have no schedule row or schedule-specific window. A Knowledge Task instead freezes its raw Git endpoints in immutable Task configuration as described by ADR-0029.

Each schedule trigger retains a `routine_schedules` row bound to its Task and exact window. Consecutive windows create distinct rows rather than overwriting the previous one. The window in this row is authoritative and is not copied into Task configuration. The table does not duplicate `routines.next_trigger_at`, and no generic dispatch table is introduced for event triggers.

Routine execution history queries `tasks` by `routine_id`, then left-joins its optional schedule and latest Agent Run. Event Tasks therefore appear in the same history without fabricated dates, windows, or timezone data. Their UI date groups use Task creation time in the saved global display timezone; scheduled Tasks retain their frozen window timezone. Agent Run success does not mark an event Task complete while its Wiki publication is still pending.

There is no separate `processing_boundary` column: the next window is determined from retained windows and their associated Task outcomes. Failed windows retain their identity for retry instead of advancing a second cursor independently.

Removing `is_end` also removes the Routine calendar's whole-day success and missing-day inference. A successful window is not evidence that an entire local day was processed. The UI presents the actual scheduled windows and their Task outcomes; handling windows left over from a previous day remains a separate future workflow.

## Consequences

Adding a new event trigger does not require adding scheduler columns to Tasks. Each event type must define its own wake-up and reconciliation contract without turning Tasks into a generic event ledger. Schedule recovery can inspect each retained Task/window association without inferring a window from mutable raws or Routine settings.
