# Derive Knowledge checkpoints from completed Tasks

A Knowledge Task freezes its canonical raw endpoints in immutable Agent Task configuration:

```ts
rawInput: {
  fromCommit: string | null
  toCommit: string
} | null
```

`rawInput` is null for Agent Tasks that do not consume canonical raws. For a Knowledge Task, null `fromCommit` means the initial full raw snapshot. The Task becomes completed only after its Wiki result is canonically published or a durable no-change result exists, so a Knowledge Routine's processing checkpoint is derived as the `toCommit` of its latest completed Task.

Folio therefore adds no checkpoint table and performs no publication-plus-cursor double write. Failed or active Tasks leave the previous completed Task authoritative, while each Routine still has an independent position because its Tasks are associated with that Routine. A separate `mode` field was rejected because nullability of `fromCommit` already distinguishes initial snapshot from incremental diff.
