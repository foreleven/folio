import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { useEffect } from 'react'
import { ExecutionRpcClient } from '../../rpc/execution-rpc'
import { Vault } from '../../../../shared/vault'
import { Activity, Box } from 'lucide-react'

/** Shows persistent workspace state outside the scrollable page content. */
export function WorkspaceFooter({ chinese, sectionLabel, vault }: { chinese: boolean; sectionLabel: string; vault: Vault }): React.JSX.Element {
  return (
    <footer
      className="flex w-full h-7 shrink-0 items-center justify-between gap-3 border-t bg-background px-3 text-support text-muted-foreground"
      aria-label={chinese ? '知识库状态' : 'Vault status'}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Box className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate" title={vault.path}>
          {vault.name}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <GlobalTaskStatus chinese={chinese} />
        <span className="hidden sm:inline">{sectionLabel}</span>
        <span className="text-muted-foreground/60">Folio</span>
      </div>
    </footer>
  )
}

/** Poll even while idle so work admitted by another Vault becomes visible. */
function GlobalTaskStatus({ chinese }: { chinese: boolean }): React.JSX.Element {
  const query = useAtomValue(ExecutionRpcClient.status)
  const refresh = useAtomRefresh(ExecutionRpcClient.status)
  useEffect(() => {
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [refresh])
  if (query._tag !== 'Success') return <span role="status">{query._tag === 'Failure'
    ? (chinese ? '全局任务状态不可用' : 'Global task status unavailable')
    : (chinese ? '正在读取全局任务…' : 'Loading global tasks…')}</span>
  const value = query.value
  const attention = value.failed + value.interrupted
  const summary = chinese
    ? `全局任务 · 执行 ${value.running} · 准备 ${value.preparing} · 排队 ${value.queued}`
    : `All vaults · Running ${value.running} · Preparing ${value.preparing} · Queued ${value.queued}`
  const detail = chinese
    ? `共 ${value.vaults} 个 Vault；并发上限 ${value.concurrency}；历史执行：成功 ${value.succeeded}，失败 ${value.failed}，中断 ${value.interrupted}，取消 ${value.cancelled}。按执行次数统计，每 2 秒刷新。`
    : `${value.vaults} vaults; concurrency limit ${value.concurrency}; execution history: ${value.succeeded} succeeded, ${value.failed} failed, ${value.interrupted} interrupted, ${value.cancelled} cancelled. Counts execution attempts; refreshes every 2 seconds.`
  return <span role="status" title={detail} className="flex min-w-0 items-center gap-1.5 tabular-nums">
    <Activity className="size-3.5 shrink-0" aria-hidden="true" />
    <span className="truncate">{summary}</span>
    {attention > 0 && <span className="shrink-0 text-warning">{chinese ? `失败/中断 ${attention}` : `Failed/interrupted ${attention}`}</span>}
    {value.unavailableVaults > 0 && <span className="shrink-0 text-warning">{chinese ? `${value.unavailableVaults} 个 Vault 不可用` : `${value.unavailableVaults} vault(s) unavailable`}</span>}
  </span>
}
