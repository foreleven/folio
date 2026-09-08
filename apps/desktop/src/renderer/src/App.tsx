import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { cn } from '@folio/ui/lib/utils'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { VaultRpcClient } from './rpc/vault-rpc'
import { configAtom } from './rpc/config-rpc'
import { useLocale } from './preferences'

/** Shares pending/error state across picker and recent-vault actions, blocking repeated submissions. */
function useVaultOpen() {
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

/** Keeps the same localized, retryable open failure in welcome and workspace actions. */
function VaultOpenError({ className }: { className?: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return <p role="alert" className={cn("m-0 max-w-110 text-[0.85rem] text-destructive", className)}>
    {chinese ? '无法打开知识库。请检查目录是否存在及 vault 配置后重试。' : 'Could not open the vault. Check that the folder exists and its configuration is accessible, then try again.'}
  </p>
}

/** Opens the native directory picker from an existing workspace or closed-vault screen. */
function OpenVaultButton(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const { openVault, opening, failed } = useVaultOpen()
  return (
    <div className="grid justify-items-center gap-3">
      <Button size="lg" disabled={opening !== null} onClick={() => void openVault()}>
        {opening ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}
      </Button>
      {failed ? <VaultOpenError /> : null}
    </div>
  )
}

/** Uses the shared config stream for registered vaults, newest registrations first. */
function Welcome(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const config = useAtomValue(configAtom)
  const refresh = useAtomRefresh(configAtom)
  const { openVault, opening, failed } = useVaultOpen()
  const vaults = config._tag === 'Success' ? [...config.value.vaults].reverse() : []

  return (
    <main className="grid min-h-screen place-items-center bg-background p-10 max-[600px]:p-6">
      <section className="w-full max-w-140 text-center">
        <header className="mb-7 flex items-center gap-4 text-left">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted font-[Georgia,serif] text-2xl text-foreground" aria-hidden="true">F</div>
          <div className="min-w-0">
            <span className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">Folio</span>
            <h1 className="my-1 text-[clamp(1.25rem,2.5vw,1.5rem)] leading-tight font-[550] tracking-[-0.035em]">{chinese ? '你的知识，自成一页。' : 'A home for your knowledge.'}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">{chinese ? '打开一个知识库，继续记录与探索。' : 'Open a vault. Pick up where you left off.'}</p>
          </div>
        </header>
        <div className="flex flex-col gap-7 text-left">
          <section className="min-w-0" aria-labelledby="get-started-heading">
            <h2 className="mb-4 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground" id="get-started-heading">{chinese ? '开始使用' : 'GET STARTED'}</h2>
            <Button variant="outline" className="h-12 w-full justify-between px-4" disabled={opening !== null} onClick={() => void openVault()}>
              <span>{opening === 'picker' ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}</span>
              <span aria-hidden="true">↗</span>
            </Button>
            <p className="mt-3 text-[0.8rem] leading-[1.7] text-muted-foreground">{chinese ? '选择一个文件夹作为你的知识库。' : 'Choose a folder for your knowledge.'}</p>
          </section>
          <section className="min-w-0" aria-labelledby="recent-vaults-heading">
            <h2 className="mb-4 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground" id="recent-vaults-heading">{chinese ? '最近的知识库' : 'RECENT VAULTS'}</h2>
            {config._tag === 'Failure' ? <div>
              <p role="alert" className="m-0 max-w-110 text-[0.85rem] leading-[1.7] text-destructive">{chinese ? '无法加载知识库列表。' : 'Could not load your vaults.'}</p>
              <Button variant="ghost" onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button>
            </div> : config._tag !== 'Success' ? <p role="status" className="m-0 py-3 text-[0.85rem] leading-[1.7] text-muted-foreground">{chinese ? '正在加载…' : 'Loading vaults…'}</p>
              : vaults.length === 0 ? <p className="m-0 py-3 text-[0.85rem] leading-[1.7] text-muted-foreground">{chinese ? '还没有知识库。打开一个文件夹，从这里开始。' : 'No vaults yet. Open a folder to get started.'}</p>
                : <ul className="-m-1.5 max-h-70 list-none overflow-y-auto p-1.5">
                  {vaults.map((vault) => <li key={vault.id}>
                    <Button variant="ghost" className="h-auto min-h-15 w-full justify-between gap-4 px-3 py-2.5 text-left" title={vault.path} disabled={opening !== null} onClick={() => void openVault(vault.id)}>
                      <span className="grid min-w-0 gap-1">
                        <span className="truncate text-sm">{vault.name}</span>
                        <span className="truncate text-xs font-normal text-muted-foreground">{vault.path}</span>
                      </span>
                      <span className="text-muted-foreground" aria-hidden="true">{opening === vault.id ? '…' : '→'}</span>
                    </Button>
                  </li>)}
                </ul>}
          </section>
        </div>
        {opening !== null ? <span role="status" className="sr-only">{chinese ? '正在打开知识库…' : 'Opening vault…'}</span> : null}
        {failed ? <VaultOpenError className="mx-auto mt-6 leading-[1.7]" /> : null}
      </section>
    </main>
  )
}

/** Resolves this window's vault by stable ID; reloads keep the same window context. */
function VaultWorkspace({ id }: { id: string }): React.JSX.Element {
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

/** Follows same-document Electron navigation without requiring a renderer process reload. */
function subscribeToHashChange(notify: () => void): () => void {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}

/** Returns the current native-window route for React's external-store subscription. */
function getWindowHash(): string {
  return window.location.hash
}

/** Shows welcome until this native window is bound to a vault. */
export function App(): React.JSX.Element {
  const hash = useSyncExternalStore(subscribeToHashChange, getWindowHash)
  if (hash.startsWith('#vault/')) return <VaultWorkspace id={hash.slice('#vault/'.length)} />
  return <Welcome />
}
