import { cn } from '@folio/ui/lib/utils'

interface FolioMarkProps {
  className?: string
  size?: 'compact' | 'welcome'
}

/** Renders the established Folio paper mark at navigation or welcome-page scale. */
export function FolioMark({ className, size = 'compact' }: FolioMarkProps): React.JSX.Element {
  const welcome = size === 'welcome'
  return (
    <span className={cn('relative block shrink-0', welcome ? 'size-14 sm:size-16' : 'size-7', className)} aria-hidden="true">
      <span className={cn('absolute right-0 bg-muted', welcome
        ? 'inset-y-[6%] left-[22%] rounded-[18%] border-2'
        : 'inset-y-0.5 left-1.5 rounded-md border')} />
      <span className={cn('absolute left-0 grid place-items-center bg-background font-[Georgia,serif] font-semibold text-primary shadow-xs', welcome
        ? 'inset-y-0 right-[22%] rounded-[18%] border-2 text-xl sm:text-2xl'
        : 'inset-y-0 right-1.5 rounded-md border text-ui')}>
        F
      </span>
    </span>
  )
}
