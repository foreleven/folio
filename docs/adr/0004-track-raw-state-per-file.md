# Track raw state per file

The `raws` read model tracks one canonical raw path per row rather than one row per Ingestion batch. Creation, modification, and deletion all advance the file's current raw commit; deleted paths remain as tombstones so downstream Knowledge Routines can observe removal instead of silently treating the file as unchanged.

Each row has a UUIDv7 identity, Integration and resource IDs, unique canonical path, `present | deleted` state, current canonical commit, and creation/update timestamps. File contents, blob hashes, consumer checkpoints, and Task provenance remain in Git or their owning models rather than being duplicated in this projection; renames appear as one tombstone and one new raw record.
