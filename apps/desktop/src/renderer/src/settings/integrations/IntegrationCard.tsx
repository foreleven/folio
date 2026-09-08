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

/** A catalog card presents only actions offered by the latest main-process check. */
export function IntegrationCard({ integration, locale, pending, error, onInstall, onCheck, onAction, onOpenAuthorization }: Props): React.JSX.Element {
  const text = integrationMessages[locale]
  const { record, busy } = integration
  const state = record?.state ?? 'not_installed'
  const ready = state === 'ready' && !record?.error
  const waiting = busy && (state === 'waiting_for_app' || state === 'waiting_for_user')
  const status = state === 'checking' ? text.checking : text.states[state as keyof typeof text.states] ?? text.unknown
  const available = integration.actions.filter((action) => record?.actionIds.includes(action.id))
  const stage = ready ? 3 : ['login_required', 'authorizing', 'waiting_for_user', 'refreshing_auth'].includes(state) ? 2
    : ['app_required', 'creating_app', 'waiting_for_app', 'app_authorization_required', 'verifying_app'].includes(state) ? 1 : 0

  return (
    <article aria-label={integration.name} className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <svg viewBox="0 0 32 32" className="size-8" fill="none"><path d="M5 10h10l6 7H11z" fill="currentColor" opacity=".55"/><path d="m11 17 6 7L28 7H17l-6 10Z" fill="currentColor"/></svg>
            </div>
            <div><h3 className="text-base font-semibold">{integration.name}</h3><p className="mt-0.5 text-xs text-muted-foreground">{text.scope}</p></div>
          </div>
          <span role="status" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${ready ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
            <span aria-hidden="true" className={`size-1.5 rounded-full ${ready ? 'bg-emerald-500' : busy ? 'animate-pulse bg-sky-500' : 'bg-current'}`} />{status}
          </span>
        </div>
        <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">{text.description}</p>
        <div className="flex flex-wrap gap-2" aria-label={locale === 'en' ? 'Resources' : '资源'}>
          {integration.resources.map((resource) => (
            <span key={resource.id} className="rounded-md border bg-background px-2.5 py-1 text-xs text-muted-foreground">
              {resource.id === 'im' ? text.im : resource.id === 'email' ? text.email : resource.name}
            </span>
          ))}
        </div>
        {record && !ready ? (
          <ol aria-label={locale === 'en' ? 'Setup progress' : '安装进度'} className="grid grid-cols-3 gap-3 border-t pt-4">
            {[text.tools, text.app, text.account].map((label, index) => (
              <li key={label} aria-current={index === stage ? 'step' : undefined} className={`flex items-center gap-2 text-xs ${index <= stage ? 'text-foreground' : 'text-muted-foreground'}`}>
                <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] ${index < stage ? 'bg-primary text-primary-foreground' : 'border'}`}>{index < stage ? '✓' : index + 1}</span>{label}
              </li>
            ))}
          </ol>
        ) : null}
        {error || record?.error ? <p role="alert" className="text-sm text-destructive">{text.failed}</p> : null}
        {waiting ? (
          <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-4">
            <p className="mb-3 text-sm leading-relaxed">{text.waiting}</p>
            <Button onClick={onOpenAuthorization} disabled={pending} size="sm">{text.open}<span aria-hidden="true">↗</span></Button>
          </div>
        ) : null}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-5 py-4 sm:px-6">
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{ready ? text.readyHint : !record ? text.installHint : busy ? text.working : text.intro}</p>
        <div className="flex flex-wrap gap-2">
          {!record ? <Button onClick={onInstall} disabled={pending}>{text.install}</Button> : (
            <>
              <Button variant="outline" size="sm" onClick={onCheck} disabled={busy || pending}>{text.check}</Button>
              {!busy ? available.map((action, index) => (
                <Button key={action.id} variant={index === 0 ? 'default' : 'outline'} size="sm" disabled={pending} onClick={() => onAction(action.id)}>
                  {text.actions[action.id as keyof typeof text.actions] ?? action.label}
                </Button>
              )) : null}
            </>
          )}
        </div>
      </footer>
    </article>
  )
}
