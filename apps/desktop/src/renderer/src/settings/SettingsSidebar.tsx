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

export type SettingsPage = 'general' | 'models'

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
    <Sidebar collapsible="none" className="w-40 shrink-0 sm:w-52">
      <SidebarHeader className="px-4 py-6">
        <h1 className="text-base font-semibold">{text.title}</h1>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label={text.title}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={page === 'general'}
                  aria-current={page === 'general' ? 'page' : undefined}
                  onClick={() => onPageChange('general')}
                >
                  {text.general}
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
