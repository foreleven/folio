# Persist Task summaries for the Vault feed

The Vault overview feed uses one entry per Task and reads a durable summary snapshot rather than reconstructing results from current raws files. Agent Tasks update the summary from the latest terminal execution Run's outcome and discovery, if any; Ingestion Tasks update it from the frozen source window and publication outcome. Every summary also carries a typed publication result: raws reference their save operation, while Wiki changes may reference both the save and synchronization operations. This preserves what a Task reported even when later Ingestion windows merge, revise, or delete raw material, while leaving messages, receipts, and Git records as the detailed audit sources.

## Consequences

The summary is replaced when a newer stable result is produced, so the feed remains a concise Task-level view rather than a second execution log. Summary data must therefore be typed and include its source identity/time; historical detail remains available through the Task and Run views.

No-change Ingestion summaries remain in the feed so routine health is visible, but render as compact activity rows. Ingestion with raw changes, failures, conflicts, or cancellation receives the full result-card treatment.

The first Feed version is read-only. It does not navigate to, select, retry, stop, or otherwise operate a Task; Task details and controls remain in the existing Tasks area until a separate interaction decision is made.

An Agent discovery is extracted from the final complete assistant message of a Run, never from thought or tool-call messages. Failed, cancelled, or interrupted Runs may retain their last assistant content with `incomplete: true`; when no assistant content exists, the summary contains only the Run outcome and error.

The durable summary retains the complete extracted discovery. The Overview card shows only a truncated preview of long content; the existing Task details remain the place to read the full message. Presentation truncation must not discard summary data.

Feed ordering uses `Task.createdAt` for every Task type. Ingestion window timestamps remain summary facts but do not move an entry when the Task is retried or its summary is updated.

The read-only feed loads the newest 30 Tasks first, then paginates older Tasks by the stable `(createdAt, id)` descending cursor. It does not permanently truncate history or fetch every Task on initial render.

Feed date grouping uses a globally persisted display time zone, not the live device time zone. On first initialization the application reads the system's named time zone and saves it as the default; later system time-zone changes do not silently regroup Task history. Scheduled window labels still use the time zone frozen with that schedule record.

The global time zone also seeds newly created Routine schedules. Changing it does not rewrite existing Routine settings or previously frozen schedule windows.

The Overview is a read-only result feed rather than a second navigation page: its previous welcome copy, Vault path card, and module shortcut cards are removed because the workspace Sidebar already provides navigation.

Tasks appear in the feed from creation, even before a summary exists. Pending or running Tasks render as compact live status rows; failed or cancelled Tasks remain visible with their status and error even if no assistant discovery exists. The durable summary records stable outcomes, while in-progress state is read from the Task/Run lifecycle rather than saved as a completed result.

For an Agent Task, the terminal Run writes its execution outcome and extracted discovery immediately. Later Wiki save and synchronization transitions update the `publication` portion of that same Task summary, including a no-change result when publication is not required. These updates do not create additional feed entries or change the Task's position.

Attribution of Wiki publication across multiple sequential Runs of the same Agent Task is deferred to later Agent Task design. This decision does not specify how an older Run's later save interacts with a newer Run's Task summary.

A later terminal Agent Run replaces the previous Task summary's execution result and discovery as one latest-result snapshot. There is no separate last-successful-discovery slot: if the newest Run fails without assistant content, the feed shows that failure, and the earlier discovery remains only in the Session history.

The existing `conflict-resolution` Run remains attached to its original Agent Task for now. It is not an execution Run for Feed discovery purposes and must not replace that Task's execution outcome or discovery. Conflict resolution architecture, including a possible separate built-in Routine, is deferred; this Feed work does not change its current workflow.

An Ingestion summary records only facts Folio can verify at completion: the frozen window, attempt count, terminal outcome/error, whether raws changed, and the number of changed raw files. The Integration ingestion interface does not return a source-record count, so the feed must not claim a number of messages or emails or infer one from the current raws projection.
