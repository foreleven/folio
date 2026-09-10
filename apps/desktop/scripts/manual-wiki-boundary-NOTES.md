# Manual wiki boundary prototype

Question: with Agent execution, Skills, Integration scripts and `raws` excluded, can Folio safely carry manually edited `wiki` files through source capture, canonical publication and Task alignment?

Run with:

```sh
npm run prototype:wiki-boundary --workspace=@folio/desktop
```

The same probe accepts newline-delimited keys on stdin, which makes the manual boundary
repeatable without a terminal:

```sh
printf 'e\nr\nw\nc\np\nu\na\nq\n' | npm run prototype:wiki-boundary --workspace=@folio/desktop
```

PTY and scripted input execute the same state transitions. The probe is still a throwaway
experiment: its `writer stopped` action is an explicit test precondition, not production process
ownership or quiescence proof.

The prototype creates a real Git repository plus Task/coordinator worktrees under a temporary directory and removes them on exit. It is intentionally not production code and has no database recovery.

## Observed verdict

- A terminal Run is insufficient for capture. The state machine must also receive an independent writer-stopped fact.
- Once that fact is supplied, a manual Task edit can be committed, prepared outside main, fast-forward published, and aligned while retaining the Task source history.
- A saved same-file main edit produces a conflict only in the coordinator. Resolving it once, publishing, and adding a normal Task child commit converges both committed trees.
- Uncommitted main content blocks publication even when it does not overlap the Task change.
- A main commit created after canonical preparation invalidates that preparation; it must be rebuilt from the new main HEAD.
- A new Task draft after publication blocks alignment and remains unchanged.
- Git status and locks can enforce the frozen HEAD/clean checkout gates, but cannot prove that an external process will not write again after the check.

The prototype answers the ordering question but intentionally remains database-free. The production `TaskGitSynchronization` slice now provides durable checkpoints, restart recovery, idempotent prepare/publish/alignment receipts, and manual staged-conflict resolution for saved `wiki` changes. Writer ownership/quiescence, automatic Run handoff, and an actual AI-driven conflict-resolution Run remain outside that slice.
