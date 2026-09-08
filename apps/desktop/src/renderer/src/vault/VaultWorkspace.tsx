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
    return <main className="grid min-h-screen place-items-center bg-background p-10 max-[600px]:p-6"><section className="w-full max-w-160 text-center" role="status">
      <p className="leading-[1.7] text-muted-foreground">{result._tag === 'Failure' ? (chinese ? '无法加载知识库。' : 'Could not load the vault.') : (chinese ? '正在加载…' : 'Loading…')}</p>
      {result._tag === 'Failure' ? <Button onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button> : null}
    </section></main>
  }
  if (!result.value) {
    return <main className="grid min-h-screen place-items-center bg-background p-10 max-[600px]:p-6"><section className="w-full max-w-160 text-center">
      <h1 className="mt-3.5 mb-4.5 text-[clamp(2rem,4.5vw,3rem)] leading-[1.2] font-[550] tracking-[-0.04em]">{chinese ? '此知识库已关闭' : 'This vault is closed'}</h1>
      <p className="leading-[1.7] text-muted-foreground">{chinese ? '重新选择文件夹以打开知识库。' : 'Select its folder to open the vault again.'}</p>
      <div className="mt-8 leading-[1.7]"><OpenVaultButton /></div>
    </section></main>
  }
  const vault = result.value
  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between gap-6 border-b border-border px-7 py-5 max-[600px]:p-4">
        <div className="min-w-0"><span className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">Folio</span><h1 className="mt-1 text-base font-semibold wrap-anywhere">{vault.name}</h1></div>
        <OpenVaultButton />
      </header>
      <section className="flex flex-1 flex-col items-center justify-center px-7 py-12 text-center">
        <div className="mx-auto mb-7 size-16 rounded-[18px] text-4xl grid place-items-center border border-border bg-muted font-[Georgia,serif] text-foreground" aria-hidden="true">F</div>
        <h2 className="text-2xl font-[550] tracking-[-0.03em]">{chinese ? '知识库已打开' : 'Your vault is open'}</h2>
        <p className="leading-[1.7] text-muted-foreground">{chinese ? '此文件夹是你的个人 Wiki 文件存储位置。' : 'This folder is home to your personal wiki files.'}</p>
        <code className="max-w-full rounded-lg border border-border px-4 py-2.5 text-[0.8rem] text-muted-foreground wrap-anywhere">{vault.path}</code>
      </section>
    </main>
  )
}
