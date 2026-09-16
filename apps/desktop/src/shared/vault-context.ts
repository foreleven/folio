import { Context } from 'effect'
import type { Vault } from './vault'

/** Trusted identity and managed paths, constructed only from the main-process Vault registry. */
export class VaultContext extends Context.Service<
  VaultContext,
  {
    readonly id: string
    readonly vault: Vault
    readonly directory: string
  }
>()('folio/services/VaultContext') {}
