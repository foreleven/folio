# Retry Ingestion on normal check cycles

Failed Ingestion Tasks and safely interrupted attempts retry the same frozen Task at the next `interval_minutes` check, never in a tight post-failure loop. User-cancelled and Git-conflicted Tasks require explicit manual retry so a stop is not immediately undone and an ownership anomaly is not repeatedly replayed; successful canonical publication remains terminal even if cleanup is pending.
