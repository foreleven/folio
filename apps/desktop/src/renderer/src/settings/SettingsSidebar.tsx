import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@folio/ui/components/ui/sidebar'
import { useLocale } from '../preferences'
import { settingsMessages } from './messages'

export type SettingsPage = 'general' | 'models' | 'integrations'

/** Navigates settings sections without changing the independent window's entry route. */
export function SettingsSidebar({
  page,
  onPageChange
}: {
  page: SettingsPage
  onPageChange: (page: SettingsPage) => void
}): React.JSX.Element {
  const text = settingsMessages[useLocale()]

  return (
    <Sidebar collapsible="none" className="w-36 shrink-0 border-r min-[640px]:w-44">
      <SidebarHeader className="h-10 justify-center border-b px-4 py-0">
        <h1 className="flex items-center gap-2 text-sm leading-5 font-semibold"><span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />{text.title}</h1>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label={text.title}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={page === 'general'}
                  className="data-active:before:absolute data-active:before:inset-y-1.5 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-primary"
                  aria-current={page === 'general' ? 'page' : undefined}
                  onClick={() => onPageChange('general')}
                >
                  {text.general}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton className="data-active:before:absolute data-active:before:inset-y-1.5 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-primary" isActive={page === 'integrations'} aria-current={page === 'integrations' ? 'page' : undefined} onClick={() => onPageChange('integrations')}>
                  {text.integrations}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{text.agent}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={page === 'models'}
                  className="data-active:before:absolute data-active:before:inset-y-1.5 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-primary"
                  aria-current={page === 'models' ? 'page' : undefined}
                  onClick={() => onPageChange('models')}
                >
                  {text.models}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
