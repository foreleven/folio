# Complete Ingestion at canonical publication receipt

An Ingestion window succeeds when its canonical publication and one SQLite transaction containing the Git application receipt, `raws` projection, Task receipt/lifecycle, and Routine processing boundary are durable. Worktree alignment and release remain recoverable cleanup and may delay admission of the next Task, but their failure cannot turn published data back into a failed window or cause the Integration to fetch and publish that window again.
