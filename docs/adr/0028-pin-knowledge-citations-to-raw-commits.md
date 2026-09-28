# Pin knowledge citations to canonical raw commits

Knowledge assets cite raw evidence with `folio-raw:<canonical-commit>/<raw-path>#<source-record-id>`, using the frozen raw head selected by their Knowledge Task. A file-level citation is permitted when the Integration exposes no finer stable record identity, but citations never silently follow the latest daily raw projection.

The optional fragment is a non-empty, URL-encoded opaque identifier. Folio core does not parse provider-specific IM, mail, calendar, or other record formats; the Integration's raw format and Agent instructions determine which stable source-record ID to emit. Publication validation checks the canonical Git evidence boundary and raw path, while fragment interpretation remains outside the generic Wiki model.

Pinning citations preserves the evidence the Agent actually interpreted when later Ingestion updates, recalls, or deletes records and when old raw files leave the working tree during retention. Git remains the content store; raw citations are not Page relationships and do not enter the rebuildable `links` graph.

A citation may name a path absent from `toCommit` only when the Git difference from that Knowledge Task's non-null `fromCommit` proves that the path was deleted in the frozen input. The citation remains anchored to `toCommit`; resolving it presents the deletion diff or the prior blob instead of rewriting the URI to a parent commit. Initial full-snapshot Tasks have no deletion range, so every cited path must exist at their `toCommit`.
