import type { Integration } from '@folio/integrations/base'
import { Context, type FileSystem } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'

export type IntegrationPlatform = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

/** Composition boundary for bundled providers; the execution service consumes only this registry. */
export class IntegrationCatalog extends Context.Service<IntegrationCatalog, readonly Integration<IntegrationPlatform>[]>()('folio/services/IntegrationCatalog') {}
