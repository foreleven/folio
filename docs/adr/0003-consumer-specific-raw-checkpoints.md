# Keep raw processing checkpoints per Knowledge Routine

Folio records the current source state independently from each Knowledge Routine's processed position. A global processed commit on a raw record was rejected because multiple Knowledge Routines may consume the same raw material at different rates; each consumer therefore owns its own checkpoint and derives pending work from the Git diff between that checkpoint and the current raw commit.

The initial Ingestion refactor creates only the current-state `raws` projection, and `raws` carries no global `processed_commit`. The later Knowledge design derives each Routine's checkpoint from the `toCommit` of its latest completed Knowledge Task instead of adding a checkpoint table; see ADR-0029.
