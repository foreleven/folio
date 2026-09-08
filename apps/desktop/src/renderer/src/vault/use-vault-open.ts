import { useAtomSet } from '@effect/atom-react'
import { useRef, useState } from 'react'
import { VaultRpcClient } from '../rpc/vault-rpc'

/** Shares pending/error state across picker and recent-vault actions, blocking repeated submissions. */
export function useVaultOpen() {
  const select = useAtomSet(VaultRpcClient.open, { mode: 'promise' })
  const openExisting = useAtomSet(VaultRpcClient.openExisting, { mode: 'promise' })
  const pending = useRef(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  /** Sends only an ID for registered vaults; picker cancellation restores the idle state. */
  async function openVault(id?: string): Promise<void> {
    if (pending.current) return
    pending.current = true
    setOpening(id ?? 'picker')
    setFailed(false)
    try {
      if (id) await openExisting({ payload: { id } })
      else await select({ payload: undefined })
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setOpening(null)
    }
  }

  return { openVault, opening, failed }
}
