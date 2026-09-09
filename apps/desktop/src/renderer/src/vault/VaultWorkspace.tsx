import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { FileTextIcon, FolderIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useLocale } from '../preferences'
import { VaultRpcClient } from '../rpc/vault-rpc'
import { OpenVaultButton } from './OpenVaultButton'

/** Resolves this window's vault by stable ID; reloads keep the same window context. */
export function VaultWorkspace({ id }: { id: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = VaultRpcClient.query('vault.get', { id })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const name = result._tag === 'Success' ? result.value?.name : undefined
  // The HTML document title otherwise overrides Electron's initial native window title.
  useEffect(() => { document.title = name ? `${name} — Folio` : 'Folio' }, [name])
  if (result._tag !== 'Success') {
    return <main className="min-h-svh bg-background p-4"><section className="w-full max-w-190 space-y-2" role="status">
      <p className="text-support text-muted-foreground">{result._tag === 'Failure' ? (chinese ? '无法加载知识库。' : 'Could not load the vault.') : (chinese ? '正在加载…' : 'Loading…')}</p>
      {result._tag === 'Failure' ? <Button onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button> : null}
    </section></main>
  }
  if (!result.value) {
    return <main className="min-h-svh bg-background p-4"><section className="w-full max-w-190 space-y-2">
      <h1 className="text-sm leading-5 font-semibold">{chinese ? '此知识库已关闭' : 'This vault is closed'}</h1>
      <p className="text-support text-muted-foreground">{chinese ? '重新选择文件夹以打开知识库。' : 'Select its folder to open the vault again.'}</p>
      <div className="mt-3 text-support"><OpenVaultButton /></div>
    </section></main>
  }
  const vault = result.value
  return (
    <main className="flex h-svh min-h-0 flex-col bg-background">
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b px-3">
        <h1 className="min-w-0 truncate text-ui font-semibold" title={vault.name}>{vault.name}</h1>
        <OpenVaultButton />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-55 shrink-0 flex-col border-r bg-sidebar max-[700px]:w-45" aria-label={chinese ? '知识库' : 'Vault'}>
          <div className="flex h-7 shrink-0 items-center border-b px-2 text-support font-medium text-muted-foreground">{chinese ? '知识库' : 'VAULT'}</div>
          <div className="flex h-7 min-w-0 items-center gap-2 px-2 text-ui" title={vault.path}>
            <FolderIcon className="size-4 shrink-0 text-primary" />
            <span className="truncate">{vault.name}</span>
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col bg-background" aria-labelledby="vault-overview-title">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-ui font-medium">
            <FileTextIcon className="size-3.5 text-muted-foreground" />
            <span>{chinese ? '概览' : 'Overview'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <article className="mx-auto w-full max-w-190 px-6 py-6">
              <h2 id="vault-overview-title" className="text-lg leading-6 font-semibold">{chinese ? '知识库已打开' : 'Your vault is open'}</h2>
              <p className="mt-2 text-base leading-[26px] text-foreground">{chinese ? '此文件夹是你的个人 Wiki 文件存储位置。' : 'This folder is home to your personal wiki files.'}</p>
              <code className="mt-4 block max-w-full border-l-2 border-primary/50 pl-3 text-support text-muted-foreground wrap-anywhere">{vault.path}</code>
            </article>
          </div>
        </section>
      </div>
    </main>
  )
}
