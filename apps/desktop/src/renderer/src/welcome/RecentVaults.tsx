import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useLocale } from '../preferences'
import { configAtom } from '../rpc/config-rpc'

interface RecentVaultsProps {
  opening: string | null
  onOpen: (id: string) => Promise<void>
}

/** Lists registered vaults newest first, with loading, empty, and retry states. */
export function RecentVaults({ opening, onOpen }: RecentVaultsProps): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const config = useAtomValue(configAtom)
  const refresh = useAtomRefresh(configAtom)
  const vaults = config._tag === 'Success' ? [...config.value.vaults].reverse() : []
  return (
    <section className="min-w-0" aria-labelledby="recent-vaults-heading">
      <h2 className="mb-2 text-support font-medium text-muted-foreground" id="recent-vaults-heading">{chinese ? '最近的知识库' : 'RECENT VAULTS'}</h2>
      {config._tag === 'Failure' ? <div>
        <p role="alert" className="m-0 max-w-110 text-support text-destructive">{chinese ? '无法加载知识库列表。' : 'Could not load your vaults.'}</p>
        <Button variant="ghost" onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button>
      </div> : config._tag !== 'Success' ? <p role="status" className="m-0 py-2 text-support text-muted-foreground">{chinese ? '正在加载…' : 'Loading vaults…'}</p>
        : vaults.length === 0 ? <p className="m-0 py-2 text-support text-muted-foreground">{chinese ? '还没有知识库。打开一个文件夹，从这里开始。' : 'No vaults yet. Open a folder to get started.'}</p>
          : <ul className="-m-1 list-none p-1">
            {vaults.map((vault) => <li key={vault.id}>
              <Button variant="ghost" className="h-auto min-h-11 w-full justify-between gap-3 rounded-sm px-2 py-0 text-left" title={vault.path} disabled={opening !== null} onClick={() => void onOpen(vault.id)}>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-ui">{vault.name}</span>
                  <span className="truncate text-support font-mono font-normal text-muted-foreground">{vault.path}</span>
                </span>
                <span className="text-muted-foreground" aria-hidden="true">{opening === vault.id ? '…' : '→'}</span>
              </Button>
            </li>)}
          </ul>}
    </section>
  )
}
