# Namespace raws by Integration resource

Every Integration resource writes into the Ingestion Task's dated namespace, `raws/<integration_id>/<resource_id>/<routine_date>/`, and the host rejects worktree changes outside that directory. The scheduler guarantees that a window belongs to one Routine-local date, so the host supplies one date-level output directory rather than asking each provider to repartition items. Provider-specific top-level names such as `raws/lark-im` were rejected because they require hard-coded mappings and cannot derive file ownership from the Task configuration; new Vaults use only the canonical namespace.

This refactor establishes the dated structure but performs no automatic retention. Deletion policy is deferred until Knowledge consumers have independent checkpoints, because directory age alone cannot prove that every consumer has processed the raw material.
