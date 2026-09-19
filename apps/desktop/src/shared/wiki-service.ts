import { Context, type Effect } from 'effect'
import type { HarnessStoreError } from './harness'
import type { PageDocument, SaveObjectTypes, SavePage, WikiSnapshot } from './wiki'

/** Wiki operations are bound to the calling Vault, never to a renderer-supplied root. */
export class WikiService extends Context.Service<WikiService, {
  readonly snapshot: Effect.Effect<WikiSnapshot, HarnessStoreError>
  readonly read: (id: string) => Effect.Effect<PageDocument, HarnessStoreError>
  readonly save: (input: SavePage) => Effect.Effect<PageDocument, HarnessStoreError>
  readonly saveTypes: (input: SaveObjectTypes) => Effect.Effect<WikiSnapshot, HarnessStoreError>
}>()('folio/services/WikiService') {}
