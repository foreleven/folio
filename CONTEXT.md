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

**Trigger**:
The mechanism that causes a Routine to create a Task. A schedule trigger checks time-based windows; an event trigger names a domain Signal such as `raws-changed` without embedding provider-specific matching data.
_Avoid_: Check interval, dispatch record

**Scheduled Task window**:
The source-data range frozen in the schedule record associated with a Task. It remains stable across Task retries; its local date is derived from the window start and timezone rather than stored as a separate Task fact.
_Avoid_: Routine date column, duplicated Task window

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
An Agent Routine whose business goal is Knowledge organization from pending raw changes. Its input is fixed from canonical raw history, and its completion advances that Routine's derived processing checkpoint.

**Raw knowledge intake**:
The single system-owned Knowledge Routine in a Vault that turns pending raw material into coherent Wiki assets. It owns entity extraction, source citation, relationship creation, and updates to existing Pages rather than splitting those concerns across competing raw consumers.
_Avoid_: Per-entity raw Routine

**Knowledge asset layer**:
The evidence-backed Wiki representation curated from raw material: stable entities, events, facts, decisions, relationships, and their source citations. It does not own action management or longitudinal reflection.
_Avoid_: Raw archive, action system, cognitive trajectory

**Project**:
A knowledge asset representing a sustained effort and its current lifecycle status. Its milestones are evidence-backed Events linked to the Project when they are discovered, not fields or placeholder Events created with the Project.
_Avoid_: Project deadline, automatic Milestone

**Person**:
A knowledge asset representing an individual. Email addresses and phone numbers are typed properties; organization membership uses a Knowledge link rather than duplicating an organization name as text.
_Avoid_: Company-name relation as text

**Organization**:
A stable knowledge asset representing a company, team, customer, supplier, or other named organization. Relationships between an Organization and people, Projects, or other assets use Knowledge links.
_Avoid_: Organization name embedded as a relation property

**Note**:
A generic knowledge asset for material without a stronger ObjectType. Its tags provide lightweight classification but never stand in for explicit links to people, Projects, or other assets.
_Avoid_: Tag-as-relationship

**Decision**:
An evidence-backed choice with a lifecycle status that remains part of the user's knowledge even when it implies later work. The default statuses are Proposed (`not_started`), Accepted (`complete`), and Superseded (`complete`). Unadopted alternatives and review discussion remain in the body or in Notes/Events rather than becoming rejected Decisions. A Decision links to its Projects, Meetings, people, and sources; it is not itself an action or Task.
_Avoid_: To-do, inferred intention

**Event**:
An evidence-backed occurrence with a time and relationships to relevant knowledge assets. Meetings are time-bearing knowledge assets, and other milestones or state changes may be represented as Events; a generic Event has no required classification field.
_Avoid_: Ingestion event, Signal

**Time-bearing asset**:
A Meeting, Decision, or Event that uses the shared `occurredAt` instant with an explicit UTC offset and links to related knowledge assets. Type-specific aliases and timezone-free local values are avoided so timelines can project assets uniformly.
_Avoid_: Per-type timeline fields

**Page property**:
A typed scalar or option value describing one Wiki asset. The basic kinds are text, number, checkbox, date, datetime, URL, email, phone, select, multi-select, and status. Select-like values store stable option IDs rather than display names, allowing labels to change without invalidating Pages. A status option also belongs to one lifecycle group—`not_started`, `in_progress`, or `complete`—so different ObjectTypes can use domain-specific labels while retaining common lifecycle semantics. Page identity and relationships are not properties.
_Avoid_: Relation property, duplicated Page metadata

**Knowledge link**:
An explicit Markdown link whose target is the stable `folio-page:<pageId>` identity of another Wiki asset. Markdown is authoritative; the Vault maintains a rebuildable `links` index for reverse relationships and timelines rather than duplicating relation lists in frontmatter.
_Avoid_: Mirrored relation property

**Raw citation**:
A link from a knowledge asset to source evidence identified by canonical raw commit, raw path, and when available an opaque provider source-record ID. Folio validates the Git evidence boundary but leaves record-ID interpretation to the Integration; a citation may stop at file level when no stable record ID exists. A path deleted within the cited Knowledge Task input remains valid evidence at that Task's `toCommit`, where it resolves to the deletion diff or prior content. The citation never silently follows the latest mutable raw projection.
_Avoid_: Live raw path, Knowledge link

**Project timeline**:
The chronological projection of Meetings, Decisions, and other time-bearing Events that link to a Project. It is derived from the link graph rather than maintained as a duplicate authored list in the Project body.
_Avoid_: Embedded timeline copy

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
The `toCommit` of the latest completed Knowledge Task for one Routine, derived from Task history rather than stored as a separate cursor. Checkpoints are consumer-specific, so processing by one Routine does not acknowledge changes for another.
_Avoid_: Global processed commit

**Knowledge Task input**:
The fixed `fromCommit` and `toCommit` selected from canonical history for a Knowledge Routine. A null `fromCommit` means the initial full raw snapshot; retries use the same endpoints, and later raw publications belong to later work.
_Avoid_: Live raw head, moving Task window

**Initial Knowledge Task input**:
The complete set of raw files present at a Knowledge Task's `toCommit` when its `fromCommit` is null. It is a full snapshot rather than a synthetic diff from the Vault's initial commit.
_Avoid_: Initial raw diff

**Wiki publication queue**:
The Vault-wide ordering of Wiki results awaiting canonical publication. Folio publishes only the head item, and a conflicted item retains its place while its diff is resolved and merged; all Folio-originated Wiki edits use this same ordering.
_Avoid_: Parallel Wiki merge, per-Task publication lane

**Wiki publication intent**:
One frozen, complete Wiki result submitted to the publication queue. A Knowledge Task contributes its aggregate result rather than exposing its Runs or intermediate saves as separate publications; conflict resolution continues the same intent.
_Avoid_: Save commit, conflict follow-up publication

**Signal**:
A transient, coalescible notice that committed raw material may need a Knowledge Routine's attention. It wakes the Routine but does not contain the changed files, require acknowledgement, or determine what remains unprocessed; the Routine's own checkpoint and Git history do that.
_Avoid_: Raw change ledger, processing checkpoint

## Task presentation

**Task summary**:
A durable snapshot of the latest terminal execution result for one Task. Agent Tasks derive it from execution Runs, excluding conflict-resolution Runs; Ingestion Tasks construct it from the completed source window and publication outcome. It is presentation-ready history, not a projection reconstructed from the current raws files.
_Avoid_: Live raws projection, Task log

**Task publication**:
The Git result associated with a Task summary. A raws publication references its raw operation; a Wiki publication references the Task's single aggregate publication intent. Publication state is separate from an Agent discovery, because a Run may finish before its Wiki changes are published.
_Avoid_: Change ID, commit result

**Agent discovery**:
The final complete assistant message of an Agent Run, excluding thought, tool-call, and user messages. If the Run ends unsuccessfully, the last received assistant content may be retained with an incomplete marker; a Run without assistant content contributes only its execution status and error.
_Avoid_: Agent thought, tool output, live stream

**Task feed time**:
The Task's durable creation time used to order the Vault overview Feed. It is always `createdAt`, including for Ingestion Tasks; source-window timestamps describe what was processed but do not reorder the Task.
_Avoid_: Summary time, source time

**Display time zone**:
The globally saved time zone used to interpret dates and times in the Vault Feed and to initialize new Routine schedules. It starts from the system time zone on first initialization and remains stable until explicitly changed by the user; existing Routines and frozen windows retain their own time zones.
_Avoid_: Live system time zone, Routine time zone
