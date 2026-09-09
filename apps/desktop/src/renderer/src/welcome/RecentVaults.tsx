import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Alert, AlertAction, AlertDescription } from '@folio/ui/components/ui/alert'
import { Button } from '@folio/ui/components/ui/button'
import { Separator } from '@folio/ui/components/ui/separator'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@folio/ui/components/ui/tooltip'
import { cn } from '@folio/ui/lib/utils'
import { CircleAlertIcon, FolderIcon, LoaderCircleIcon } from 'lucide-react'
import type { Vault } from '../../../shared/vault'
import { useLocale } from '../preferences'
import { configAtom } from '../rpc/config-rpc'

interface RecentVaultsProps {
  opening: string | null
  onOpen: (id: string) => Promise<void>
}

interface RecentVaultRowProps {
  vault: Vault
  opening: string | null
  onOpen: (id: string) => Promise<void>
}

/** Keeps recent-vault names, paths, progress, and actions aligned across every row. */
function RecentVaultRow({ vault, opening, onOpen }: RecentVaultRowProps): React.JSX.Element {
  const busy = opening === vault.id
  return (
    <li>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" className="h-11 w-full justify-start gap-3 rounded-md px-3 text-left sm:px-4"
          aria-label={`${vault.name}: ${vault.path}`} disabled={opening !== null} onClick={() => void onOpen(vault.id)} />}>
          <FolderIcon data-icon="inline-start" className="size-4 text-muted-foreground" />
          <span className="grid min-w-0 flex-1 gap-0.5 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)] sm:items-center sm:gap-6">
            <span className="truncate text-sm font-normal sm:text-base">{vault.name}</span>
            <span className="truncate font-mono text-xs font-normal text-muted-foreground sm:text-right">{vault.path}</span>
          </span>
          {busy
            ? <LoaderCircleIcon data-icon="inline-end" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
            : null}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start"><span className="font-mono">{vault.path}</span></TooltipContent>
      </Tooltip>
    </li>
  )
}

/** Mirrors final two-line rows while the recent-vault registry is loading. */
function RecentVaultSkeleton(): React.JSX.Element {
  return <div role="status" aria-label="Loading vaults">
    {[0, 1, 2].map((index) => <div className="flex h-11 items-center gap-3 px-3 sm:px-4" key={index}>
      <Skeleton className="size-4 shrink-0" />
      <span className="grid flex-1 gap-1.5 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)] sm:items-center sm:gap-6">
        <Skeleton className="h-4 w-28 max-w-[70%]" />
        <Skeleton className="h-3 w-64 max-w-[80%] sm:justify-self-end" />
      </span>
    </div>)}
  </div>
}

/** Lists registered vaults newest first, with loading, empty, and retry states. */
export function RecentVaults({ opening, onOpen }: RecentVaultsProps): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const config = useAtomValue(configAtom)
  const refresh = useAtomRefresh(configAtom)
  const vaults = config._tag === 'Success' ? [...config.value.vaults].reverse() : []
  return (
    <section className="min-w-0" aria-labelledby="recent-vaults-heading">
      <div className="mb-3 flex w-full items-center gap-4">
        <h2 className={cn('shrink-0 font-mono text-xs font-medium text-muted-foreground', !chinese && 'tracking-[0.04em]')} id="recent-vaults-heading">
          {chinese ? '最近的知识库' : 'RECENT VAULTS'}
        </h2>
        <Separator className="min-w-0 flex-1 bg-border/80" />
      </div>
      {config._tag === 'Failure' ? <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertDescription>{chinese ? '无法加载知识库列表。' : 'Could not load your vaults.'}</AlertDescription>
        <AlertAction><Button size="xs" variant="ghost" onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button></AlertAction>
      </Alert> : config._tag !== 'Success' ? <RecentVaultSkeleton />
        : vaults.length === 0 ? <div className="flex h-11 items-center px-3 sm:px-4">
          <p className="m-0 text-sm text-muted-foreground">{chinese ? '还没有知识库。打开一个文件夹，从这里开始。' : 'No vaults yet. Open a folder to get started.'}</p>
        </div>
          : <TooltipProvider><ul className="list-none p-0">
            {vaults.map((vault) => <RecentVaultRow key={vault.id} vault={vault} opening={opening} onOpen={onOpen} />)}
          </ul></TooltipProvider>}
    </section>
  )
}
