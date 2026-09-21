# Give each Integration resource one Ingestion Routine

Within a Vault, an `(integration_id, resource_id)` pair is owned by exactly one Ingestion Routine, enforced as a uniqueness constraint rather than an execution-time lock. A single owner gives the resource one ordered window timeline and prevents overlapping source capture; disabled Routines retain ownership, so users edit, disable, re-enable, delete, or rebind that Routine instead of creating another Routine for the same resource.
