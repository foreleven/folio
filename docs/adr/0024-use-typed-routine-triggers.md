# Use typed Routine triggers and keep schedule state separate from Tasks

Routine execution is no longer modeled as an interval-only scheduler. A Routine owns a typed `trigger`: `schedule` carries its check cadence, while `event` is reserved for future event-driven creation without committing to provider-specific matching fields. This change implements only `schedule`; an Event Routine is neither configurable in the UI nor accepted into persisted runtime state until event delivery and deduplication have been designed.

Schedule configuration keeps its interval and named time zone together inside `trigger`, rather than requiring a top-level Routine time zone for future non-schedule triggers. The global display time zone seeds a newly created schedule; editing that global setting later does not rewrite the Routine. Each schedule row freezes the time zone actually used for its window.

Tasks remain the durable work units. They keep their `routine_id`, but no longer store scheduler-only `routine_date`, `window_start`, `window_end`, or `is_end` columns. A schedule-created Task reads its frozen window from its associated schedule record, not a duplicate in Task configuration; retries and workers use that original input even if the Routine changes later. The local date is derived from that window and its frozen timezone.

The remaining Task-level Routine provenance is `routine_id` and the revision frozen when the Task was created. Scheduled trigger time and timezone belong to `routine_schedules`; `first_trigger_time`, `trigger_count`, and `routine_updated_at` are removed rather than kept as duplicate or presentation-only Task state. Event-created Tasks carry no schedule-specific fields.

Each schedule trigger retains a `routine_schedules` row bound to its Task and exact window. Consecutive windows create distinct rows rather than overwriting the previous one. The window in this row is authoritative and is not copied into Task configuration. The table does not duplicate `routines.next_trigger_at`, and no generic dispatch table is introduced for event triggers.

There is no separate `processing_boundary` column: the next window is determined from retained windows and their associated Task outcomes. Failed windows retain their identity for retry instead of advancing a second cursor independently.

Removing `is_end` also removes the Routine calendar's whole-day success and missing-day inference. A successful window is not evidence that an entire local day was processed. The UI presents the actual scheduled windows and their Task outcomes; handling windows left over from a previous day remains a separate future workflow.

## Consequences

Adding a new event trigger does not require adding scheduler columns to Tasks, but its matching and event-delivery contract must be designed separately. Schedule recovery can inspect each retained Task/window association without inferring a window from mutable raws or Routine settings.
