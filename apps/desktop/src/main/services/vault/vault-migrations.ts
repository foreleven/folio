import { SqliteMigrator } from '@effect/sql-sqlite-node'
import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

/** Fresh-Vault baseline. Historical development schemas are intentionally unsupported. */
export const migrateVault = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    '0001_vault': Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Markdown is authoritative; these tables contain rebuildable metadata only.
      yield* sql`CREATE TABLE wiki_object_types (
        id TEXT PRIMARY KEY NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition))
      )`
      yield* sql`CREATE TABLE wiki_pages (
        id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL UNIQUE, object_type TEXT NOT NULL,
        parent_id TEXT, title TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)),
        frontmatter TEXT NOT NULL CHECK(json_valid(frontmatter)), version TEXT NOT NULL
      )`
      yield* sql`CREATE INDEX wiki_pages_by_type ON wiki_pages(object_type)`
      yield* sql`CREATE INDEX wiki_pages_by_parent ON wiki_pages(parent_id)`

      // Routine definitions own editable triggers; schedule rows freeze actual windows.
      yield* sql`CREATE TABLE routines (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('agent', 'ingestion')),
        configuration TEXT NOT NULL CHECK(json_valid(configuration)),
        trigger TEXT NOT NULL CHECK(json_valid(trigger) AND json_extract(trigger, '$.type')='schedule'),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        revision INTEGER NOT NULL CHECK(revision > 0), next_trigger_at INTEGER,
        last_trigger_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`
      yield* sql`CREATE UNIQUE INDEX routines_one_ingestion_resource
        ON routines(json_extract(configuration, '$.integrationId'), json_extract(configuration, '$.resourceId'))
        WHERE type='ingestion'`

      // Branch and worktree paths are deterministic from the Task id and therefore are not data.
      yield* sql`CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL CHECK(type IN ('agent', 'ingestion')),
        configuration TEXT NOT NULL CHECK(json_valid(configuration)),
        receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
        summary TEXT CHECK(summary IS NULL OR json_valid(summary)),
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'cancelled')),
        created_at INTEGER NOT NULL,
        worktree_state TEXT NOT NULL DEFAULT 'pending'
          CHECK(worktree_state IN ('pending', 'creating', 'ready', 'releasing', 'released')),
        worktree_base TEXT,
        routine_id TEXT REFERENCES routines(id), routine_revision INTEGER CHECK(routine_revision > 0),
        CHECK((type='agent' AND receipt IS NULL) OR (type='ingestion' AND receipt IS NOT NULL))
      )`
      yield* sql`CREATE INDEX tasks_by_routine ON tasks(routine_id, created_at)`
      yield* sql`CREATE TABLE routine_schedules (
        task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
        routine_id TEXT NOT NULL REFERENCES routines(id),
        trigger_time INTEGER NOT NULL, window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL CHECK(window_end > window_start),
        time_zone TEXT NOT NULL, created_at INTEGER NOT NULL
      )`
      yield* sql`CREATE INDEX routine_schedules_by_routine ON routine_schedules(routine_id, window_start, trigger_time)`

      yield* sql`CREATE TABLE raws (
        id TEXT PRIMARY KEY NOT NULL, integration_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('present', 'deleted')),
        current_commit TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(integration_id, resource_id, path)
      )`

      // Git owns commit/tree bytes. SQLite keeps only durable operation identity and lifecycle;
      // bounded recovery metadata lives under the Vault's git-operations directory.
      yield* sql`CREATE TABLE git_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK(kind IN ('save-user', 'save-raws', 'save-wiki', 'synchronize')),
        state TEXT NOT NULL CHECK(state IN ('pending', 'conflict', 'prepared', 'published', 'completed', 'aborted')),
        source_commit TEXT NOT NULL, target_commit TEXT, artifact_path TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`
      yield* sql`CREATE INDEX git_operations_by_task ON git_operations(task_id, sequence)`
      yield* sql`CREATE UNIQUE INDEX git_operations_one_active_task ON git_operations(task_id)
        WHERE task_id IS NOT NULL AND state IN ('pending', 'conflict', 'prepared', 'published')`

      yield* sql`CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
        agent TEXT NOT NULL CHECK(agent IN ('pi', 'codex')), adapter_version TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('task', 'conflict-resolution')),
        sync_operation_id TEXT UNIQUE REFERENCES git_operations(id),
        acp_session_id TEXT UNIQUE, native_session_id TEXT, created_at INTEGER NOT NULL,
        model_profile TEXT, UNIQUE(id, task_id), UNIQUE(agent, native_session_id),
        CHECK((purpose='task' AND sync_operation_id IS NULL)
          OR (purpose='conflict-resolution' AND sync_operation_id IS NOT NULL))
      )`
      yield* sql`CREATE TABLE runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL,
        prompt TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('execution', 'recovery', 'conflict-resolution')),
        resumes_run_id TEXT, baseline_commit TEXT,
        source TEXT NOT NULL CHECK(source IN ('manual', 'routine', 'recovery', 'conflict-resolution')),
        owner TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        started_at INTEGER,
        state TEXT NOT NULL CHECK(state IN ('queued', 'preparing', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
        sync_state TEXT NOT NULL CHECK(sync_state IN ('not-required', 'pending', 'syncing', 'conflict', 'completed', 'failed')),
        created_at INTEGER NOT NULL, ended_at INTEGER, error TEXT,
        UNIQUE(id, task_id),
        FOREIGN KEY(session_id, task_id) REFERENCES sessions(id, task_id),
        FOREIGN KEY(resumes_run_id, task_id) REFERENCES runs(id, task_id),
        CHECK((purpose='recovery')=(resumes_run_id IS NOT NULL)),
        CHECK((state IN ('queued', 'preparing', 'running'))=(ended_at IS NULL)),
        CHECK(state NOT IN ('preparing', 'running') OR (owner IS NOT NULL AND started_at IS NOT NULL)),
        CHECK(state<>'queued' OR (owner IS NULL AND started_at IS NULL)),
        CHECK(state NOT IN ('running', 'succeeded') OR baseline_commit IS NOT NULL)
      )`
      yield* sql`CREATE UNIQUE INDEX runs_one_active_per_task ON runs(task_id) WHERE state IN ('preparing', 'running')`
      yield* sql`CREATE INDEX sessions_by_task ON sessions(task_id, created_at)`
      yield* sql`CREATE INDEX runs_by_task ON runs(task_id, sequence)`
      yield* sql`CREATE INDEX runs_queue_order ON runs(state, sequence)`

      // A wiki save may own several successful Runs. It stores provenance only, never Git data.
      yield* sql`CREATE TABLE git_operation_runs (
        operation_id TEXT NOT NULL REFERENCES git_operations(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        PRIMARY KEY(operation_id, run_id), UNIQUE(run_id)
      )`

      // Completed conversations and custom events share one Session sequence.
      yield* sql`CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT,
        seq INTEGER NOT NULL CHECK(seq > 0), type TEXT NOT NULL CHECK(type IN ('message', 'custom')),
        timestamp INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(session_id, seq)
      )`
      yield* sql`CREATE INDEX messages_by_run ON messages(session_id, run_id, seq)`

      // Active Git operations and active Runs are mutually exclusive for one Task. Services do
      // the friendly preflight; SQL closes the cross-process admission gap.
      yield* sql`CREATE TRIGGER runs_git_operation_insert BEFORE INSERT ON runs
        WHEN NEW.state IN ('preparing', 'running') AND NEW.purpose<>'conflict-resolution' AND EXISTS (
          SELECT 1 FROM git_operations operation WHERE operation.task_id=NEW.task_id
            AND operation.state IN ('pending', 'conflict', 'prepared', 'published')
        ) BEGIN SELECT RAISE(ABORT, 'Task has an unfinished Git operation'); END`
      yield* sql`CREATE TRIGGER runs_git_operation_update BEFORE UPDATE OF state, task_id ON runs
        WHEN NEW.state IN ('preparing', 'running') AND NEW.purpose<>'conflict-resolution' AND EXISTS (
          SELECT 1 FROM git_operations operation WHERE operation.task_id=NEW.task_id
            AND operation.state IN ('pending', 'conflict', 'prepared', 'published')
        ) BEGIN SELECT RAISE(ABORT, 'Task has an unfinished Git operation'); END`
      yield* sql`CREATE TRIGGER git_operation_without_run BEFORE INSERT ON git_operations
        WHEN NEW.task_id IS NOT NULL AND NEW.state IN ('pending', 'conflict', 'prepared', 'published')
          AND EXISTS (SELECT 1 FROM runs WHERE task_id=NEW.task_id AND state IN ('preparing', 'running'))
        BEGIN SELECT RAISE(ABORT, 'Task has an active Run'); END`

      // Cross-entity Agent and conflict target invariants.
      yield* sql`CREATE TRIGGER session_uses_task_agent BEFORE INSERT ON sessions
        WHEN NOT EXISTS (SELECT 1 FROM tasks task WHERE task.id=NEW.task_id
          AND task.type='agent' AND json_extract(task.configuration, '$.agent')=NEW.agent)
        BEGIN SELECT RAISE(ABORT, 'Session Agent must match its Task'); END`
      yield* sql`CREATE TRIGGER session_conflict_target BEFORE INSERT ON sessions
        WHEN NEW.purpose='conflict-resolution' AND NOT EXISTS (
          SELECT 1 FROM git_operations operation WHERE operation.id=NEW.sync_operation_id
            AND operation.task_id=NEW.task_id AND operation.kind='synchronize' AND operation.state='conflict'
        ) BEGIN SELECT RAISE(ABORT, 'Conflict Session target is not actionable'); END`
      yield* sql`CREATE TRIGGER session_execution_identity_immutable
        BEFORE UPDATE OF task_id, agent, purpose, sync_operation_id ON sessions
        WHEN NEW.task_id<>OLD.task_id OR NEW.agent<>OLD.agent OR NEW.purpose<>OLD.purpose
          OR NEW.sync_operation_id IS NOT OLD.sync_operation_id
        BEGIN SELECT RAISE(ABORT, 'Session execution identity is immutable'); END`
      yield* sql`CREATE TRIGGER run_uses_session_target BEFORE INSERT ON runs
        WHEN NOT EXISTS (
          SELECT 1 FROM sessions session WHERE session.id=NEW.session_id AND session.task_id=NEW.task_id
            AND ((NEW.purpose='conflict-resolution' AND session.purpose='conflict-resolution'
              AND EXISTS (SELECT 1 FROM git_operations operation
                WHERE operation.id=session.sync_operation_id AND operation.task_id=NEW.task_id
                  AND operation.kind='synchronize' AND operation.state='conflict'))
              OR (NEW.purpose<>'conflict-resolution' AND session.purpose='task'))
        ) BEGIN SELECT RAISE(ABORT, 'Run purpose does not match its Session target'); END`
    })
  })
})
