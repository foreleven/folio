import { RpcMiddleware } from 'effect/unstable/rpc'
import { HarnessStoreError } from '../harness'
import type { VaultContext } from '../vault-context'
import type { TaskService } from '../task-service'

/** Main supplies the calling window's services; clients send only operation-specific input. */
export class VaultMiddleware extends RpcMiddleware.Service<
  VaultMiddleware,
  {
    provides: VaultContext | TaskService
  }
>()('folio/rpc/VaultMiddleware', { error: HarnessStoreError }) {}
