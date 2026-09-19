import { SidebarTrigger, useSidebar } from '@folio/ui/components/ui/sidebar'

/** Aligns the native titlebar with the shared sidebar; reserves space for macOS window controls. */
export const WorkspaceHeader = ({ label, vaultName }: { label: string; vaultName?: string }) => {
  const { state, isMobile } = useSidebar()
  const expanded = !isMobile && state === 'expanded'
  return (
    <header className="flex h-9 w-full shrink-0 items-center border-b [-webkit-app-region:drag]">
      {expanded && <div className="flex h-full w-(--sidebar-width) shrink-0 items-center border-r bg-sidebar pr-3 pl-20">
        <span className="truncate text-xs font-medium text-sidebar-foreground" title={vaultName}>{vaultName || 'Folio'}</span>
      </div>}
      <div className={`flex min-w-0 items-center gap-2 pr-3 ${expanded ? 'pl-2' : 'pl-20'}`}>
        <SidebarTrigger className="shrink-0 [-webkit-app-region:no-drag]" />
        <h1 className="truncate text-ui font-medium" title={label}>{label}</h1>
      </div>
    </header>
  )
}
