import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar
} from '@folio/ui/components/ui/sidebar'
import { GitBranchIcon, LayoutDashboardIcon, ListTodoIcon, PanelLeftCloseIcon, WorkflowIcon } from 'lucide-react'
import { WorkspaceFooter } from './WorkspaceFooter'
import { WindowLayout } from './WindowLayout'
import { Vault } from '../../../../shared/vault'
import { WorkspaceHeader } from './WorkspaceHeader'

export type WorkspaceSection = 'wiki' | 'overview' | 'changes' | 'routines' | 'tasks'

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
  wikiNavigation,
  children
}: {
  chinese: boolean
  vault: Vault
  section: WorkspaceSection
  onSectionChange: (section: WorkspaceSection) => void
  wikiNavigation: (onSelect: () => void) => React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const sections: { id: Exclude<WorkspaceSection, 'wiki'>; label: string }[] = [
    { id: 'overview', label: chinese ? '概览' : 'Overview' },
    { id: 'changes', label: chinese ? '文件变更' : 'File changes' },
    { id: 'routines', label: 'Routines' },
    { id: 'tasks', label: chinese ? '任务' : 'Tasks' }
  ]
  const active = section === 'wiki' ? { label: 'Wiki' } : sections.find((item) => item.id === section)!

  return (
    <WindowLayout footer={<WorkspaceFooter chinese={chinese} sectionLabel={active.label} vault={vault} />}>
      <SidebarProvider defaultOpen className="h-full min-h-0! flex-col" style={{ '--sidebar-width': '248px' } as React.CSSProperties}>
        <WorkspaceHeader label={active.label} vaultName={vault.name} />
        <div className="flex min-h-0 flex-1">
          {/* Sidebar is fixed by shadcn on desktop, so stop it above the external h-7 footer. */}
          <Sidebar collapsible="offcanvas" className="border-sidebar-border/70 md:top-9! md:bottom-7! md:h-auto!">
            <WorkspaceNavigation sections={sections} section={section} onSectionChange={onSectionChange} wikiNavigation={wikiNavigation} chinese={chinese} vaultName={vault.name} />
          </Sidebar>
          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-labelledby="workspace-page-title">
              <div className={`w-full ${section === 'wiki' ? '' : `px-6 py-6 max-[600px]:px-4 ${section === 'routines' ? '' : 'mx-auto max-w-190'}`}`}>
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

/** Both navigation groups share the same scroll region and mobile drawer lifecycle. */
function WorkspaceNavigation({ sections, section, onSectionChange, wikiNavigation, chinese, vaultName }: {
  sections: { id: Exclude<WorkspaceSection, 'wiki'>; label: string }[]
  section: WorkspaceSection
  onSectionChange: (section: WorkspaceSection) => void
  wikiNavigation: (onSelect: () => void) => React.ReactNode
  chinese: boolean
  vaultName: string
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  return <>
    {isMobile && <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-2 pl-20">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{vaultName}</span>
      <button type="button" className="rounded p-1 hover:bg-sidebar-accent" aria-label={chinese ? '收起导航' : 'Close navigation'} onClick={() => setOpenMobile(false)}><PanelLeftCloseIcon className="size-4" /></button>
    </div>}
    <SidebarContent className="gap-0">
    <SidebarGroup className="p-2">
      <SidebarGroupContent>
        <nav aria-label={chinese ? '工作区导航' : 'Workspace navigation'}>
          <SidebarMenu>
            {sections.map(item => {
              const Icon = sectionIcons[item.id]
              return <SidebarMenuItem key={item.id}>
                <SidebarMenuButton className="h-8 rounded-md text-sm" isActive={section === item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => { onSectionChange(item.id); setOpenMobile(false) }}>
                  <Icon aria-hidden="true" /><span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            })}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
    {wikiNavigation(() => setOpenMobile(false))}
  </SidebarContent>
  </>
}
