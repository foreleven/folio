import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Alert, AlertDescription, AlertTitle } from '@folio/ui/components/ui/alert'
import { Button } from '@folio/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@folio/ui/components/ui/dialog'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { CircleAlertIcon, FolderIcon, LoaderCircleIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Vault } from '../../../shared/vault'
import { useLocale } from '../preferences'
import { ConfigRpcClient } from '../rpc/config-rpc'
import { VaultRpcClient } from '../rpc/vault-rpc'
import { settingsMessages } from './messages'

/** Lists registered vaults and delegates removal to the main process. */
export function VaultsSettings(): React.JSX.Element {
  const locale = useLocale()
  const text = settingsMessages[locale]
  const config = useAtomValue(ConfigRpcClient.watch)
  const refresh = useAtomRefresh(ConfigRpcClient.watch)
  const remove = useAtomSet(VaultRpcClient.remove, { mode: 'promise' })
  const [selected, setSelected] = useState<Vault | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const removing = useRef(false)

  async function confirmRemove(): Promise<void> {
    if (!selected || removing.current) return
    removing.current = true
    setPending(true)
    setError(false)
    try {
      await remove({ payload: { id: selected.id } })
      setSelected(null)
      refresh()
    } catch {
      // The RPC error may contain filesystem details; Settings exposes only a safe action.
      setError(true)
    } finally {
      removing.current = false
      setPending(false)
    }
  }

  return (
    <>
      {config._tag === 'Failure' ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{text.loadError}</AlertTitle>
          <AlertDescription>{text.loadDetail}</AlertDescription>
          <Button variant="outline" onClick={refresh} className="mt-3 w-fit">
            {text.retry}
          </Button>
        </Alert>
      ) : config._tag !== 'Success' ? (
        <div role="status" aria-label={text.loading} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <section aria-label={text.vaults} className="flex flex-col gap-4">
          <p className="m-0 text-sm text-muted-foreground">{text.vaultsDescription}</p>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{text.vaultRemoveError}</AlertTitle>
              <AlertDescription>{text.vaultRemoveDetail}</AlertDescription>
            </Alert>
          ) : null}
          {config.value.vaults.length === 0 ? (
            <p className="m-0 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">{text.noVaults}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {config.value.vaults.map((vault) => (
                <li key={vault.id} className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5">
                  <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm font-medium">{vault.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground" title={vault.path}>
                      {vault.path}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${text.deleteVault}: ${vault.name}`}
                    disabled={pending}
                    onClick={() => {
                      setError(false)
                      setSelected(vault)
                    }}
                  >
                    {pending && selected?.id === vault.id ? <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" /> : text.deleteVault}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null)
        }}
      >
        {selected === null ? null : (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{text.deleteVaultTitle}</DialogTitle>
              <DialogDescription>{text.deleteVaultDescription}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={() => setSelected(null)}>
                {text.cancel}
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => void confirmRemove()}>
                {pending ? text.removingVault : text.confirmRemove}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
