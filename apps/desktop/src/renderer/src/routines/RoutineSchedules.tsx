import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { Schema } from 'effect'
import { useRef, useState } from 'react'
import type { RoutineRecord } from '../../../shared/routine'
import { DailyTime, VaultTimeZone, type DailyRoutineSchedule } from '../../../shared/routine-schedule'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'

const control = 'rounded-md border bg-background px-3 py-2 text-ui'

/** Opens explicit versioned editors; refreshing server state never replaces an in-progress draft. */
export function RoutineSchedules({ vaultId, routines }: { vaultId: string; routines: readonly RoutineRecord[] }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('routines.scheduleSettings', { vaultId })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const [editor, setEditor] = useState<{ kind: 'zone'; expected: string | null } | { kind: 'daily'; routine: RoutineRecord; schedule?: DailyRoutineSchedule } | null>(null)
  return <section className="space-y-3 rounded-lg border p-3" aria-label={chinese ? '每日计划' : 'Daily schedules'}>
    <div className="flex items-center justify-between gap-2"><h3 className="text-ui font-medium">{chinese ? '每日计划' : 'Daily schedules'}</h3>
      <Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新计划' : 'Refresh schedules'}</Button></div>
    <p className="text-support text-muted-foreground">{chinese ? '按 Vault 时区每天执行；关闭或休眠期间错过的日期会在恢复后合并补跑一次。' : 'Runs daily in the Vault timezone. Dates missed while closed or asleep are combined into one catch-up task on return.'}</p>
    {result._tag === 'Success' ? <>
      <div className="flex items-center gap-2 text-support"><span>{chinese ? 'Vault 时区：' : 'Vault timezone: '}{result.value.timeZone ?? (chinese ? '未设置' : 'Not set')}</span>
        <Button variant="outline" size="sm" disabled={editor !== null} onClick={() => setEditor({ kind: 'zone', expected: result.value.timeZone })}>{chinese ? '设置时区' : 'Set timezone'}</Button></div>
      <ul className="divide-y">{routines.map(routine => {
        const schedule = result.value.schedules.find(value => value.routineId === routine.id)
        return <li key={routine.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-support"><div><p>{routine.definition.name} · {schedule ? `${chinese ? '每天' : 'Daily'} ${schedule.time}` : (chinese ? '未设置每日计划' : 'No daily plan')}</p>
          {schedule && result.value.timeZone ? <p className="text-muted-foreground">{chinese ? '计划时间：' : 'Scheduled time: '}{new Date(schedule.nextAt).toLocaleString(chinese ? 'zh-CN' : 'en', { timeZone: result.value.timeZone })} · {result.value.timeZone}</p> : null}
          {!routine.definition.enabled ? <p className="text-muted-foreground">{chinese ? 'Routine 已暂停' : 'Routine is paused'}</p> : null}</div>
          <Button variant="ghost" size="sm" disabled={editor !== null || !result.value.timeZone} onClick={() => setEditor({ kind: 'daily', routine, schedule })}>{chinese ? '编辑每日时间' : 'Edit daily time'}</Button></li>
      })}</ul>
    </> : <p role="status">{result._tag === 'Failure' ? (chinese ? '无法加载计划，请刷新重试。' : 'Could not load schedules. Refresh to retry.') : (chinese ? '正在加载计划…' : 'Loading schedules…')}</p>}
    {editor ? <ScheduleEditor key={editor.kind} vaultId={vaultId} editor={editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); refresh() }} /> : null}
  </section>
}

/** Keeps the original CAS input after failure, including a lost reply, and blocks duplicate submit. */
function ScheduleEditor({ vaultId, editor, onClose, onSaved }: {
  vaultId: string; editor: { kind: 'zone'; expected: string | null } | { kind: 'daily'; routine: RoutineRecord; schedule?: DailyRoutineSchedule };
  onClose: () => void; onSaved: () => void
}): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const zone = useAtomSet(TaskRpcClient.setTimeZone, { mode: 'promise' })
  const save = useAtomSet(TaskRpcClient.saveSchedule, { mode: 'promise' })
  const remove = useAtomSet(TaskRpcClient.removeSchedule, { mode: 'promise' })
  const [value, setValue] = useState(editor.kind === 'zone' ? editor.expected ?? Intl.DateTimeFormat().resolvedOptions().timeZone : editor.schedule?.time ?? '09:00')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const busy = useRef(false)
  const valid = Schema.is(editor.kind === 'zone' ? VaultTimeZone : DailyTime)(value)
  /** Deletion only removes the plan; accepted triggers remain in occurrence history. */
  async function submit(deleting = false): Promise<void> {
    if (busy.current || (!deleting && !valid)) return
    busy.current = true; setPending(true); setFailed(false)
    try {
      if (editor.kind === 'zone') await zone({ payload: { vaultId, timeZone: value, expected: editor.expected } })
      else if (deleting && editor.schedule) await remove({ payload: { vaultId, routineId: editor.routine.id, revision: editor.schedule.revision } })
      else await save({ payload: { vaultId, input: { routineId: editor.routine.id, time: value, expectedRevision: editor.schedule?.revision ?? null } } })
      onSaved()
    } catch { setFailed(true) }
    finally { busy.current = false; setPending(false) }
  }
  return <form className="space-y-2 border-t pt-3" onSubmit={event => { event.preventDefault(); void submit() }}>
    <label className="flex flex-wrap items-center gap-2 text-ui"><span>{editor.kind === 'zone' ? (chinese ? '命名时区' : 'Named timezone') : (chinese ? '每日时间' : 'Daily time')}</span>
      <input className={control} type={editor.kind === 'zone' ? 'text' : 'time'} value={value} disabled={pending} onChange={event => setValue(event.target.value)} required /></label>
    {editor.kind === 'zone' ? <p className="text-support text-muted-foreground">{chinese ? '例如 Asia/Shanghai。修改时区会重新计算所有每日计划的下一次时间。' : 'For example, Asia/Shanghai. Changing timezone recalculates the next time for all daily plans.'}</p> : null}
    <div className="flex gap-2"><Button type="submit" size="sm" disabled={pending || !valid}>{chinese ? '保存计划设置' : 'Save schedule settings'}</Button>
      {editor.kind === 'daily' && editor.schedule ? <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void submit(true)}>{chinese ? '移除每日计划' : 'Remove daily plan'}</Button> : null}
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onClose}>{chinese ? '关闭计划编辑' : 'Close schedule editor'}</Button></div>
    {failed ? <p role="alert" className="text-support text-destructive">{chinese ? '保存未确认，输入已保留。可重试；若版本已变化，关闭编辑并刷新后重开。' : 'Save was not confirmed. Input is retained. Retry, or close and refresh before reopening if the version changed.'}</p> : null}
  </form>
}
