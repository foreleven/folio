import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@folio/ui/components/ui/button'
import type { IntegrationView } from '../../../../shared/integration'
import { integrationMessages } from './messages'

type Props = {
  integration: IntegrationView
  locale: 'en' | 'zh-CN'
  pending: boolean
  error: boolean
  onInstall: () => void
  onCheck: () => void
  onAction: (id: string) => void
  onOpenAuthorization: () => void
}

/** Presents checked actions in a compact row; authorization and failures keep details visible. */
export function IntegrationCard({ integration, locale, pending, error, onInstall, onCheck, onAction, onOpenAuthorization }: Props): React.JSX.Element {
  const rowRef = useRef<HTMLElement>(null)
  const detailsRef = useRef<HTMLButtonElement>(null)
  const focusedRef = useRef<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const text = integrationMessages[locale]
  const isLark = integration.id === 'lark'
  const { record, busy } = integration
  const state = record?.state ?? 'not_installed'
  const ready = state === 'ready' && !record?.error
  const waiting = isLark && busy && (state === 'waiting_for_app' || state === 'waiting_for_user')
  const status = record?.error ? text.unknown : state === 'checking' ? text.checking : text.states[state as keyof typeof text.states] ?? text.unknown
  const available = integration.actions.filter((action) => record?.actionIds.includes(action.id))
  const stage = ready ? 3 : ['login_required', 'authorizing', 'waiting_for_user', 'refreshing_auth'].includes(state) ? 2
    : ['app_required', 'creating_app', 'waiting_for_app', 'app_authorization_required', 'verifying_app'].includes(state) ? 1 : 0

  const attention = waiting || error || !!record?.error
  const showDetails = expanded || attention

  // A checked action can disappear after completion; retain keyboard position in its row.
  useLayoutEffect(() => {
    if (focusedRef.current && !focusedRef.current.isConnected && document.activeElement === document.body) {
      detailsRef.current?.focus()
    }
  })

  return (
    <article ref={rowRef} onFocusCapture={(event) => { focusedRef.current = event.target }} onBlurCapture={(event) => {
      if (event.relatedTarget && !rowRef.current?.contains(event.relatedTarget)) focusedRef.current = null
    }} aria-label={integration.name} className="@container/integration min-w-0 bg-background">
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2">
        <img src={integration.logo} alt={`${integration.name} logo`} className="size-6 shrink-0 object-contain" />
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <h3 className="min-w-0 text-ui font-semibold wrap-anywhere"><a href={integration.homepage} target="_blank" rel="noreferrer" className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring">{integration.name}</a></h3>
            <span role="status" className={`inline-flex items-center gap-1 text-support leading-5 ${ready ? 'text-success' : busy ? 'text-progress' : 'text-muted-foreground'}`}>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />{status}
            </span>
          </div>
          <p className="text-support text-muted-foreground wrap-anywhere">{integration.description}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 @min-[560px]/integration:w-auto">
          {!record ? <Button focusableWhenDisabled onClick={onInstall} disabled={pending} className="h-auto min-h-7 max-w-full whitespace-normal wrap-anywhere">{text.install} {integration.name}</Button> : (
            <>
              <Button focusableWhenDisabled variant="outline" onClick={onCheck} disabled={busy || pending}>{text.check}</Button>
              {!busy ? available.map((action, index) => (
                <Button focusableWhenDisabled key={action.id} variant={index === 0 ? 'default' : 'outline'} disabled={pending} className="h-auto min-h-7 max-w-full whitespace-normal wrap-anywhere text-left" onClick={() => onAction(action.id)}>
                  {isLark ? text.actions[action.id as keyof typeof text.actions] ?? action.label : action.label}
                </Button>
              )) : null}
            </>
          )}
          <Button ref={detailsRef} variant="ghost" aria-expanded={showDetails} aria-controls={detailsId} onClick={() => { if (!attention) setExpanded(!showDetails) }} aria-disabled={attention}>
            {locale === 'en' ? 'Details' : '详情'}<span aria-hidden="true">{showDetails ? '⌃' : '⌄'}</span>
          </Button>
        </div>
      </div>
      {!record || state === 'install_required' ? <p className="px-2 pb-2 text-support text-muted-foreground">{isLark ? text.larkInstallHint : text.installHint}</p> : null}
      <div id={detailsId} hidden={!showDetails} className="space-y-3 border-t bg-muted/30 p-3">
        {record ? <p className="text-support text-muted-foreground">{text.scope}</p> : null}
        <div className="flex flex-wrap gap-2 text-support text-muted-foreground wrap-anywhere" aria-label={locale === 'en' ? 'Resources' : '资源'}>
          {integration.resources.map((resource) => <span key={resource.id}>{isLark && resource.id === 'im' ? text.im : isLark && resource.id === 'email' ? text.email : resource.name}</span>)}
        </div>
        {isLark && record && !ready ? (
          <ol aria-label={locale === 'en' ? 'Setup progress' : '安装进度'} className="flex flex-wrap gap-3">
            {[text.tools, text.app, text.account].map((label, index) => (
              <li key={label} aria-current={index === stage ? 'step' : undefined} className={`flex items-center gap-1 text-support ${index <= stage ? 'text-foreground' : 'text-muted-foreground'}`}>
                <span aria-hidden="true">{index < stage ? '✓' : `${index + 1}.`}</span>{label}
              </li>
            ))}
          </ol>
        ) : null}
        {error || record?.error ? <p role="alert" className="text-support text-destructive wrap-anywhere">{text.failed}</p> : null}
        {waiting ? (
          <div className="space-y-2 text-progress">
            <p className="text-support">{text.waiting}</p>
            <Button focusableWhenDisabled onClick={onOpenAuthorization} disabled={pending} className="h-auto min-h-7 max-w-full whitespace-normal wrap-anywhere">{text.open}<span aria-hidden="true">↗</span></Button>
          </div>
        ) : record && !ready ? <p className="text-support text-muted-foreground">{busy ? text.working : text.intro}</p> : null}
      </div>
    </article>
  )
}
