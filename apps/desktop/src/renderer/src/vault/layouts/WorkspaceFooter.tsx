import { Vault } from '../../../../shared/vault'
import { Box } from 'lucide-react'

/** Shows persistent workspace state outside the scrollable page content. */
export function WorkspaceFooter({ chinese, sectionLabel, vault }: { chinese: boolean; sectionLabel: string; vault: Vault }): React.JSX.Element {
  return (
    <footer
      className="flex w-full h-7 shrink-0 items-center justify-between gap-3 border-t bg-background px-3 text-support text-muted-foreground"
      aria-label={chinese ? '知识库状态' : 'Vault status'}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Box className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate" title={vault.path}>
          {vault.name}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden sm:inline">{sectionLabel}</span>
        <span className="text-muted-foreground/60">Folio</span>
      </div>
    </footer>
  )
}
