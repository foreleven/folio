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
import { BlocksIcon, BotIcon, FolderIcon, Settings2Icon } from 'lucide-react'
import { useLocale } from '../preferences'
import { settingsMessages } from './messages'

export type SettingsPage = 'general' | 'vaults' | 'models' | 'integrations'

/** Navigates settings sections without changing the independent window's entry route. */
export function SettingsSidebar({ page, onPageChange }: { page: SettingsPage; onPageChange: (page: SettingsPage) => void }): React.JSX.Element {
  const text = settingsMessages[useLocale()]

  const itemClassName = 'px-2 mb-0.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground'

  return (
    <Sidebar collapsible="none" className="w-36 shrink-0 border-r border-sidebar-border/70 min-[640px]:w-44">
      <SidebarHeader className="min-h-16 justify-end px-3 pb-3 pt-8 [-webkit-app-region:drag]">
        <h1 className="text-sm leading-5 font-semibold tracking-[-0.01em]">{text.title}</h1>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label={text.title} className="px-1 pb-3">
        <SidebarGroup className="p-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={page === 'general'}
                  className={itemClassName}
                  aria-current={page === 'general' ? 'page' : undefined}
                  onClick={() => onPageChange('general')}
                >
                  <Settings2Icon aria-hidden="true" />
                  <span>{text.general}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={page === 'vaults'}
                  className={itemClassName}
                  aria-current={page === 'vaults' ? 'page' : undefined}
                  onClick={() => onPageChange('vaults')}
                >
                  <FolderIcon aria-hidden="true" />
                  <span>{text.vaults}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className={itemClassName}
                  isActive={page === 'integrations'}
                  aria-current={page === 'integrations' ? 'page' : undefined}
                  onClick={() => onPageChange('integrations')}
                >
                  <BlocksIcon aria-hidden="true" />
                  <span>{text.integrations}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="p-1 pt-3">
          <SidebarGroupLabel className="h-6 px-2 text-[11px] font-medium text-muted-foreground/80">{text.agent}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={page === 'models'}
                  className={itemClassName}
                  aria-current={page === 'models' ? 'page' : undefined}
                  onClick={() => onPageChange('models')}
                >
                  <BotIcon aria-hidden="true" />
                  <span>{text.models}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
