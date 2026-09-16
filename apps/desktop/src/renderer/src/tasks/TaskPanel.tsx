import { TaskSessions } from './TaskSessions'
import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useRef, useState } from 'react'
import type { CreateTaskInput } from '../../../shared/rpc/task-rpc'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { IntegrationRpcClient } from '../rpc/integration-rpc'

/** Creates durable Task workspaces and exposes interrupted creation for explicit retry. Execution is a separate action. */
export function TaskPanel(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('tasks.list', {})
  const tasks = useAtomValue(query)
  const integrations = useAtomValue(IntegrationRpcClient.integrations)
  const refresh = useAtomRefresh(query)
  const create = useAtomSet(TaskRpcClient.create, { mode: 'promise' })
  const reopen = useAtomSet(TaskRpcClient.reopen, { mode: 'promise' })
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [agent, setAgent] = useState<'pi' | 'codex'>('pi')
  const [integrationIds, setIntegrationIds] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reopenFailure, setReopenFailure] = useState<string | null>(null)
  const [reopeningTask, setReopeningTask] = useState<string | null>(null)
  const inFlight = useRef(false)
  const submitted = useRef<CreateTaskInput | null>(null)

  /** Reuses identical intent after a lost response; main also checks the immutable snapshot. */
  async function submit(retry?: CreateTaskInput): Promise<void> {
    if (inFlight.current || (!retry && !goal.trim())) return
    const previous = submitted.current
    const input = retry ?? (previous?.goal === goal.trim() && previous.agent === agent
      && JSON.stringify(previous.integrationIds ?? []) === JSON.stringify(integrationIds) ? previous
      : { id: crypto.randomUUID(), goal: goal.trim(), agent, integrationIds })
    submitted.current = input
    inFlight.current = true
    setPending(true)
    setFailed(false)
    try {
      await create({ payload: input })
      submitted.current = null
      if (!retry) setGoal('')
    } catch { setFailed(true) }
    finally { inFlight.current = false; setPending(false); refresh() }
  }

  async function reopenTask(taskId: string): Promise<void> {
    if (reopeningTask) return
    setReopeningTask(taskId)
    setReopenFailure(null)
    try { await reopen({ payload: { taskId } }) }
    catch { setReopenFailure(taskId) }
    finally { setReopeningTask(null); refresh() }
  }

  return <section className="mt-8 space-y-4" aria-labelledby="tasks-title">
    <div className="flex items-center justify-between gap-3">
      <h2 id="tasks-title" className="text-sm font-semibold">{chinese ? '任务' : 'Tasks'}</h2>
      <Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新' : 'Refresh'}</Button>
    </div>
    <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label className="block space-y-1 text-ui">
        <span>{chinese ? '任务目标' : 'Task goal'}</span>
        <textarea className="block min-h-20 w-full rounded-md border bg-background px-3 py-2 focus-visible:outline-primary" value={goal}
          onChange={event => setGoal(event.target.value)} disabled={pending} required />
      </label>
      <div className="flex items-end justify-between gap-3">
        <label className="space-y-1 text-ui"><span className="block">Agent</span>
          <select className="h-8 rounded-md border bg-background px-2" value={agent} disabled={pending}
            onChange={event => setAgent(event.target.value === 'codex' ? 'codex' : 'pi')}>
            <option value="pi">pi</option><option value="codex">Codex</option>
          </select>
        </label>
        <Button type="submit" disabled={pending || !goal.trim()}>{pending ? (chinese ? '正在创建…' : 'Creating…') : (chinese ? '创建任务' : 'Create task')}</Button>
      </div>
      {integrations._tag === 'Success' && integrations.value.length > 0 ? <fieldset className="space-y-2" disabled={pending}>
        <legend className="text-ui">{chinese ? '集成' : 'Integrations'}</legend>
        {integrations.value.map(integration => {
          const available = !integration.busy && integration.record !== null
            && integration.states[integration.record.state]?.kind === 'ready'
          return <label key={integration.id} className="flex items-center gap-2 text-support">
            <input type="checkbox" disabled={!available && !integrationIds.includes(integration.id)} checked={integrationIds.includes(integration.id)}
              onChange={event => setIntegrationIds(current => event.target.checked
                ? [...current, integration.id].sort() : current.filter(id => id !== integration.id))} />
            {integration.name}{!available ? <span className="text-muted-foreground">{chinese ? '（请先在设置中连接）' : ' (Connect in Settings first)'}</span> : null}
          </label>
        })}
      </fieldset> : null}
      <p className="text-support text-muted-foreground">{chinese ? '创建任务会准备独立工作区。打开会话后可向 Agent 发送指令。' : 'Creating a task prepares its workspace. Open a session to send instructions to the Agent.'}</p>
      {failed ? <p role="alert" className="text-support text-destructive">{chinese ? '任务工作区未能就绪。已保存的任务会保留，可重试创建。' : 'Could not prepare the task workspace. Saved tasks are retained for retry.'}</p> : null}
    </form>
    {tasks._tag !== 'Success' ? <p role="status" className="text-support text-muted-foreground">{tasks._tag === 'Failure'
      ? (chinese ? '无法加载任务，请刷新重试。' : 'Could not load tasks. Refresh to retry.')
      : (chinese ? '正在加载任务…' : 'Loading tasks…')}</p>
      : tasks.value.length === 0 ? <p className="text-support text-muted-foreground">{chinese ? '还没有任务。' : 'No tasks yet.'}</p>
      : <ul className="divide-y rounded-lg border">{tasks.value.map(task => <li key={task.id} className="space-y-2 p-4">
        <p className="whitespace-pre-wrap break-words text-ui">{task.goal}</p>
        <div className="flex items-center justify-between gap-3 text-support text-muted-foreground">
          <span>{task.configuration.agent === 'pi' ? 'pi' : 'Codex'} · {task.state === 'completed'
            ? (chinese ? '已完成' : 'Completed') : task.worktreeState === 'ready'
              ? (chinese ? '工作区已就绪' : 'Workspace ready') : (chinese ? '工作区待准备' : 'Workspace pending')}</span>
          {task.state === 'active' && task.worktreeState === 'ready' ? <Button variant="outline" size="sm" onClick={() => setSelectedTask(selectedTask === task.id ? null : task.id)}>{chinese ? '会话' : 'Sessions'}</Button> : null}
          {task.state === 'active' && task.worktreeState !== 'ready' ? <Button variant="outline" size="sm" disabled={pending}
            onClick={() => void submit({ id: task.id, goal: task.goal, agent: task.configuration.agent,
              integrationIds: task.configuration.integrationIds })}>{chinese ? '重试' : 'Retry'}</Button> : null}
          {task.state === 'completed' && task.worktreeState === 'released' ? <Button variant="outline" size="sm" disabled={reopeningTask !== null}
            onClick={() => void reopenTask(task.id)}>{reopeningTask === task.id ? (chinese ? '正在重开…' : 'Reopening…') : (chinese ? '重开' : 'Reopen')}</Button> : null}
        </div>
        {reopenFailure === task.id ? <p role="alert" className="text-support text-destructive">{chinese ? '任务无法重开，原历史已保留。' : 'Could not reopen the task. Its history is retained.'}</p> : null}
        {selectedTask === task.id ? <TaskSessions key={task.id} task={task} /> : null}
      </li>)}</ul>}
  </section>
}
