import { Context, Effect, Layer } from 'effect'
import type { TaskService } from '../tasks/task-service'
import type { VaultContext } from './vault-context'

export type VaultServices = Context.Context<VaultContext | TaskService>

/** Binds native WebContents and server-assigned RPC clients; renderer payloads never select a Vault. */
export class VaultWindowContexts extends Context.Service<
  VaultWindowContexts,
  {
    readonly bind: (senderId: number, context: VaultServices) => void
    readonly unbind: (senderId: number) => void
    readonly connect: (clientId: number, senderId: number) => void
    readonly disconnect: (clientId: number) => void
    readonly get: (clientId: number) => VaultServices | undefined
  }
>()('folio/services/VaultWindowContexts') {
  static readonly layer = Layer.effect(
    VaultWindowContexts,
    Effect.sync(() => {
      const windows = new Map<number, VaultServices>()
      const clients = new Map<number, number>()
      return {
        bind: (senderId, context) => {
          windows.set(senderId, context)
        },
        unbind: (senderId) => {
          windows.delete(senderId)
        },
        connect: (clientId, senderId) => {
          clients.set(clientId, senderId)
        },
        disconnect: (clientId) => {
          clients.delete(clientId)
        },
        get: (clientId) => {
          const senderId = clients.get(clientId)
          return senderId === undefined ? undefined : windows.get(senderId)
        }
      }
    })
  )
}
