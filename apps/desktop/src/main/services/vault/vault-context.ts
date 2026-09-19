import { join } from 'node:path'
import type { Vault } from '../../../shared/vault'
import { VaultContext } from '../../../shared/vault-context'
export { VaultContext } from '../../../shared/vault-context'

/** Captures immutable identity before a Vault window is navigated. */
export function makeVaultContext(vault: Vault, configDirectory: string): VaultContext['Service'] {
  return Object.freeze({ id: vault.id, vault: Object.freeze({ ...vault }), directory: join(configDirectory, 'vaults', vault.id) })
}
