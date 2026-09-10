import type { ModelProfile } from '@folio/agent/config/schema'
import { Badge } from '@folio/ui/components/ui/badge'
import { Button } from '@folio/ui/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@folio/ui/components/ui/card'
import type { ModelProfileView } from '../../../../shared/model'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'

export type ModelProfileAction = 'default' | 'credential' | 'test' | 'delete-credential' | 'delete-profile' | 'clear-default'

type Props = {
  view: ModelProfileView
  locale: ModelSettingsLocale
  isDefault: boolean
  pendingAction?: ModelProfileAction
  canEdit: boolean
  onEdit: (profile: ModelProfile) => void
  onAction: (action: ModelProfileAction, profile: ModelProfile) => void
}

/** Renders only committed, renderer-safe profile metadata and emits explicit actions. */
export function ModelProfileCard({ view, locale, isDefault, pendingAction, canEdit, onEdit, onAction }: Props): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  const { profile } = view
  const busy = pendingAction !== undefined
  const credential = profile.credentialSource === 'none'
    ? text.credentialNotRequired
    : view.credentialConfigured ? text.credentialReady : text.credentialMissing
  const status = view.connectionStatus === 'ready'
    ? text.statusReady
    : view.connectionStatus === 'unavailable' ? text.statusUnavailable : text.statusUntested
  return (
    <Card size="sm" aria-label={`${profile.name} · ${text.profileSummary}`}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{profile.name}</span>
          {isDefault ? <Badge variant="secondary">{text.default}</Badge> : null}
        </CardTitle>
        <CardDescription>{profile.provider.providerId} / {profile.modelId}</CardDescription>
        <CardAction className="flex gap-1">
          {canEdit ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onEdit(profile)}>{text.edit}</Button> : null}
          {isDefault ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('clear-default', profile)}>
              {pendingAction === 'clear-default' ? text.clearingDefault : text.clearDefault}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => onAction('default', profile)}>
              {pendingAction === 'default' ? text.settingDefault : text.setDefault}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2 text-support text-muted-foreground">
          <span>{text.thinking}: {profile.thinkingLevel}</span><span aria-hidden="true">·</span>
          <span>{credential}</span><span aria-hidden="true">·</span><span>{status}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {profile.credentialSource === 'managed' ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('credential', profile)}>
              {view.credentialConfigured ? text.replaceCredential : text.configureCredential}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('test', profile)}>
            {pendingAction === 'test' ? text.testingConnection : text.testConnection}
          </Button>
          {profile.credentialSource === 'managed' && view.credentialConfigured ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('delete-credential', profile)}>
              {pendingAction === 'delete-credential' ? text.deletingCredential : text.deleteCredential}
            </Button>
          ) : null}
          <Button variant="destructive" size="sm" disabled={busy || isDefault} onClick={() => onAction('delete-profile', profile)}>
            {pendingAction === 'delete-profile' ? text.deletingProfile : text.deleteProfile}
          </Button>
        </div>
        {isDefault ? <p className="text-support text-muted-foreground">{text.defaultDeleteBlocked}</p> : null}
      </CardContent>
    </Card>
  )
}
