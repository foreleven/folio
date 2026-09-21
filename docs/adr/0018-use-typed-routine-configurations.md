# Use typed Routine configurations

The `routines` table stores common scheduling fields plus `type` and a type-specific configuration, replacing the current prompt, Agent, model, Skill, Integration, and resource columns. Ingestion configuration identifies exactly one Integration resource; Agent configuration contains its goal and Agent inputs, and every scheduled Task freezes the selected Routine revision's configuration. New Vaults use this final schema directly without compatibility columns or historical-data migration.

The outer `routines.type` column is the sole discriminator; configuration JSON does not repeat it. Application schemas decode the row as the corresponding `{ type, configuration }` union member.

The Ingestion Routine editor exposes only its name, one installed Integration resource, interval, time zone, and enabled state. Its configuration is exactly `{ integrationId, resourceId }`; Agent goals, prompts, models, and Skills do not apply.

Default creation is resource-driven rather than provider-specific: when a registered ingest-capable resource first becomes ready, Folio creates one enabled Ingestion Routine only if the Vault has no owner for that `(integrationId, resourceId)`. The database uniqueness constraint makes repeated readiness checks idempotent; resources that are not ready remain selectable but create neither a default Routine nor failed Tasks.

Every generated Ingestion Routine starts enabled with a 60-minute check cycle, the host's current IANA time zone, and a name derived from the Integration and resource names. Provider-type-specific daily defaults belonged to the removed Agent review workflow and would inefficiently create a long chain of one-hour catch-up windows after each daily check.
