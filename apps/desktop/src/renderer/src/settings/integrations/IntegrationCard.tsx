import { useLayoutEffect, useRef, useState } from 'react'
import { integrationText, type IntegrationActionDefinition } from '@folio/integrations/protocol'
import { Button } from '@folio/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@folio/ui/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@folio/ui/components/ui/dropdown-menu'
import { ExternalLinkIcon, MoreHorizontalIcon } from 'lucide-react'
import type { IntegrationView } from '../../../../shared/integration'
import { IntegrationActionForm } from './IntegrationActionForm'
import { integrationMessages } from './messages'

type Props = {
  integration: IntegrationView
  locale: 'en' | 'zh-CN'
  pending: boolean
  error: boolean
  onInstall: () => void
  onInspect: () => void
  onAction: (id: string, payload?: unknown) => Promise<void>
}

/** Renders only generic presentation/action contracts; provider identifiers never select UI behavior. */
export function IntegrationCard({ integration, locale, pending, error, onInstall, onInspect, onAction }: Props): React.JSX.Element {
  const moreRef = useRef<HTMLButtonElement>(null)
  const focusedRef = useRef<HTMLElement | null>(null)
  const [dialog, setDialog] = useState<'details' | IntegrationActionDefinition | null>(null)
  const text = integrationMessages[locale]
  const { record, busy } = integration
  const failed = error || !!record?.error
  const status = record ? integration.states[record.state] : undefined
  const label = failed ? text.unknown : !record ? text.notInstalled : status ? integrationText(status.label, locale)
    : record.state === 'checking' ? text.checking : busy ? text.working : text.unknown
  const available = (record?.actions ?? []).flatMap((action) => {
    const definition = integration.actions.find((item) => item.id === action.id)
    return definition ? [{ ...definition, ...action }] : []
  })
  const primary = available.find((action) => action.primary)
  const secondary = available.filter((action) => action.id !== primary?.id)
  const form = dialog && dialog !== 'details' ? dialog : null
  const statusColor = failed ? 'text-destructive' : status?.kind === 'ready' ? 'text-success'
    : status?.kind === 'working' || status?.kind === 'waiting' ? 'text-progress'
      : status?.kind === 'attention' ? 'text-warning' : 'text-muted-foreground'

  // A completed operation can remove its button; keep keyboard position on the provider row.
  useLayoutEffect(() => {
    if (focusedRef.current && !focusedRef.current.isConnected && document.activeElement === document.body) moreRef.current?.focus()
  })

  /** Forms collect inputs locally; non-form actions are acknowledged by the host and reported on the card. */
  function invoke(action: typeof available[number]): void {
    if (action.type === 'callback' && action.fields?.length) setDialog(action)
    else void onAction(action.id).catch(() => undefined)
  }

  return (
    <article aria-label={integration.name} className="@container/integration min-w-0 rounded-md transition-colors hover:bg-muted/35 focus-within:bg-muted/35"
      onFocusCapture={(event) => { focusedRef.current = event.target }}
      onBlurCapture={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusedRef.current = null }}>
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2">
        <img src={integration.logo} alt={`${integration.name} logo`} className="size-6 shrink-0 object-contain" />
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <h3 className="text-ui font-semibold wrap-anywhere">{integration.name}</h3>
            <span role="status" className={`inline-flex items-center gap-1 text-support ${statusColor}`}>
              <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{label}
            </span>
          </div>
          <p className="text-support text-muted-foreground wrap-anywhere">{integrationText(integration.description, locale)}</p>
        </div>
        <div className="ml-auto flex w-full items-center justify-end gap-1 @min-[560px]/integration:w-auto">
          {!record ? <Button focusableWhenDisabled onClick={onInstall} disabled={pending}>{text.install}</Button>
            : primary ? <Button focusableWhenDisabled onClick={() => invoke(primary)} disabled={pending || (busy && primary.type === 'callback')}
              className="h-auto min-h-7 max-w-full whitespace-normal wrap-anywhere">
              {integrationText(primary.label, locale)}{primary.type === 'open-url' ? <ExternalLinkIcon /> : null}
            </Button> : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button ref={moreRef} variant="ghost" size="icon" aria-label={`${text.more} · ${integration.name}`} />}><MoreHorizontalIcon /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuGroup>
                {secondary.map((action) => <DropdownMenuItem key={action.id} disabled={pending || (busy && action.type === 'callback')} onClick={() => invoke(action)}>
                  {integrationText(action.label, locale)}{action.type === 'open-url' ? <ExternalLinkIcon /> : null}
                </DropdownMenuItem>)}
                {record ? <DropdownMenuItem disabled={busy || pending} onClick={onInspect}>{text.inspect}</DropdownMenuItem> : null}
                <DropdownMenuItem onClick={() => setDialog('details')}>{text.details}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {failed || status?.description ? <div className="mx-2 mb-2 rounded-sm bg-muted/55 py-2 pr-2 pl-9">
        <p role={failed ? 'alert' : undefined} className={failed ? 'text-support text-destructive wrap-anywhere' : 'text-support text-muted-foreground wrap-anywhere'}>
          {failed ? text.failed : status?.description ? integrationText(status.description, locale) : null}
        </p>
      </div> : null}
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        {dialog ? <DialogContent showCloseButton={!form} finalFocus={moreRef} closeLabel={text.close} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader className={form ? undefined : 'pr-8'}>
            <div className="flex min-w-0 items-center gap-1.5">
              <DialogTitle className="min-w-0 wrap-anywhere">{form ? integrationText(form.label, locale) : integration.name}</DialogTitle>
              {!form ? <a href={integration.homepage} target="_blank" rel="noreferrer" aria-label={`${text.openHomepage} · ${integration.name}`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ExternalLinkIcon className="size-3.5" />
              </a> : null}
            </div>
            <DialogDescription>{form?.description ? integrationText(form.description, locale) : integrationText(integration.description, locale)}</DialogDescription>
          </DialogHeader>
          {form ? <IntegrationActionForm key={form.id} action={form} locale={locale}
            available={available.some((action) => action.id === form.id && action.type === 'callback')}
            onSubmit={(payload) => onAction(form.id, payload)} onClose={() => setDialog(null)} /> : <>
            {record ? <p className="text-support text-muted-foreground">{text.scope}</p> : null}
            <div className="flex flex-col gap-2">
              <h4 className="text-ui font-medium">{text.resources}</h4>
              <ul className="space-y-0.5 text-support">{integration.resources.map((resource) => <li className="rounded-sm bg-muted/45 px-2 py-1.5" key={resource.id}>{integrationText(resource.name, locale)}</li>)}</ul>
            </div>
          </>}
        </DialogContent> : null}
      </Dialog>
    </article>
  )
}
