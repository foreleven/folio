import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Badge } from '@folio/ui/components/ui/badge'
import { Button } from '@folio/ui/components/ui/button'
import { Card, CardContent } from '@folio/ui/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@folio/ui/components/ui/dialog'
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  Maximize2Icon,
  PlayIcon,
  RefreshCwIcon,
  TimerIcon,
  WorkflowIcon,
  ZapIcon
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { RoutineExecution, RoutineRecord } from '../../../shared/routine'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { RoutineEditor } from './RoutineEditor'

type ExecutionStatus = RoutineExecution['status']

function statusLabel(status: ExecutionStatus, chinese: boolean): string {
  const labels: Record<ExecutionStatus, string> = {
    pending: chinese ? '待处理' : 'Pending',
    preparing: chinese ? '准备中' : 'Preparing',
    running: chinese ? '执行中' : 'Running',
    succeeded: chinese ? '已完成' : 'Succeeded',
    failed: chinese ? '失败' : 'Failed',
    cancelled: chinese ? '已取消' : 'Cancelled',
    interrupted: chinese ? '已中断' : 'Interrupted'
  }
  return labels[status]
}

function statusVariant(status: ExecutionStatus): 'success' | 'progress' | 'destructive' | 'outline' {
  if (status === 'succeeded') return 'success'
  if (status === 'preparing' || status === 'running') return 'progress'
  if (status === 'failed' || status === 'interrupted') return 'destructive'
  return 'outline'
}

function formatTime(timestamp: number | null, timeZone: string, chinese: boolean): string {
  if (timestamp === null) return chinese ? '未记录' : 'Not recorded'
  return new Intl.DateTimeFormat(chinese ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone
  }).format(timestamp)
}

