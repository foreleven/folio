# Maintain mutable daily raw projections

Within `raws/<integration>/<resource>/<routine_date>/`, Integrations update stable provider-owned daily files rather than adding immutable per-window chunks. Each Integration must read the existing worktree projection and deterministically merge its new window; Git then exposes meaningful content diffs between canonical commits. Window-chunk files were rejected because they fragment a day's source state and make later processing and inspection depend on reconstructing that state from many captures.
