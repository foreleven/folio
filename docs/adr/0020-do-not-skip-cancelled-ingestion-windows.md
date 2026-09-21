# Do not skip cancelled Ingestion windows

Stopping an Ingestion before canonical publication cancels only the current attempt: Folio terminates its provider process, retains the Task, worktree, window, and log, and does not advance the Routine boundary or create a repair gap. This deliberately differs from a stopped Agent execution because no durable source capture exists to justify skipping the window; canonical publication still wins a race with cancellation and remains successful.

The execution UI exposes one idempotent Stop action for both preparing and running Agent or Ingestion work, immediately presenting a disabled stopping state after the request. The backend routes that intent to the relevant executor, and a late stop cannot replace an already durable successful publication.
