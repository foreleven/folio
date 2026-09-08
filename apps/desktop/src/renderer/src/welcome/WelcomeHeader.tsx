import { useLocale } from '../preferences'

/** Presents the welcome title and folder-opening guidance in the active locale. */
export function WelcomeHeader(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return (
    <header className="mb-7 flex items-center gap-4 text-left">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted font-[Georgia,serif] text-2xl text-foreground" aria-hidden="true">F</div>
      <div className="min-w-0">
        <span className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">Folio</span>
        <h1 className="my-1 text-[clamp(1.25rem,2.5vw,1.5rem)] leading-tight font-[550] tracking-[-0.035em]">{chinese ? '你的知识，自成一页。' : 'A home for your knowledge.'}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{chinese ? '打开一个知识库，继续记录与探索。' : 'Open a vault. Pick up where you left off.'}</p>
      </div>
    </header>
  )
}
