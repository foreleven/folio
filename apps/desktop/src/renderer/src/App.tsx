import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { VaultRpcClient } from './rpc/vault-rpc'
import { useLocale } from './preferences'

/** Opens the native directory picker once per submission and keeps failures retryable. */
function OpenVaultButton(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const open = useAtomSet(VaultRpcClient.open, { mode: 'promise' })
  const pending = useRef(false)
  const [status, setStatus] = useState<'idle' | 'opening' | 'error'>('idle')

  /** Cancellation returns to idle; only a completed main-process action counts as success. */
  async function selectDirectory(): Promise<void> {
    if (pending.current) return
    pending.current = true
    setStatus('opening')
    try {
      await open({ payload: undefined })
      setStatus('idle')
    } catch {
      setStatus('error')
    } finally {
      pending.current = false
    }
  }

  return (
    <div className="vault-open-action">
      <Button size="lg" disabled={status === 'opening'} onClick={() => void selectDirectory()}>
        {status === 'opening' ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开文件夹' : 'Open Folder')}
      </Button>
      {status === 'error' ? <p role="alert" className="vault-error">
        {chinese ? '无法打开知识库。请检查所选目录和 vault 配置后重试。' : 'Could not open the vault. Check the selected folder and vault configuration, then try again.'}
      </p> : null}
    </div>
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
    return <main className="app-shell"><section className="welcome-card" role="status">
      <p>{result._tag === 'Failure' ? (chinese ? '无法加载知识库。' : 'Could not load the vault.') : (chinese ? '正在加载…' : 'Loading…')}</p>
      {result._tag === 'Failure' ? <Button onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button> : null}
    </section></main>
  }
  if (!result.value) {
    return <main className="app-shell"><section className="welcome-card">
      <h1>{chinese ? '此知识库已关闭' : 'This vault is closed'}</h1>
      <p>{chinese ? '重新选择文件夹以打开知识库。' : 'Select its folder to open the vault again.'}</p>
      <OpenVaultButton />
    </section></main>
  }
  const vault = result.value
  return (
    <main className="vault-shell">
      <header className="vault-header">
        <div className="vault-heading"><span className="eyebrow">Folio</span><h1>{vault.name}</h1></div>
        <OpenVaultButton />
      </header>
      <section className="vault-content">
        <div className="vault-mark" aria-hidden="true">F</div>
        <h2>{chinese ? '知识库已打开' : 'Your vault is open'}</h2>
        <p>{chinese ? '此文件夹是你的个人 Wiki 文件存储位置。' : 'This folder is home to your personal wiki files.'}</p>
        <code className="vault-path">{vault.path}</code>
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

/** Shows a centered welcome page until this native window is bound to a vault. */
export function App(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const hash = useSyncExternalStore(subscribeToHashChange, getWindowHash)
  if (hash.startsWith('#vault/')) return <VaultWorkspace id={hash.slice('#vault/'.length)} />
  return (
    <main className="app-shell">
      <section className="welcome-card">
        <div className="vault-mark" aria-hidden="true">F</div>
        <span className="eyebrow">Folio</span>
        <h1>{chinese ? '你的知识，自成一页。' : 'A home for your knowledge.'}</h1>
        <p>{chinese ? '选择一个文件夹作为知识库，收纳你的个人 Wiki。' : 'Open a folder as a vault for your personal wiki.'}</p>
        <OpenVaultButton />
        <p className="welcome-hint">{chinese ? '在当前窗口打开你的知识库。' : 'Open your vault in this window.'}</p>
      </section>
    </main>
  )
}
