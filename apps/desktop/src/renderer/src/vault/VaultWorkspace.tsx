import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
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
      <header className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b px-3 py-0.5">
        <h1 className="min-w-0 truncate text-ui font-semibold" title={vault.name}>{vault.name}</h1>
        <OpenVaultButton />
      </header>
      <section className="flex min-h-0 flex-1 flex-col items-start gap-2 overflow-y-auto p-4">
        <h2 className="text-sm leading-5 font-semibold">{chinese ? '知识库已打开' : 'Your vault is open'}</h2>
        <p className="text-support text-muted-foreground">{chinese ? '此文件夹是你的个人 Wiki 文件存储位置。' : 'This folder is home to your personal wiki files.'}</p>
        <code className="max-w-full text-support text-muted-foreground wrap-anywhere">{vault.path}</code>
      </section>
    </main>
  )
}
