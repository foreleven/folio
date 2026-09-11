import { TaskConversation } from './TaskConversation'
import { TaskWikiChangesPanel } from './TaskWikiChangesPanel'
import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useRef, useState } from 'react'
import type { SessionRecord, TaskRecord } from '../../../shared/harness'
import type { OpenTaskSessionInput } from '../../../shared/rpc/task-rpc'
import { useLocale } from '../preferences'
import { modelCatalogAtom, modelsAtom } from '../rpc/model-rpc'
import { TaskRpcClient } from '../rpc/task-rpc'

/** Explicitly initializes/restores Sessions. No render, selection or retry sends a Prompt. */
export function TaskSessions({ vaultId, task }: { vaultId: string; task: TaskRecord }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('tasks.get', { vaultId, id: task.id })
  const detail = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const catalog = useAtomValue(modelCatalogAtom)
  const settings = useAtomValue(modelsAtom)
  const open = useAtomSet(TaskRpcClient.openSession, { mode: 'promise' })
  const close = useAtomSet(TaskRpcClient.closeSession, { mode: 'promise' })
  const [conversation, setConversation] = useState<string | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  const [modelKey, setModelKey] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const busy = useRef(false)
  const submitted = useRef<OpenTaskSessionInput | null>(null)
  const choices = catalog._tag === 'Success' && settings._tag === 'Success' && task.configuration.agent === 'pi'
    ? catalog.value.models.filter(model => model.source === 'builtin' && settings.value.configuredProviders?.includes(model.providerId)) : []
  const routine = detail._tag === 'Success' ? detail.value.routine : null
  const routineModel = routine?.snapshot.definition.model
  const routineModelKey = routineModel ? JSON.stringify([routineModel.providerId, routineModel.modelId]) : ''
  // A user selection (including clearing it) takes precedence over the immutable Routine default.
  const selectedModelKey = modelKey ?? routineModelKey
  const model = choices.find(entry => JSON.stringify([entry.providerId, entry.modelId]) === selectedModelKey)

  /** Keeps the exact request identity after a lost reply; a new choice is a separate Session. */
  async function initialize(session?: SessionRecord): Promise<void> {
    if (busy.current || (!session && task.configuration.agent === 'pi' && !model)) return
    const selection = !session && task.configuration.agent === 'pi' && model
      ? { providerId: model.providerId, modelId: model.modelId, thinkingLevel: selectedModelKey === routineModelKey && routineModel ? routineModel.thinkingLevel : 'off' as const } : undefined
    const previous = submitted.current
    const input: OpenTaskSessionInput = session
      ? { vaultId, taskId: task.id, sessionId: session.id, agent: session.agent }
      : previous && previous.agent === task.configuration.agent && JSON.stringify(previous.model) === JSON.stringify(selection)
        ? previous : { vaultId, taskId: task.id, sessionId: crypto.randomUUID(), agent: task.configuration.agent, ...(selection ? { model: selection } : {}) }
    submitted.current = input
    busy.current = true
    setPending(true)
    setMessage('')
    try {
      await open({ payload: input })
      submitted.current = null
      setConversation(input.sessionId)
      setMessage(chinese ? '会话已连接，尚未发送指令。' : 'Session connected. No prompt has been sent.')
    } catch {
      setMessage(chinese ? '无法连接会话。请检查 Provider、Agent 和所选集成；已有会话需先关闭连接，再重试。' : 'Could not connect. Check the Provider, Agent, and selected Integrations; close an existing connection before retrying.')
    } finally { busy.current = false; setPending(false); refresh() }
  }

  /** Explicit close releases the worker; durable messages and native Session identity remain. */
  async function disconnect(session: SessionRecord): Promise<void> {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      await close({ payload: { vaultId, taskId: task.id, sessionId: session.id } })
      setMessage(chinese ? '连接已关闭，会话已保留。' : 'Connection closed. Session retained.')
    } catch { setMessage(chinese ? '无法关闭连接，请重试。' : 'Could not close the connection. Retry.') }
    finally { busy.current = false; setPending(false); refresh() }
  }

  return <div className="space-y-3 border-t pt-3">
    {routine ? <p className="text-support text-muted-foreground">{chinese ? '来自 Routine：' : 'From Routine: '}{routine.snapshot.definition.name}</p> : null}
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1 text-ui"><span className="block">{chinese ? '会话 Agent' : 'Session Agent'}</span>
        <span className="inline-flex h-8 items-center rounded-md border px-2">{task.configuration.agent === 'pi' ? 'pi' : 'Codex'}</span>
      </div>
      {task.configuration.agent === 'pi' ? <label className="min-w-0 flex-1 space-y-1 text-ui"><span className="block">{chinese ? '模型' : 'Model'}</span>
        <select className="h-8 w-full rounded-md border bg-background px-2" disabled={pending} value={selectedModelKey}
          onChange={event => setModelKey(event.target.value)}>
          <option value="">{chinese ? '请选择模型' : 'Choose a model'}</option>
          {selectedModelKey && !model && routineModel && selectedModelKey === routineModelKey ? <option value={selectedModelKey}>
            {routineModel.providerId} / {routineModel.modelId} ({chinese ? '当前不可用' : 'currently unavailable'})
          </option> : null}
          {choices.map(entry => <option key={JSON.stringify([entry.providerId, entry.modelId])} value={JSON.stringify([entry.providerId, entry.modelId])}>
            {entry.providerName} / {entry.modelName}
          </option>)}
        </select>
      </label> : null}
      <Button disabled={pending || (task.configuration.agent === 'pi' && !model)} onClick={() => void initialize()}>{chinese ? '新建会话' : 'New session'}</Button>
    </div>
    {task.configuration.agent === 'pi' && choices.length === 0 ? <p className="text-support text-muted-foreground">{chinese ? '请先在 Agent 设置中配置 Provider。' : 'Configure a Provider in Agent settings first.'}</p> : null}
    {message ? <p role="status" className="text-support">{message}</p> : null}
    {detail._tag === 'Success' ? <ul className="space-y-2">{detail.value.sessions.map(session => <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 text-support">
      <span>{session.agent} · {session.modelProfile ? `${session.modelProfile.provider.providerId} / ${session.modelProfile.modelId}` : session.id}</span>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => setConversation(session.id)}>{chinese ? '查看对话' : 'Conversation'}</Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void initialize(session)}>{chinese ? '连接 / 重试' : 'Connect / retry'}</Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void disconnect(session)}>{chinese ? '关闭连接' : 'Close connection'}</Button>
      </div>
    </li>)}</ul> : <p className="text-support">{detail._tag === 'Failure'
      ? (chinese ? '无法读取会话。' : 'Could not load sessions.') : (chinese ? '正在加载会话…' : 'Loading sessions…')}</p>}
    {conversation ? <TaskConversation key={conversation} vaultId={vaultId} taskId={task.id} sessionId={conversation} /> : null}
    <Button variant="outline" size="sm" onClick={() => setShowChanges(current => !current)}>{showChanges ? (chinese ? '隐藏文件变更' : 'Hide file changes') : (chinese ? '查看文件变更' : 'View file changes')}</Button>
    {showChanges ? <TaskWikiChangesPanel vaultId={vaultId} taskId={task.id} /> : null}
  </div>
}
