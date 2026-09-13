import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from '@folio/ui/components/ui/sidebar'
import { GitBranchIcon, LayoutDashboardIcon, ListTodoIcon, WorkflowIcon } from 'lucide-react'
import { WorkspaceFooter } from './WorkspaceFooter'
import { WindowLayout } from './WindowLayout'
import { Vault } from '../../../../shared/vault'
import { WorkspaceHeader } from './WorkspaceHeader'

export type WorkspaceSection = 'overview' | 'changes' | 'routines' | 'tasks'

const sectionIcons = {
  overview: LayoutDashboardIcon,
  changes: GitBranchIcon,
  routines: WorkflowIcon,
  tasks: ListTodoIcon
} as const

/** Owns the vault window chrome so workspace pages only provide their content. */
export function VaultWorkspaceLayout({
  chinese,
  vault,
  section,
  onSectionChange,
  children
}: {
  chinese: boolean
  vault: Vault
  section: WorkspaceSection
  onSectionChange: (section: WorkspaceSection) => void
  children: React.ReactNode
}): React.JSX.Element {
  const sections: { id: WorkspaceSection; label: string }[] = [
    { id: 'overview', label: chinese ? '概览' : 'Overview' },
    { id: 'changes', label: chinese ? '文件变更' : 'File changes' },
    { id: 'routines', label: 'Routines' },
    { id: 'tasks', label: chinese ? '任务' : 'Tasks' }
  ]
  const active = sections.find((item) => item.id === section) ?? sections[0]!

  return (
    <WindowLayout footer={<WorkspaceFooter chinese={chinese} sectionLabel={active.label} vault={vault} />}>
      <SidebarProvider defaultOpen={false} className="h-full min-h-0! flex-col" style={{ '--sidebar-width': '220px' } as React.CSSProperties}>
        <WorkspaceHeader label={active.label} />
        <div className="flex min-h-0 flex-1">
          {/* Sidebar is fixed by shadcn on desktop, so stop it above the external h-7 footer. */}
          <Sidebar collapsible="icon" className="mt-9 border-sidebar-border/70 md:bottom-7! md:h-auto! group-data-[state=collapsed]:mt-9">
            <SidebarContent>
              <SidebarGroup className="p-2">
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sections.map((item) => {
                      const Icon = sectionIcons[item.id]
                      return (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={section === item.id}
                            tooltip={item.label}
                            aria-current={section === item.id ? 'page' : undefined}
                            onClick={() => onSectionChange(item.id)}
                          >
                            <Icon aria-hidden="true" />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-labelledby="workspace-page-title">
              <div className={`w-full px-6 py-6 max-[600px]:px-4 ${section === 'routines' ? '' : 'mx-auto max-w-190'}`}>
                <h2 id="workspace-page-title" className="sr-only">
                  {active.label}
                </h2>
                {children}
              </div>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </WindowLayout>
  )
}
