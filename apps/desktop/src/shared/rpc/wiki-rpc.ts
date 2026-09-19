import { Schema } from 'effect'
import { Rpc, RpcGroup, RpcMiddleware } from 'effect/unstable/rpc'
import { HarnessStoreError } from '../harness'
import { PageDocument, SaveObjectTypes, SavePage, WikiSnapshot } from '../wiki'
import type { WikiService } from '../wiki-service'

/** A separate contract keeps existing task callers independent of knowledge editing. */
export class WikiMiddleware extends RpcMiddleware.Service<WikiMiddleware, { provides: WikiService }>()(
  'folio/rpc/WikiMiddleware', { error: HarnessStoreError }
) {}
export const WikiRpcs = RpcGroup.make(
  Rpc.make('wiki.snapshot', { payload: {}, success: WikiSnapshot, error: HarnessStoreError }),
  Rpc.make('wiki.read', { payload: { id: Schema.NonEmptyString }, success: PageDocument, error: HarnessStoreError }),
  Rpc.make('wiki.save', { payload: { input: SavePage }, success: PageDocument, error: HarnessStoreError }),
  Rpc.make('wiki.saveTypes', { payload: { input: SaveObjectTypes }, success: WikiSnapshot, error: HarnessStoreError })
).middleware(WikiMiddleware)
