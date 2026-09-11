import { IntegrationsSettings } from './integrations/IntegrationsSettings'
import { SidebarInset, SidebarProvider } from '@folio/ui/components/ui/sidebar'
import { useEffect, useState } from 'react'
import { useLocale } from '../preferences'
import { GeneralSettings } from './GeneralSettings'
import { AgentSettings } from './AgentSettings'
import { VaultsSettings } from './VaultsSettings'
import { SettingsSidebar, type SettingsPage } from './SettingsSidebar'
import { settingsMessages } from './messages'

/** Settings window shell, owning section navigation and the localized window title. */
export function Settings(): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>('general')
  const locale = useLocale()
  const text = settingsMessages[locale]

  useEffect(() => {
    document.title = `${text.title} — Folio`
  }, [text.title])

  return (
    <SidebarProvider className="h-svh min-h-0">
      <SettingsSidebar page={page} onPageChange={setPage} />
      <SidebarInset aria-labelledby="settings-page-title" className="min-h-0 min-w-0 overflow-hidden bg-background">
        <header className="flex h-10 shrink-0 items-center px-5 [-webkit-app-region:drag]">
          <h2 id="settings-page-title" className="text-sm leading-5 font-semibold tracking-[-0.01em]">
            {page === 'general' ? text.general : page === 'vaults' ? text.vaults : page === 'integrations' ? text.integrations : text.models}
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-5">
          <div className="w-full max-w-220">
            {page === 'general' ? <GeneralSettings /> : page === 'vaults' ? <VaultsSettings /> : page === 'integrations' ? <IntegrationsSettings /> : <AgentSettings />}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