function formatDate(date: string, chinese: boolean): string {
  return new Intl.DateTimeFormat(chinese ? 'zh-CN' : 'en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${date}T12:00:00Z`))
}

function formatNextTrigger(record: RoutineRecord, chinese: boolean): string {
  return record.nextTriggerAt === null ? (chinese ? '未安排' : 'Not scheduled') : formatTime(record.nextTriggerAt, record.timeZone, chinese)
}

function deriveGapDates(rows: readonly RoutineExecution[]): string[] {
  const completed = new Set(rows.filter((row) => row.isEnd && row.status === 'succeeded').map((row) => row.routineDate))
  const dates = rows.map((row) => row.routineDate).sort()
  if (!dates.length) return []
  const cursor = new Date(`${dates[dates.length - 1]}T12:00:00Z`)
  const today = new Date()
  today.setUTCHours(12, 0, 0, 0)
  const gaps: string[] = []
  for (let date = new Date(`${dates[0]}T12:00:00Z`); date < today; date.setUTCDate(date.getUTCDate() + 1)) {
    const key = date.toISOString().slice(0, 10)
    if (date <= cursor && !completed.has(key)) gaps.push(key)
  }
  return gaps
}

function latestExecution(rows: readonly RoutineExecution[], routineId: string): RoutineExecution | undefined {
  return rows.find((row) => row.routineId === routineId)
}

/** Routine landing page: a compact operational dashboard with one card per automation. */
export function RoutinePanel(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const routinesQuery = TaskRpcClient.query('routines.list', {})
  const executionsQuery = TaskRpcClient.query('routines.allExecutions', {})
  const routines = useAtomValue(routinesQuery)
  const executions = useAtomValue(executionsQuery)
  const refreshRoutines = useAtomRefresh(routinesQuery)
  const refreshExecutions = useAtomRefresh(executionsQuery)
  const [editing, setEditing] = useState<{ id: string; record?: RoutineRecord } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const records = routines._tag === 'Success' ? routines.value : []
  const selected = records.find((record) => record.id === selectedId)
  const allExecutions = executions._tag === 'Success' ? executions.value : []
  const refresh = (): void => {
    refreshRoutines()
    refreshExecutions()
  }

  if (editing)
    return (
      <RoutineEditor
        initial={editing}
        onSaved={() => {
          setEditing(null)
          refresh()
        }}
        onCancel={() => setEditing(null)}
      />
    )
  if (selected)
    return (
      <RoutineDetail
        key={selected.id}
        record={selected}
        executions={allExecutions.filter((row) => row.routineId === selected.id)}
        executionsLoading={executions._tag !== 'Success'}
        onBack={() => setSelectedId(null)}
        onEdit={() => setEditing({ id: selected.id, record: selected })}
        refresh={refresh}
      />
    )

  return (
    <RoutineDashboard
      chinese={chinese}
      records={records}
      executions={allExecutions}
      loading={routines._tag !== 'Success'}
      executionsLoading={executions._tag !== 'Success'}
      failed={routines._tag === 'Failure'}
      onRefresh={refresh}
      onNew={() => setEditing({ id: crypto.randomUUID() })}
      onSelect={setSelectedId}
    />
  )
}

function RoutineDashboard({
  chinese,
  records,
  executions,
  loading,
  executionsLoading,
  failed,
  onRefresh,
  onNew,
  onSelect
}: {
  chinese: boolean
  records: readonly RoutineRecord[]
  executions: readonly RoutineExecution[]
  loading: boolean
  executionsLoading: boolean
  failed: boolean
  onRefresh: () => void
  onNew: () => void
  onSelect: (id: string) => void
}): React.JSX.Element {
  const activeCount = records.filter((record) => record.enabled).length
  const [now] = useState(() => Date.now())
  const recentExecutions = executions.filter((row) => row.triggerTime >= now - 7 * 24 * 60 * 60 * 1000)
  const successRate = recentExecutions.length ? Math.round((recentExecutions.filter((row) => row.status === 'succeeded').length / recentExecutions.length) * 100) : null
  const attentionCount = executions.filter((row) => row.status !== 'succeeded').length
  const nextRoutine = records.filter((record) => record.nextTriggerAt !== null).sort((left, right) => (left.nextTriggerAt ?? Infinity) - (right.nextTriggerAt ?? Infinity))[0]

  return (
    <section className="flex flex-col gap-6" aria-labelledby="routines-title">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-support font-medium text-primary">{chinese ? '自动化中心' : 'AUTOMATIONS'}</p>
          <h2 id="routines-title" className="mt-1 text-xl leading-7 font-semibold">
            {chinese ? 'Routine 仪表盘' : 'Routine dashboard'}
          </h2>
          <p className="mt-1 max-w-xl text-support text-muted-foreground">
            {chinese ? '集中查看工作流状态、执行情况和下一次触发时间。' : 'Monitor workflow health, execution history, and upcoming triggers.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCwIcon aria-hidden="true" />
            {chinese ? '刷新' : 'Refresh'}
          </Button>
          <Button size="sm" onClick={onNew}>
            <ZapIcon aria-hidden="true" />
            {chinese ? '新建 Routine' : 'New Routine'}
          </Button>
        </div>
      </header>

      {loading ? (
        <p role="status" className="text-support text-muted-foreground">
          {chinese ? '正在加载 Routine…' : 'Loading Routines…'}
        </p>
      ) : failed ? (
        <p role="alert" className="text-support text-destructive">
          {chinese ? '无法加载 Routine，请刷新重试。' : 'Could not load Routines. Refresh to retry.'}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={WorkflowIcon} label={chinese ? '全部 Routine' : 'Total routines'} value={records.length} />
            <MetricCard
              icon={PlayIcon}
              label={chinese ? '运行中' : 'Active'}
              value={activeCount}
              detail={records.length ? `${Math.round((activeCount / records.length) * 100)}%` : undefined}
            />
            <MetricCard
              icon={CheckCircle2Icon}
              label={chinese ? '近 7 天成功率' : '7-day success rate'}
              value={executionsLoading ? '—' : successRate === null ? '—' : `${successRate}%`}
              detail={recentExecutions.length ? `${recentExecutions.length} ${chinese ? '次执行' : 'runs'}` : undefined}
            />
            <MetricCard
              icon={attentionCount ? CircleAlertIcon : TimerIcon}
              label={chinese ? '需要关注' : 'Needs attention'}
              value={executionsLoading ? '—' : attentionCount}
              detail={nextRoutine ? `${chinese ? '下次' : 'Next'} ${formatNextTrigger(nextRoutine, chinese)}` : undefined}
            />
          </div>

          <section aria-labelledby="routine-list-title">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 id="routine-list-title" className="text-ui font-semibold">
                  {chinese ? '我的 Routines' : 'Your routines'}
                </h3>
                <p className="mt-0.5 text-support text-muted-foreground">{chinese ? '选择一个 Routine 查看完整执行记录' : 'Select a Routine to inspect its execution history'}</p>
              </div>
              <span className="text-support tabular-nums text-muted-foreground">{records.length}</span>
            </div>
            {records.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
                  <WorkflowIcon className="size-7 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-ui font-medium">{chinese ? '还没有 Routine' : 'No Routines yet'}</p>
                    <p className="mt-1 text-support text-muted-foreground">{chinese ? '创建第一个自动化工作流开始吧。' : 'Create your first automated workflow to get started.'}</p>
                  </div>
                  <Button size="sm" onClick={onNew}>
                    {chinese ? '创建 Routine' : 'Create Routine'}
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {records.map((record) => (
                  <RoutineCard
                    key={record.id}
                    record={record}
                    execution={latestExecution(executions, record.id)}
                    executionsLoading={executionsLoading}
                    chinese={chinese}
                    onClick={() => onSelect(record.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: typeof WorkflowIcon; label: string; value: string | number; detail?: string }): React.JSX.Element {
  return (
    <Card className="gap-0">
      <CardContent className="flex min-h-27 flex-col justify-between gap-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-support text-muted-foreground">{label}</span>
          <Icon className="size-4 text-primary" aria-hidden="true" />
        </div>
        <div className="flex items-end justify-between gap-2">
          <span className="text-2xl leading-7 font-semibold tabular-nums">{value}</span>
          {detail ? (
            <span className="max-w-32 truncate text-support text-muted-foreground" title={detail}>
              {detail}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function RoutineCard({
  record,
  execution,
  executionsLoading,
  chinese,
  onClick
}: {
  record: RoutineRecord
  execution: RoutineExecution | undefined
  executionsLoading: boolean
  chinese: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="group flex min-h-47 flex-col rounded-lg border bg-card p-4 text-left ring-1 ring-transparent transition-colors hover:border-primary/50 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      aria-label={chinese ? `打开 ${record.name} Routine 详情` : `Open ${record.name} Routine details`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-md ${record.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
            <WorkflowIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h4 className="truncate text-ui font-semibold">{record.name}</h4>
            <p className="mt-0.5 truncate text-support text-muted-foreground">
              {record.agent} · {record.intervalMinutes} min
            </p>
          </div>
        </div>
        <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden="true" />
      </div>
      <p className="mt-4 line-clamp-2 min-h-9 whitespace-pre-wrap text-support text-muted-foreground">{record.prompt}</p>
      <div className="mt-auto flex items-end justify-between gap-3 border-t pt-3">
        <div className="min-w-0">
          <p className="text-support text-muted-foreground">{chinese ? '最近执行' : 'Last execution'}</p>
          <p className="mt-0.5 truncate text-support font-medium">
            {executionsLoading
              ? chinese
                ? '加载中…'
                : 'Loading…'
              : execution
                ? formatTime(execution.triggerTime, record.timeZone, chinese)
                : chinese
                  ? '暂无记录'
                  : 'No runs yet'}
          </p>
        </div>
        <Badge variant={record.enabled ? 'success' : 'outline'}>{record.enabled ? (chinese ? '运行中' : 'Active') : chinese ? '已暂停' : 'Paused'}</Badge>
      </div>
    </button>
  )
}

function RoutineDetail({
  record,
  executions,
  executionsLoading,
  onBack,
  onEdit,
  refresh
}: {
  record: RoutineRecord
  executions: readonly RoutineExecution[]
  executionsLoading: boolean
  onBack: () => void
  onEdit: () => void
  refresh: () => void
}): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const run = useAtomSet(TaskRpcClient.runRoutine, { mode: 'promise' })
  const prepare = useAtomSet(TaskRpcClient.prepareRoutine, { mode: 'promise' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const runRequest = useRef<{ routineId: string; requestId: string } | null>(null)
  const dates = useMemo(() => {
    const datesWithRows = executions.map((row) => row.routineDate)
    return [...new Set([...datesWithRows, ...deriveGapDates(executions)])].sort().reverse()
  }, [executions])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const activeDate = selectedDate && dates.includes(selectedDate) ? selectedDate : (dates[0] ?? null)
  const activeRows = executions.filter((row) => row.routineDate === activeDate).sort((left, right) => left.triggerTime - right.triggerTime)

  async function invoke(kind: 'run' | 'prepare'): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      if (kind === 'run') {
        if (runRequest.current?.routineId !== record.id) runRequest.current = { routineId: record.id, requestId: crypto.randomUUID() }
        await run({ payload: { input: runRequest.current } })
        runRequest.current = null
      } else await prepare({ payload: { input: { routineId: record.id } } })
      setMessage(kind === 'run' ? (chinese ? '执行请求已提交，等待调度。' : 'Execution queued. Waiting for scheduling.')
        : (chinese ? '任务已准备，可提交执行。' : 'Task prepared. Ready to submit.'))
      refresh()
    } catch {
      setMessage(chinese ? '执行未确认，请重试。' : 'Execution was not confirmed. Retry.')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      await save({
        payload: {
          input: {
            id: record.id,
            expectedRevision: record.revision,
            name: record.name,
            prompt: record.prompt,
            agent: record.agent,
            model: record.model,
            skillIds: record.skillIds,
            integrationIds: record.integrationIds,
            resourceIds: record.resourceIds ?? [],
            intervalMinutes: record.intervalMinutes,
            timeZone: record.timeZone,
            enabled: !record.enabled
          }
        }
      })
      refresh()
    } catch {
      setMessage(chinese ? '状态更新未确认，请重试。' : 'The status change was not confirmed. Retry.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-5" aria-labelledby="routine-detail-title">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <Button variant="ghost" size="sm" className="-ml-2 shrink-0" onClick={onBack} aria-label={chinese ? '返回 Routine 仪表盘' : 'Back to Routine dashboard'}>
            <ArrowLeftIcon aria-hidden="true" />
            {chinese ? '返回' : 'Back'}
          </Button>
          <div className="min-w-0">
            <h2 id="routine-detail-title" className="truncate text-xl leading-7 font-semibold">
              {record.name}
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>
            {chinese ? '编辑' : 'Edit'}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggle()}>
            {record.enabled ? (chinese ? '暂停' : 'Pause') : chinese ? '启用' : 'Enable'}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void invoke('prepare')}>
            {chinese ? '准备任务' : 'Prepare task'}
          </Button>
          <Button size="sm" disabled={busy || !record.enabled} onClick={() => void invoke('run')}>
            <PlayIcon aria-hidden="true" />
            {chinese ? '运行一次' : 'Run once'}
          </Button>
        </div>
      </header>
      {message ? (
        <p role="status" className="text-support text-muted-foreground">
          {message}
        </p>
      ) : null}

      <div className="grid overflow-hidden rounded-lg border bg-card lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="border-b bg-muted/20 lg:border-r lg:border-b-0" aria-label={chinese ? 'Routine 详情和日期' : 'Routine details and dates'}>
          <div className="space-y-4 border-b p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-support text-muted-foreground">{chinese ? '状态' : 'Status'}</span>
              <Badge variant={record.enabled ? 'success' : 'outline'}>{record.enabled ? (chinese ? '运行中' : 'Active') : chinese ? '已暂停' : 'Paused'}</Badge>
            </div>
            <DetailItem label={chinese ? '执行频率' : 'Frequency'} value={`${record.intervalMinutes} ${chinese ? '分钟' : 'minutes'}`} />
            <DetailItem label={chinese ? '时区' : 'Time zone'} value={record.timeZone} />
            <DetailItem label="Agent" value={record.agent} />
            {record.model ? <DetailItem label={chinese ? '模型' : 'Model'} value={`${record.model.providerId} / ${record.model.modelId}`} /> : null}
            <DetailItem label={chinese ? '下一次执行' : 'Next run'} value={formatNextTrigger(record, chinese)} />
          </div>
          <div className="border-b p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-support font-medium">{chinese ? '任务说明' : 'Prompt'}</p>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={chinese ? '查看全部 Prompt' : 'View full prompt'}
                title={chinese ? '查看全部 Prompt' : 'View full prompt'}
                onClick={() => setPromptOpen(true)}
              >
                <Maximize2Icon aria-hidden="true" />
              </Button>
            </div>
            <p className="line-clamp-5 whitespace-pre-wrap break-words text-support text-muted-foreground">{record.prompt}</p>
          </div>
          <div className="p-2">
            <div className="flex items-center justify-between px-2 py-1.5">
              <p className="text-support font-medium">{chinese ? '执行日期' : 'Execution dates'}</p>
              <CalendarDaysIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </div>
            {executionsLoading ? (
              <p className="px-2 py-2 text-support text-muted-foreground">{chinese ? '加载中…' : 'Loading…'}</p>
            ) : dates.length === 0 ? (
              <p className="px-2 py-2 text-support text-muted-foreground">{chinese ? '暂无执行日期' : 'No execution dates'}</p>
            ) : (
              <ul className="space-y-0.5">
                {dates.map((date) => {
                  const dayRows = executions.filter((row) => row.routineDate === date)
                  const state = dayRows.length ? dateState(dayRows) : 'missing'
                  return (
                    <li key={date}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent ${activeDate === date ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''}`}
                        onClick={() => setSelectedDate(date)}
                        aria-current={activeDate === date ? 'date' : undefined}
                      >
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${state === 'success' ? 'bg-success' : state === 'attention' || state === 'missing' ? 'bg-warning' : 'bg-progress'}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-support">{formatDate(date, chinese)}</span>
                        <span className="shrink-0 text-support tabular-nums text-muted-foreground">{dayRows.length || '—'}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </aside>
        <main className="min-w-0 p-4 md:p-5">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b pb-4">
            <div>
              <p className="text-support text-muted-foreground">{chinese ? '选定日期' : 'Selected date'}</p>
              <h3 className="mt-1 text-base font-semibold">{activeDate ? formatDate(activeDate, chinese) : chinese ? '暂无执行记录' : 'No execution history'}</h3>
            </div>
            {activeDate && activeRows.length ? (
              <span className="text-support text-muted-foreground">
                {activeRows.length} {chinese ? '个执行窗口' : 'execution window(s)'}
              </span>
            ) : null}
          </div>
          {activeDate && activeRows.length ? (
            <ExecutionProcess rows={activeRows} timeZone={record.timeZone} chinese={chinese} />
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center">
              {activeDate ? (
                <CircleAlertIcon className="size-6 text-warning" aria-hidden="true" />
              ) : (
                <CalendarDaysIcon className="size-6 text-muted-foreground" aria-hidden="true" />
              )}
              <p className="mt-3 text-ui font-medium">
                {activeDate ? (chinese ? '这一天没有执行记录' : 'No execution was recorded for this date') : chinese ? '还没有执行历史' : 'No execution history yet'}
              </p>
              <p className="mt-1 max-w-sm text-support text-muted-foreground">
                {activeDate
                  ? chinese
                    ? '这可能是尚未触发的日期，或需要人工处理的间隔。'
                    : 'This date has not been triggered, or it needs manual handling.'
                  : chinese
                    ? '运行一次 Routine 后，执行过程会显示在这里。'
                    : 'Run the Routine once and its execution process will appear here.'}
              </p>
            </div>
          )}
        </main>
      </div>
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent className="h-[70vh] max-h-[calc(100dvh-2rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{chinese ? '完整任务说明' : 'Full prompt'}</DialogTitle>
            <DialogDescription>{record.name}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto rounded-md border bg-muted/20 p-3">
            <p className="whitespace-pre-wrap break-words text-support">{record.prompt}</p>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function DetailItem({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-support text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-support font-medium" title={value}>
        {value}
      </p>
    </div>
  )
}

function dateState(rows: readonly RoutineExecution[]): 'success' | 'progress' | 'attention' {
  if (rows.some((row) => row.status === 'failed' || row.status === 'interrupted' || row.status === 'cancelled')) return 'attention'
  if (rows.some((row) => row.status !== 'succeeded')) return 'progress'
  return 'success'
}

function ExecutionProcess({ rows, timeZone, chinese }: { rows: readonly RoutineExecution[]; timeZone: string; chinese: boolean }): React.JSX.Element {
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-4 before:left-3 before:top-4 before:w-px before:bg-border">
      {rows.map((row) => (
        <li key={row.id} className="relative pl-8">
          <span
            className={`absolute left-1.5 top-4 flex size-3 items-center justify-center rounded-full border-2 border-card ${row.status === 'succeeded' ? 'bg-success' : row.status === 'failed' || row.status === 'interrupted' ? 'bg-destructive' : 'bg-progress'}`}
            aria-hidden="true"
          />
          <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-ui font-semibold">{row.isEnd ? (chinese ? '日终收尾' : 'Day close') : chinese ? 'Routine 执行' : 'Routine execution'}</h4>
                  <Badge variant={statusVariant(row.status)}>{statusLabel(row.status, chinese)}</Badge>
                </div>
                <p className="mt-1 text-support text-muted-foreground">
                  {formatTime(row.triggerTime, timeZone, chinese)} · {row.triggerCount} {chinese ? '次触发合并' : 'trigger(s) coalesced'}
                </p>
              </div>
              {row.taskId ? (
                <span className="font-mono text-support text-muted-foreground" title={row.taskId}>
                  Task {row.taskId.slice(0, 8)}
                </span>
              ) : null}
            </div>
            <div className="mt-4 grid gap-3 border-t pt-3 sm:grid-cols-3">
              <ProcessStep icon={TimerIcon} label={chinese ? '首次触发' : 'First trigger'} value={formatTime(row.firstTriggerTime, timeZone, chinese)} />
              <ProcessStep
                icon={row.taskId ? CheckCircle2Icon : Clock3Icon}
                label={chinese ? '任务' : 'Task'}
                value={row.taskId ? (chinese ? '已关联' : 'Attached') : chinese ? '等待创建' : 'Waiting'}
              />
              <ProcessStep icon={row.endedAt ? CheckCircle2Icon : PlayIcon} label={chinese ? '结束时间' : 'Finished'} value={formatTime(row.endedAt, timeZone, chinese)} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ProcessStep({ icon: Icon, label, value }: { icon: typeof TimerIcon; label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-support text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-1 truncate text-support font-medium" title={value}>
        {value}
      </p>
    </div>
  )
}
