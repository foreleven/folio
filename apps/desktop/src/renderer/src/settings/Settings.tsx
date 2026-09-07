import { Separator } from '@folio/ui/components/ui/separator'
import { SidebarInset, SidebarProvider } from '@folio/ui/components/ui/sidebar'
import { useEffect, useState } from 'react'
import { useLocale } from '../preferences'
import { GeneralSettings } from './GeneralSettings'
import { ModelsSettings } from './ModelsSettings'
import { SettingsSidebar, type SettingsPage } from './SettingsSidebar'
import { settingsMessages } from './messages'

/** Settings window shell, owning section navigation and the localized window title. */
export function Settings(): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>('general')
  const text = settingsMessages[useLocale()]

  useEffect(() => { document.title = `${text.title} — Folio` }, [text.title])

  return (
    <SidebarProvider className="h-svh min-h-0">
      <SettingsSidebar page={page} onPageChange={setPage} />
      <SidebarInset aria-labelledby="settings-page-title" className="min-w-0 overflow-y-auto">
        <header className="flex flex-col gap-2 px-6 py-6 sm:px-8">
          <h2 id="settings-page-title" className="text-xl font-semibold tracking-tight">
            {page === 'general' ? text.general : text.models}
          </h2>
          {page === 'general' ? <p className="text-sm text-muted-foreground">{text.subtitle}</p> : null}
        </header>
        <Separator />
        <div className="w-full max-w-2xl p-6 sm:p-8">
          {page === 'general' ? <GeneralSettings /> : <ModelsSettings />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
