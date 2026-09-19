import { SqliteMigrator } from '@effect/sql-sqlite-node'
import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

/** Fresh-Vault baseline. Historical development schemas are intentionally unsupported. */
export const migrateVault = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    '0001_vault': Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Routine definitions; execution windows live on Tasks.
      yield* sql`CREATE TABLE routines (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
        agent TEXT NOT NULL CHECK(agent IN ('pi', 'codex')), model_provider_id TEXT,
        model_id TEXT, thinking_level TEXT, skill_ids TEXT NOT NULL DEFAULT '[]',
        integration_ids TEXT NOT NULL DEFAULT '[]', interval_minutes INTEGER NOT NULL CHECK(interval_minutes > 0),
        time_zone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        revision INTEGER NOT NULL CHECK(revision > 0), next_trigger_at INTEGER,
        last_trigger_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        resource_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(resource_ids)),
        CHECK(json_valid(skill_ids)), CHECK(json_valid(integration_ids)),
        CHECK((agent='pi') = (model_provider_id IS NOT NULL AND model_id IS NOT NULL AND thinking_level IS NOT NULL))
      )`

      // Tasks, external Sessions and their durable Run ledger.
      yield* sql`CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL, goal TEXT NOT NULL, configuration TEXT NOT NULL,
        branch TEXT NOT NULL UNIQUE, worktree TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'cancelled')),
        created_at INTEGER NOT NULL,
        worktree_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(worktree_state IN ('pending', 'creating', 'ready', 'releasing', 'released')),
        worktree_base TEXT,
        routine_id TEXT REFERENCES routines(id),
        routine_date TEXT,
        trigger_time INTEGER,
        first_trigger_time INTEGER,
        trigger_count INTEGER CHECK(trigger_count > 0),
        is_end INTEGER CHECK(is_end IN (0, 1)),
        window_start INTEGER,
        window_end INTEGER CHECK(window_end >= window_start),
        routine_revision INTEGER CHECK(routine_revision > 0),
        routine_model TEXT CHECK(routine_model IS NULL OR json_valid(routine_model)),
        routine_time_zone TEXT,
        routine_updated_at INTEGER
      )`
      yield* sql`CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
        agent TEXT NOT NULL CHECK(agent IN ('pi', 'codex')), adapter_version TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('task', 'conflict-resolution')),
        sync_operation_id TEXT UNIQUE REFERENCES git_sync_operations(id),
        acp_session_id TEXT UNIQUE, native_session_id TEXT, created_at INTEGER NOT NULL,
        model_profile TEXT,
        UNIQUE(id, task_id), UNIQUE(agent, native_session_id),
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
        CHECK((purpose = 'recovery') = (resumes_run_id IS NOT NULL)),
        CHECK((state IN ('queued', 'preparing', 'running')) = (ended_at IS NULL)),
        CHECK(state NOT IN ('preparing', 'running') OR (owner IS NOT NULL AND started_at IS NOT NULL)),
        CHECK(state<>'queued' OR (owner IS NULL AND started_at IS NULL)),
        CHECK(state NOT IN ('running', 'succeeded') OR baseline_commit IS NOT NULL)
      )`
      // SQL, rather than a renderer or process-local check, arbitrates competing Run reservations.
      yield* sql`CREATE UNIQUE INDEX runs_one_active_per_task ON runs(task_id) WHERE state IN ('preparing', 'running')`
      yield* sql`CREATE INDEX sessions_by_task ON sessions(task_id, created_at)`
      yield* sql`CREATE INDEX runs_by_task ON runs(task_id, sequence)`
      yield* sql`CREATE INDEX runs_queue_order ON runs(state, sequence)`
      yield* sql`CREATE UNIQUE INDEX task_one_routine_end ON tasks(routine_id, routine_date) WHERE is_end=1`
      yield* sql`CREATE INDEX tasks_by_routine_date ON tasks(routine_id, routine_date, trigger_time)`

      // Completed conversations and custom events share one Session sequence.
      yield* sql`CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT,
        seq INTEGER NOT NULL CHECK(seq > 0),
        type TEXT NOT NULL CHECK(type IN ('message', 'custom')),
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        UNIQUE(session_id, seq)
      )`
      yield* sql`CREATE INDEX messages_by_run ON messages(session_id, run_id, seq)`

      // Immutable Git save intents and their Run ownership.
      // Expected commit bytes precede object/ref writes. Preparation is not a branch receipt.
      yield* sql`CREATE TABLE git_change_preparations (
        id TEXT PRIMARY KEY NOT NULL, task_id TEXT REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK(kind IN ('user', 'raws', 'wiki')), branch TEXT NOT NULL,
        parent TEXT NOT NULL, tree TEXT NOT NULL, paths TEXT NOT NULL,
        commit_oid TEXT NOT NULL UNIQUE, commit_data TEXT NOT NULL, created_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('preparing', 'prepared')),
        UNIQUE(id, task_id, kind)
      )`
      // A save batch owns an immutable Run set. kind is repeated so SQLite can prevent a Run from
      // being ambiguously attributed to two wiki saves while still allowing a separate raws save.
      yield* sql`CREATE TABLE git_change_preparation_runs (
        preparation_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        run_id TEXT NOT NULL, PRIMARY KEY(preparation_id, run_id), UNIQUE(run_id, kind),
        FOREIGN KEY(preparation_id, task_id, kind) REFERENCES git_change_preparations(id, task_id, kind),
        FOREIGN KEY(run_id, task_id) REFERENCES runs(id, task_id),
        CHECK(kind IN ('raws', 'wiki'))
      )`
      yield* sql`CREATE TRIGGER git_change_preparation_immutable BEFORE UPDATE ON git_change_preparations
        WHEN NEW.id<>OLD.id OR NEW.task_id IS NOT OLD.task_id
          OR NEW.kind<>OLD.kind OR NEW.branch<>OLD.branch OR NEW.parent<>OLD.parent OR NEW.tree<>OLD.tree
          OR NEW.paths<>OLD.paths OR NEW.commit_oid<>OLD.commit_oid OR NEW.commit_data<>OLD.commit_data
          OR NEW.created_at<>OLD.created_at OR (OLD.state='prepared' AND NEW.state<>'prepared')
        BEGIN SELECT RAISE(ABORT, 'Git change preparation is immutable'); END`
      yield* sql`CREATE TRIGGER git_change_preparation_complete BEFORE UPDATE OF state ON git_change_preparations
        WHEN NEW.state='prepared' AND (
          (NEW.kind='user' AND EXISTS (SELECT 1 FROM git_change_preparation_runs r WHERE r.preparation_id=NEW.id))
          OR (NEW.kind<>'user' AND NOT EXISTS (SELECT 1 FROM git_change_preparation_runs r WHERE r.preparation_id=NEW.id))
        ) BEGIN SELECT RAISE(ABORT, 'Git change preparation has invalid Run ownership'); END`
      yield* sql`CREATE TRIGGER git_change_preparation_retained BEFORE DELETE ON git_change_preparations
        BEGIN SELECT RAISE(ABORT, 'Git change preparation must be retained'); END`
      yield* sql`CREATE TRIGGER git_change_preparation_run_shape BEFORE INSERT ON git_change_preparation_runs
        WHEN NOT EXISTS (SELECT 1 FROM git_change_preparations p WHERE p.id=NEW.preparation_id
          AND p.task_id=NEW.task_id AND p.kind=NEW.kind AND p.state='preparing')
          OR (NEW.kind='wiki' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id
            AND r.task_id=NEW.task_id AND r.state='succeeded' AND r.sync_state IN ('pending', 'failed')))
        BEGIN SELECT RAISE(ABORT, 'Git change Run ownership does not match its preparation'); END`
      yield* sql`CREATE TRIGGER git_change_preparation_run_immutable BEFORE UPDATE ON git_change_preparation_runs
        BEGIN SELECT RAISE(ABORT, 'Git change Run ownership is immutable'); END`
      yield* sql`CREATE TRIGGER git_change_preparation_run_retained BEFORE DELETE ON git_change_preparation_runs
        BEGIN SELECT RAISE(ABORT, 'Git change Run ownership must be retained'); END`

      // Applying a saved Git change reserves the checkout.
      yield* sql`CREATE TABLE git_change_applications (
        id TEXT PRIMARY KEY REFERENCES git_change_preparations(id), branch TEXT NOT NULL,
        before_index BLOB NOT NULL, after_index BLOB NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('applying', 'applied'))
      )`
      yield* sql`CREATE UNIQUE INDEX git_one_pending_save ON git_change_applications(branch) WHERE state='applying'`
      yield* sql`CREATE TRIGGER git_application_insert BEFORE INSERT ON git_change_applications
        WHEN NOT EXISTS (SELECT 1 FROM git_change_preparations p WHERE p.id=NEW.id AND p.state='prepared' AND p.branch=NEW.branch)
          OR EXISTS (SELECT 1 FROM git_change_preparations p JOIN runs r ON r.task_id=p.task_id
            WHERE p.id=NEW.id AND r.state IN ('preparing', 'running'))
        BEGIN SELECT RAISE(ABORT, 'Git save cannot reserve this checkout'); END`
      yield* sql`CREATE TRIGGER git_application_immutable BEFORE UPDATE ON git_change_applications
        WHEN NEW.id<>OLD.id OR NEW.branch<>OLD.branch OR NEW.before_index<>OLD.before_index
          OR NEW.after_index<>OLD.after_index OR (OLD.state='applied' AND NEW.state<>'applied')
        BEGIN SELECT RAISE(ABORT, 'Git application intent is immutable'); END`
      yield* sql`CREATE TRIGGER git_application_retained BEFORE DELETE ON git_change_applications
        BEGIN SELECT RAISE(ABORT, 'Git application receipt must be retained'); END`
      // Admission and pending save reservations arbitrate in SQLite, including across processes.
      yield* sql`CREATE TRIGGER runs_git_save_insert BEFORE INSERT ON runs
        WHEN NEW.state IN ('preparing', 'running') AND EXISTS (
          SELECT 1 FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
          WHERE a.state='applying' AND p.task_id=NEW.task_id
        ) BEGIN SELECT RAISE(ABORT, 'Task has an unfinished Git save'); END`
      yield* sql`CREATE TRIGGER runs_git_save_update BEFORE UPDATE OF state, task_id ON runs
        WHEN NEW.state IN ('preparing', 'running') AND EXISTS (
          SELECT 1 FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
          WHERE a.state='applying' AND p.task_id=NEW.task_id
        ) BEGIN SELECT RAISE(ABORT, 'Task has an unfinished Git save'); END`

      // Canonical synchronization and its forward-only lifecycle.
      yield* sql`CREATE TABLE git_sync_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id), supersedes_id TEXT UNIQUE REFERENCES git_sync_operations(id), source_frontier TEXT NOT NULL,
        source_head TEXT NOT NULL, source_changes TEXT NOT NULL, source_commits TEXT NOT NULL,
        main_base TEXT NOT NULL, canonical_commits TEXT NOT NULL DEFAULT '[]', conflict_index INTEGER, prepared_head TEXT,
        published_head TEXT, aligned_head TEXT, alignment_commit TEXT, alignment_data TEXT,
        state TEXT NOT NULL CHECK(state IN ('preparing', 'conflict', 'resolving', 'prepared', 'published', 'aligning', 'aligned', 'superseded', 'aborted')),
        created_at INTEGER NOT NULL
      )`
      yield* sql`CREATE UNIQUE INDEX git_sync_unique_live_input ON git_sync_operations(task_id, source_head, main_base)
        WHERE state<>'aborted'`
      yield* sql`CREATE UNIQUE INDEX git_sync_one_unpublished_per_task ON git_sync_operations(task_id)
        WHERE state IN ('preparing', 'conflict', 'resolving', 'prepared')`
      yield* sql`CREATE TRIGGER git_sync_initial_shape BEFORE INSERT ON git_sync_operations
        WHEN NEW.state<>'preparing' OR NEW.canonical_commits<>'[]' OR NEW.prepared_head IS NOT NULL
          OR NEW.published_head IS NOT NULL OR NEW.aligned_head IS NOT NULL
          OR NEW.alignment_commit IS NOT NULL OR NEW.alignment_data IS NOT NULL OR NEW.conflict_index IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'Git synchronization must start without checkpoints'); END`
      yield* sql`CREATE TRIGGER git_sync_identity_immutable BEFORE UPDATE ON git_sync_operations
        WHEN NEW.id<>OLD.id OR NEW.task_id<>OLD.task_id OR NEW.supersedes_id IS NOT OLD.supersedes_id OR NEW.source_frontier<>OLD.source_frontier
          OR NEW.source_head<>OLD.source_head OR NEW.source_changes<>OLD.source_changes
          OR NEW.source_commits<>OLD.source_commits OR NEW.main_base<>OLD.main_base OR NEW.created_at<>OLD.created_at
          OR ((OLD.prepared_head IS NOT NULL OR OLD.state NOT IN ('preparing', 'conflict', 'resolving')) AND NEW.canonical_commits<>OLD.canonical_commits)
          OR (OLD.prepared_head IS NOT NULL AND NEW.prepared_head IS NOT OLD.prepared_head)
          OR (OLD.published_head IS NOT NULL AND NEW.published_head IS NOT OLD.published_head)
          OR (OLD.aligned_head IS NOT NULL AND NEW.aligned_head IS NOT OLD.aligned_head)
          OR (OLD.alignment_commit IS NOT NULL AND NEW.alignment_commit IS NOT OLD.alignment_commit)
          OR (OLD.alignment_data IS NOT NULL AND NEW.alignment_data IS NOT OLD.alignment_data)
        BEGIN SELECT RAISE(ABORT, 'Git synchronization identity is immutable'); END`
      // A canonical prefix only grows by one exact journal entry. The service separately verifies
      // each entry's deterministic bytes, source identity and retained Git object.
      yield* sql`CREATE TRIGGER git_sync_canonical_append BEFORE UPDATE OF canonical_commits ON git_sync_operations
        WHEN NEW.canonical_commits<>OLD.canonical_commits AND (
          OLD.prepared_head IS NOT NULL OR OLD.state NOT IN ('preparing', 'conflict', 'resolving')
          OR json_array_length(NEW.canonical_commits)<>json_array_length(OLD.canonical_commits)+1
          OR json_remove(NEW.canonical_commits, '$[#-1]')<>OLD.canonical_commits
        ) BEGIN SELECT RAISE(ABORT, 'Git synchronization canonical prefix can only append'); END`
      yield* sql`CREATE TRIGGER git_sync_state_forward_only BEFORE UPDATE OF state ON git_sync_operations
        WHEN NOT (
          NEW.state=OLD.state
          OR (OLD.state='preparing' AND NEW.state IN ('conflict', 'prepared'))
          OR (OLD.state='conflict' AND NEW.state IN ('resolving', 'superseded', 'aborted'))
          OR (OLD.state='resolving' AND NEW.state IN ('conflict', 'prepared', 'superseded', 'aborted'))
          OR (OLD.state='prepared' AND NEW.state IN ('published', 'superseded'))
          OR (OLD.state='published' AND NEW.state IN ('aligning', 'aligned'))
          OR (OLD.state='aligning' AND NEW.state='aligned')
        ) BEGIN SELECT RAISE(ABORT, 'Git synchronization state cannot move backwards'); END`
      yield* sql`CREATE TRIGGER git_sync_checkpoint_shape BEFORE UPDATE ON git_sync_operations
        WHEN (NEW.state='preparing' AND NEW.conflict_index IS NOT NULL)
          OR (NEW.state='conflict' AND (NEW.conflict_index IS NULL OR json_array_length(NEW.canonical_commits)<>NEW.conflict_index))
          OR (NEW.state='resolving' AND (NEW.conflict_index IS NULL OR json_array_length(NEW.canonical_commits)<=NEW.conflict_index))
          OR (NEW.state IN ('prepared', 'published', 'aligning', 'aligned') AND (NEW.prepared_head IS NULL OR NEW.conflict_index IS NOT NULL))
          OR (NEW.state='superseded' AND NEW.prepared_head IS NOT NULL AND NEW.conflict_index IS NOT NULL)
          OR (NEW.state IN ('published', 'aligning', 'aligned') AND NEW.published_head IS NULL)
          OR (NEW.state='aligning' AND (NEW.alignment_commit IS NULL OR NEW.alignment_data IS NULL))
          OR (NEW.state='aligned' AND NEW.aligned_head IS NULL)
        BEGIN SELECT RAISE(ABORT, 'Git synchronization checkpoint is incomplete'); END`
      yield* sql`CREATE TRIGGER git_sync_replacement_shape BEFORE INSERT ON git_sync_operations
        WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM git_sync_operations old WHERE old.id=NEW.supersedes_id
            AND old.task_id=NEW.task_id AND old.source_frontier=NEW.source_frontier
            AND old.source_head=NEW.source_head AND old.source_changes=NEW.source_changes
            AND old.source_commits=NEW.source_commits AND old.main_base<>NEW.main_base
            AND old.state='superseded'
        ) BEGIN SELECT RAISE(ABORT, 'Git synchronization replacement does not match its superseded input'); END`
      yield* sql`CREATE TRIGGER git_sync_retained BEFORE DELETE ON git_sync_operations
        BEGIN SELECT RAISE(ABORT, 'Git synchronization operation must be retained'); END`
      // Agent wiki saves already carry immutable Run ownership. Project synchronization state from
      // the operation receipt so Routine gating never has to infer completion from Git HEAD alone.
      yield* sql`CREATE TRIGGER git_sync_run_state_insert AFTER INSERT ON git_sync_operations BEGIN
        UPDATE runs SET sync_state='syncing'
        WHERE task_id=NEW.task_id AND state='succeeded' AND id IN (
          SELECT owner.run_id FROM json_each(NEW.source_changes) source
          JOIN git_change_preparations p ON p.id=source.value
          JOIN git_change_preparation_runs owner ON owner.preparation_id=p.id
          WHERE p.task_id=NEW.task_id AND p.kind='wiki'
        );
      END`
      yield* sql`CREATE TRIGGER git_sync_run_state_update AFTER UPDATE OF state ON git_sync_operations
        WHEN NEW.state<>OLD.state AND NEW.state IN ('conflict', 'resolving', 'aligned', 'aborted') BEGIN
        UPDATE runs SET sync_state=CASE NEW.state
          WHEN 'conflict' THEN 'conflict'
          WHEN 'resolving' THEN 'syncing'
          WHEN 'aligned' THEN 'completed'
          ELSE 'failed'
        END
        WHERE task_id=NEW.task_id AND state='succeeded' AND id IN (
          SELECT owner.run_id FROM json_each(NEW.source_changes) source
          JOIN git_change_preparations p ON p.id=source.value
          JOIN git_change_preparation_runs owner ON owner.preparation_id=p.id
          WHERE p.task_id=NEW.task_id AND p.kind='wiki'
        );
      END`
      // A Run and synchronization cannot concurrently own the same Task checkout, across processes.
      yield* sql`CREATE TRIGGER git_sync_without_run BEFORE INSERT ON git_sync_operations
        WHEN EXISTS (SELECT 1 FROM runs WHERE task_id=NEW.task_id AND state IN ('preparing', 'running'))
        BEGIN SELECT RAISE(ABORT, 'Task has an active Run'); END`
      yield* sql`CREATE TRIGGER runs_without_git_sync_insert BEFORE INSERT ON runs
        WHEN NEW.state IN ('preparing', 'running') AND NEW.purpose<>'conflict-resolution' AND EXISTS (
          SELECT 1 FROM git_sync_operations pending WHERE pending.task_id=NEW.task_id AND pending.state NOT IN ('aligned', 'aborted')
            AND (pending.state<>'superseded' OR NOT EXISTS (
              SELECT 1 FROM git_sync_operations replacement WHERE replacement.supersedes_id=pending.id))
        ) BEGIN SELECT RAISE(ABORT, 'Task has unfinished synchronization'); END`
      yield* sql`CREATE TRIGGER runs_without_git_sync_update BEFORE UPDATE OF state, task_id ON runs
        WHEN NEW.state IN ('preparing', 'running') AND NEW.purpose<>'conflict-resolution' AND EXISTS (
          SELECT 1 FROM git_sync_operations pending WHERE pending.task_id=NEW.task_id AND pending.state NOT IN ('aligned', 'aborted')
            AND (pending.state<>'superseded' OR NOT EXISTS (
              SELECT 1 FROM git_sync_operations replacement WHERE replacement.supersedes_id=pending.id))
        ) BEGIN SELECT RAISE(ABORT, 'Task has unfinished synchronization'); END`

      // Cross-entity Agent and conflict target invariants.
      // Session creation cannot bypass the service-level fixed-Agent check through another writer.
      yield* sql`CREATE TRIGGER session_uses_task_agent BEFORE INSERT ON sessions
        WHEN NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=NEW.task_id
          AND json_extract(t.configuration, '$.agent')=NEW.agent)
        BEGIN SELECT RAISE(ABORT, 'Session Agent must match its Task'); END`
      yield* sql`CREATE TRIGGER session_conflict_target BEFORE INSERT ON sessions
        WHEN NEW.purpose='conflict-resolution' AND NOT EXISTS (
          SELECT 1 FROM git_sync_operations operation WHERE operation.id=NEW.sync_operation_id
            AND operation.task_id=NEW.task_id AND operation.state IN ('conflict', 'resolving')
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
              AND EXISTS (SELECT 1 FROM git_sync_operations operation
                WHERE operation.id=session.sync_operation_id AND operation.task_id=NEW.task_id
                  AND operation.state IN ('conflict', 'resolving')))
              OR (NEW.purpose<>'conflict-resolution' AND session.purpose='task'))
        ) BEGIN SELECT RAISE(ABORT, 'Run purpose does not match its Session target'); END`

      // Replayable conflict resolution inputs.
      // A conflict resolution is an immutable patch from the accepted canonical prefix to the
      // user's staged tree. Keeping the patch outside the coordinator lets a later operation
      // replay it after main advances without trusting an old checkout or index.
      yield* sql`CREATE TABLE git_sync_resolution_inputs (
        operation_id TEXT NOT NULL REFERENCES git_sync_operations(id),
        conflict_index INTEGER NOT NULL CHECK(conflict_index >= 0),
        source_commit TEXT NOT NULL, parent_commit TEXT NOT NULL, tree TEXT NOT NULL,
        patch TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(operation_id, conflict_index)
      )`
      yield* sql`CREATE TRIGGER git_sync_resolution_input_shape BEFORE INSERT ON git_sync_resolution_inputs
        WHEN NOT EXISTS (
          SELECT 1 FROM git_sync_operations operation
          WHERE operation.id=NEW.operation_id
            AND operation.conflict_index=NEW.conflict_index
            AND NEW.conflict_index < json_array_length(operation.source_commits)
            AND json_extract(operation.source_commits, '$[' || NEW.conflict_index || ']')=NEW.source_commit
            AND NEW.parent_commit=CASE WHEN NEW.conflict_index=0 THEN operation.main_base
              ELSE json_extract(operation.canonical_commits, '$[' || (NEW.conflict_index - 1) || '].commit') END
        ) BEGIN SELECT RAISE(ABORT, 'Git synchronization resolution input does not match its source'); END`
      yield* sql`CREATE TRIGGER git_sync_resolution_input_immutable BEFORE UPDATE ON git_sync_resolution_inputs
        WHEN NEW.operation_id<>OLD.operation_id OR NEW.conflict_index<>OLD.conflict_index
          OR NEW.source_commit<>OLD.source_commit OR NEW.parent_commit<>OLD.parent_commit
          OR NEW.tree<>OLD.tree OR NEW.patch<>OLD.patch OR NEW.created_at<>OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'Git synchronization resolution input is immutable'); END`
      yield* sql`CREATE TRIGGER git_sync_resolution_input_retained BEFORE DELETE ON git_sync_resolution_inputs
        BEGIN SELECT RAISE(ABORT, 'Git synchronization resolution input must be retained'); END`
    })
  })
})
