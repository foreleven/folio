# Merge Ingestion through Git

Integrations materialize source changes in host-owned ingestion worktrees, after which Folio validates their owned raw paths, creates a raw commit, and merges it into the canonical Vault workspace. Direct writes and recursive copies into canonical raws are rejected because they provide last-writer-wins behavior, erase concurrent file changes, and cannot supply a reliable commit boundary for downstream processing.
