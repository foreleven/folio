import { Context, Schema } from 'effect'
import type { Effect } from 'effect'
import type { IntegrationAction, IntegrationActionDefinition } from './protocol.ts'

export const readyState = 'ready'
export class IntegrationError extends Schema.TaggedError<IntegrationError>()('IntegrationError', {
  message: Schema.String
}) {}
export type IntegrationEffect<A, E = IntegrationError, R = never> = Effect.Effect<A, E, IntegrationContext | R>

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

export interface CheckResult {
  readonly state: string
  readonly actions: readonly IntegrationAction[]
}
/** Per-installation host capabilities, supplied independently for each effect execution. */
export class IntegrationContext extends Context.Service<IntegrationContext, {
  /** Integration-owned storage, e.g. ~/.folio/integrations/lark. */
  readonly directory: string
  /** Host persists opaque state/data and available actions atomically; omitted actions clear prior actions. */
  readonly writeState: (state: string, data: unknown, actions?: readonly IntegrationAction[]) => Effect.Effect<void, IntegrationError>
  /** Host upserts by integration ID + resource ID; repeated installation must be safe. */
  readonly registerResource: (resource: IntegrationResource) => Effect.Effect<void, IntegrationError>
}>()('@folio/integrations/base/IntegrationContext') {}
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
export interface Integration<R = never> extends IntegrationMetadata {
  readonly actions: readonly IntegrationActionDefinition[]
  /** Static implementations allow the host to rebind persisted resources after restart. */
  readonly resources: readonly IntegrationResource[]
  /** Called after user confirmation; prepares dependencies and registers resources only. */
  readonly install: () => IntegrationEffect<void, IntegrationError, R>
  /** Read-only inspection. Only ready is successful; never initiates setup or OAuth. */
  readonly inspect: () => IntegrationEffect<CheckResult, IntegrationError, R>
  /** Handles a user action; validates that it still applies before any side effect. */
  readonly onActionCallback: (actionId: string, payload?: unknown) => IntegrationEffect<void, IntegrationError, R>
}

/** Provider hooks contain only provider-specific work; the base wraps their lifecycle and errors. */
export interface IntegrationDefinition<R = never> extends IntegrationMetadata {
  readonly actions: readonly IntegrationActionDefinition[]
  readonly resources: readonly IntegrationResource[]
  /** Installs dependencies and upserts resources; the base publishes the final inspect. */
  readonly install: () => IntegrationEffect<void, unknown, R>
  /** Inspects durable provider facts only; the base handles live in-process progress. */
  readonly inspect: () => IntegrationEffect<CheckResult, unknown, R>
  /** Performs a statically declared, currently available action with an opaque host payload. */
  readonly onActionCallback: (actionId: string, payload?: unknown) => IntegrationEffect<void, unknown, R>
}
