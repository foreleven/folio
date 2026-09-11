/** Provides the shared window frame with a fixed bottom bar outside page content. */
export function WindowLayout({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-svh min-h-0 w-full flex-col bg-background">
      <div className="min-h-0 flex-1">{children}</div>
      {footer}
    </div>
  )
}
