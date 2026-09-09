import { cn } from '@folio/ui/lib/utils'

/** Renders Folio's compact paper mark without introducing a separate image asset. */
export function FolioMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cn('relative block size-7 shrink-0', className)} aria-hidden="true">
      <span className="absolute inset-y-0.5 right-0 left-1.5 rounded-md border bg-muted" />
      <span className="absolute inset-y-0 right-1.5 left-0 grid place-items-center rounded-md border bg-background font-[Georgia,serif] text-ui font-semibold text-primary shadow-xs">F</span>
    </span>
  )
}
