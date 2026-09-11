import { Separator } from '@folio/ui'
import { SidebarTrigger, useSidebar } from '@folio/ui/components/ui/sidebar'
import { cn } from '@folio/ui/lib/utils'
import { ArrowLeft, ArrowRight } from 'lucide-react'

export const WorkspaceHeader = ({ label }: { label: string }) => {
  const { state } = useSidebar()
  return (
    <header className="flex w-full h-9 shrink-0 items-center gap-2 border-b [-webkit-app-region:drag] group-data-[state=collapsed]:px-3">
      <div className={cn('flex justify-end p-2 border-r', state === 'expanded' ? 'w-[220px]' : 'w-0')}>
        <ArrowLeft className="size-4 text-secondary-foreground" />
        <ArrowRight className="size-4 text-secondary-foreground" />
      </div>
      <div className={cn('flex items-center px-2', state === 'expanded' ? '' : 'pl-20')}>
        <SidebarTrigger className="[-webkit-app-region:no-drag]" />
        <Separator orientation="vertical" className="h-4" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-ui font-semibold" title={label}>
            {label}
          </h1>
        </div>
      </div>
    </header>
  )
}
