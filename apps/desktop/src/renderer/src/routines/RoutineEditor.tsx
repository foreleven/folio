import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@folio/ui/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@folio/ui/components/ui/field'
import { Input } from '@folio/ui/components/ui/input'
import { useRef, useState } from 'react'
import type { RoutineDefinition, RoutineRecord } from '../../../shared/routine'
import { HarnessStoreError } from '../../../shared/harness'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { IntegrationRpcClient } from '../rpc/integration-rpc'
import { modelCatalogAtom, modelsAtom } from '../rpc/model-rpc'

const selectControl =
  'block h-7 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-ui outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

/** Edits an explicit version snapshot; background query refreshes never replace a local draft. */
export function RoutineEditor({
  vaultId,
  initial,
  onSaved,
  onCancel
}: {
  vaultId: string
  initial: { id: string; record?: RoutineRecord }
  onSaved: () => void
  onCancel: () => void
}): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const integrations = useAtomValue(IntegrationRpcClient.integrations)
  const catalog = useAtomValue(modelCatalogAtom)
  const settings = useAtomValue(modelsAtom)
  const [draft, setDraft] = useState<RoutineDefinition>(
    () =>
      initial.record?.definition ?? {
        name: '',
        prompt: '',
        configuration: { agent: 'pi', skillIds: [], integrationIds: [] },
        model: null,
        enabled: true
      }
  )
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<'conflict' | 'unconfirmed' | null>(null)
  const busy = useRef(false)
  const choices =
    catalog._tag === 'Success' && settings._tag === 'Success'
      ? catalog.value.models.filter((model) => model.source === 'builtin' && settings.value.configuredProviders?.includes(model.providerId))
      : []
  const modelKey = draft.model ? JSON.stringify([draft.model.providerId, draft.model.modelId]) : ''
  const knownModel = choices.some((model) => JSON.stringify([model.providerId, model.modelId]) === modelKey)
  const knownIntegrations = integrations._tag === 'Success' ? integrations.value : []

  /** Keep the same identity and expected version after an uncertain response; main rejects stale overwrites. */
  async function submit(): Promise<void> {
    if (busy.current || !draft.name.trim() || !draft.prompt.trim() || (draft.configuration.agent === 'pi' && !draft.model)) return
    busy.current = true
    setPending(true)
    setFailed(null)
    try {
      await save({
        payload: {
          vaultId,
          input: { id: initial.id, expectedRevision: initial.record?.revision ?? null, definition: { ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() } }
        }
      })
      onSaved()
    } catch (error) {
      setFailed(error instanceof HarnessStoreError && error.reason === 'routine-conflict' ? 'conflict' : 'unconfirmed')
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <Card>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <CardHeader className="border-b">
          <CardTitle>{initial.record ? (chinese ? '编辑 Routine' : 'Edit Routine') : chinese ? '新建 Routine' : 'New Routine'}</CardTitle>
          <CardDescription>{chinese ? '保存一组可复用的提示词和 Agent 配置。' : 'Save reusable instructions and Agent configuration.'}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <fieldset disabled={pending}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="routine-name">{chinese ? 'Routine 名称' : 'Routine name'}</FieldLabel>
                <Input id="routine-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="routine-prompt">Prompt</FieldLabel>
                <textarea
                  id="routine-prompt"
                  className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-ui outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                  value={draft.prompt}
                  required
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                />
                <FieldDescription>{chinese ? '这段指令会在每次运行时发送给 Agent。' : 'These instructions are sent to the Agent each time it runs.'}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="routine-agent">Agent</FieldLabel>
                <select
                  id="routine-agent"
                  className={selectControl}
                  value={draft.configuration.agent}
                  onChange={(event) => {
                    const agent = event.target.value === 'codex' ? 'codex' : 'pi'
                    setDraft({ ...draft, configuration: { ...draft.configuration, agent }, model: agent === 'codex' ? null : draft.model })
                  }}
                >
                  <option value="pi">pi</option>
                  <option value="codex">Codex</option>
                </select>
              </Field>
              {draft.configuration.agent === 'pi' ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="routine-model">{chinese ? '模型' : 'Model'}</FieldLabel>
                    <select
                      id="routine-model"
                      className={selectControl}
                      value={modelKey}
                      onChange={(event) => {
                        const selected = choices.find((model) => JSON.stringify([model.providerId, model.modelId]) === event.target.value)
                        setDraft({ ...draft, model: selected ? { providerId: selected.providerId, modelId: selected.modelId, thinkingLevel: 'off' } : null })
                      }}
                    >
                      <option value="">{chinese ? '请选择模型' : 'Choose a model'}</option>
                      {modelKey && !knownModel ? (
                        <option value={modelKey}>
                          {draft.model!.providerId} / {draft.model!.modelId} ({chinese ? '当前不可用' : 'currently unavailable'})
                        </option>
                      ) : null}
                      {choices.map((model) => (
                        <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>
                          {model.providerName} / {model.modelName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {draft.model ? (
                    <Field>
                      <FieldLabel htmlFor="routine-thinking">{chinese ? '思考强度' : 'Thinking level'}</FieldLabel>
                      <select
                        id="routine-thinking"
                        className={selectControl}
                        value={draft.model.thinkingLevel}
                        onChange={(event) => {
                          const level = levels.find((level) => level === event.target.value)
                          if (level && draft.model) setDraft({ ...draft, model: { ...draft.model, thinkingLevel: level } })
                        }}
                      >
                        {levels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                </>
              ) : (
                <FieldDescription>{chinese ? '使用本机 Codex 的模型配置。' : 'Uses the local Codex model configuration.'}</FieldDescription>
              )}
              <fieldset className="flex flex-col gap-2">
                <legend className="text-ui font-medium">{chinese ? '集成' : 'Integrations'}</legend>
                {[
                  ...knownIntegrations.map((item) => ({ id: item.id, name: item.name })),
                  ...draft.configuration.integrationIds.filter((id) => !knownIntegrations.some((item) => item.id === id)).map((id) => ({ id, name: id }))
                ].map((item) => (
                  <label key={item.id} className="flex items-center gap-2 text-support">
                    <input
                      type="checkbox"
                      checked={draft.configuration.integrationIds.includes(item.id)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          configuration: {
                            ...draft.configuration,
                            integrationIds: event.target.checked
                              ? [...draft.configuration.integrationIds, item.id].sort()
                              : draft.configuration.integrationIds.filter((id) => id !== item.id)
                          }
                        })
                      }
                    />
                    {item.name}
                  </label>
                ))}
                {integrations._tag === 'Failure' ? (
                  <p role="alert" className="text-support text-destructive">
                    {chinese ? '集成列表加载失败，已选集成仍会保留。' : 'Could not load integrations. Saved selections are retained.'}
                  </p>
                ) : null}
              </fieldset>
              <label className="flex items-center gap-2 text-ui">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                {chinese ? '启用 Routine' : 'Enable Routine'}
              </label>
            </FieldGroup>
          </fieldset>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending || !draft.name.trim() || !draft.prompt.trim() || (draft.configuration.agent === 'pi' && !draft.model)}>
            {pending ? (chinese ? '保存中…' : 'Saving…') : chinese ? '保存 Routine' : 'Save Routine'}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            {chinese ? '关闭编辑' : 'Close editor'}
          </Button>
        </CardFooter>
        {failed ? (
          <p role="alert" className="px-4 pb-4 text-support text-destructive">
            {failed === 'conflict'
              ? chinese
                ? '同步冲突解决前无法启用。草稿已保留；可取消勾选“启用 Routine”后保存。'
                : 'Resolve synchronization conflicts before enabling. Your draft is retained; uncheck Enable Routine to save it while paused.'
              : chinese
                ? '保存未确认，草稿已保留。可重试；若版本已变化，刷新列表后重新打开该 Routine。'
                : 'Save was not confirmed. Your draft is retained. Retry, or refresh the list and reopen the Routine if its version changed.'}
          </p>
        ) : null}
      </form>
    </Card>
  )
}

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
