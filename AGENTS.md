# Agent Guidelines

## Coding

- Understand an interface and its upstream and downstream dependencies before changing it.
- Reuse the newest established project pattern instead of introducing a parallel abstraction.
- Keep changes scoped to the request and verify relevant success, boundary, and failure paths.
- Document methods and explain the reasons behind non-obvious business or architectural decisions.
- Ask for domain clarification when behavior cannot be established from the codebase or its source material.

## Vendored Repositories

This project vendors external repositories under `repos/` so coding agents can inspect the exact source used by the application.

- Treat vendored repositories as read-only reference material when working with related libraries.
- Prefer patterns, tests, and documentation from vendored source over generated guesses or web search results.
- Do not edit files under `repos/` unless explicitly asked to update a vendored repository.
- Do not import from `repos/`; application code must continue importing from normal package dependencies.

### Effect

- `repos/effect/` is pinned to the source for the installed `effect@4.0.0-rc.112` dependency.
- Before writing or changing Effect code, read `repos/effect/LLMS.md` and inspect relevant implementation, tests, and examples under `repos/effect/`.
- Treat `repos/effect/` as the source of truth for idiomatic Effect patterns, while preserving this project's existing architecture and conventions.
- When upgrading Effect, update the package dependency and the vendored subtree to the same upstream tag in one change.
