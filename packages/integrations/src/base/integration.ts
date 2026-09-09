import { Schema } from 'effect'
import type { Effect, FileSystem } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'

export const readyState = 'ready'
export class IntegrationError extends Schema.TaggedError<IntegrationError>()('IntegrationError', {
  message: Schema.String
}) {}
export type IntegrationEffect<A, E = IntegrationError> = Effect.Effect<A, E,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>

/** Static provider identity, safe to serialize for catalogs without loading credentials. */
export interface IntegrationMetadata {
  /** Stable storage/registry key; changing it creates a different installation. */
  readonly id: string
  readonly name: string
  readonly description: string
  /** Bundled image data URI; renders offline without remote requests or filesystem access. */
  readonly logo: string
  readonly homepage: string
}

export interface IntegrationAction {
  readonly id: string
  readonly label: string
  readonly description?: string
}
export interface CheckResult {
  readonly state: string
  readonly actionIds: readonly string[]
}
export interface IntegrationContext {
  /** Integration-owned storage, e.g. ~/.folio/integrations/lark. */
  readonly directory: string
  /** Host persists opaque state/data and updates UI; credentials stay in private files. */
  readonly writeState: (state: string, data: unknown) => Effect.Effect<void, IntegrationError>
  /** Host upserts by integration ID + resource ID; repeated installation must be safe. */
  readonly registerResource: (resource: IntegrationResource) => Effect.Effect<void, IntegrationError>
}
export interface IngestContext {
  readonly workspaceDirectory: string
  readonly instructions: string[]
  readonly skills: string[]
  readonly env: Record<string, string>
}
export interface IntegrationResource {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Reserved for enriching an agent run; does not execute the agent. */
  readonly onIngest: (context: IngestContext) => Effect.Effect<void, IntegrationError>
}
export interface Integration<C extends IntegrationContext = IntegrationContext> extends IntegrationMetadata {
  readonly actions: readonly IntegrationAction[]
  /** Static implementations allow the host to rebind persisted resources after restart. */
  readonly resources: readonly IntegrationResource[]
  /** Called after user confirmation; prepares dependencies and registers resources only. */
  readonly install: (context: C) => IntegrationEffect<void>
  /** Read-only inspection. Only ready is successful; never initiates setup or OAuth. */
  readonly check: (context: C) => IntegrationEffect<CheckResult>
  /** Handles a user action; validates that it still applies before any side effect. */
  readonly onActionCallback: (context: C, actionId: string, payload?: unknown) => IntegrationEffect<void>
}

/** Provider hooks contain only provider-specific work; the base wraps their lifecycle and errors. */
export interface IntegrationDefinition<C extends IntegrationContext = IntegrationContext> extends IntegrationMetadata {
  readonly actions: readonly IntegrationAction[]
  readonly resources: readonly IntegrationResource[]
  /** Installs dependencies and upserts resources; the base publishes the final check. */
  readonly install: (context: C) => IntegrationEffect<void, unknown>
  /** Inspects durable provider facts only; the base handles live in-process progress. */
  readonly check: (context: C) => IntegrationEffect<CheckResult, unknown>
  /** Performs a statically declared, currently available action with an opaque host payload. */
  readonly onActionCallback: (context: C, actionId: string, payload?: unknown) => IntegrationEffect<void, unknown>
}
