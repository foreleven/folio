import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui'
import { requestSystemInfoAtom } from './atoms/system-info'
import { SystemRpcClient } from './rpc/system-rpc'
import { useLocale } from './preferences'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const systemInfoState = useAtomValue(SystemRpcClient.getSystemInfo)
  const refresh = useAtomRefresh(SystemRpcClient.getSystemInfo)
  const requestSystemInfo = useAtomSet(requestSystemInfoAtom)
  const count = useAtomSet(SystemRpcClient.count, {mode: 'promise'})

  console.info(systemInfoState)
  const systemInfoLabel = systemInfoState._tag === 'Success'
    ? `${systemInfoState.value.platform} · v${systemInfoState.value.version}`
    : systemInfoState.waiting
    ? (chinese ? '正在读取…' : 'Checking…')
    : systemInfoState._tag === 'Failure'
    ? (chinese ? '不可用' : 'Unavailable')
    : (chinese ? '尚未读取' : 'Not checked')

  return (
    <main className="app-shell">
      <section className="welcome-card">
        <span className="eyebrow">Folio Desktop</span>
        <h1>{chinese ? '你的 Electron 工作空间已就绪。' : 'Your Electron workspace is ready.'}</h1>
        <p>
          {chinese
            ? 'Electron 43、electron-vite 5、TypeScript 和共享 UI 组件库已连接。'
            : 'Electron 43, electron-vite 5, TypeScript, and a shared UI package are wired together.'}
        </p>
        <div className="actions">
          <Button
            onClick={() => requestSystemInfo()}
          >
            {systemInfoState.waiting ? (chinese ? '正在读取…' : 'Checking…') : (chinese ? '查看系统信息' : 'Check platform')}
          </Button>
          <code>{systemInfoLabel}</code>
        </div>
      </section>
    </main>
  )
}
