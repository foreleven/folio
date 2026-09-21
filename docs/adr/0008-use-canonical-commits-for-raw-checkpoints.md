# Use canonical commits for raw checkpoints

Raw records and Knowledge Routine checkpoints reference only commits published on the canonical Vault workspace history. The isolated Ingestion commit remains available for audit and conflict recovery, but using it as a processing cursor was rejected because diffs between consumer checkpoints and source branches can have ambiguous ancestry; canonical commit pairs always support one meaningful `git diff`.
