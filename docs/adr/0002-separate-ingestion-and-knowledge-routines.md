# Separate ingestion and knowledge routines

Folio models source Ingestion and Agent-driven Knowledge organization as two independent Routine kinds, connected by committed raw changes rather than one two-stage execution. This lets Ingestion advance and retry according to provider delivery semantics without depending on Agent availability, while Knowledge Routines can batch and retry raw processing with their own checkpoint.
