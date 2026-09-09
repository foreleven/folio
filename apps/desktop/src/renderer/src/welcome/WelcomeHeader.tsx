import { useLocale } from '../preferences'

/** Presents the welcome title and folder-opening guidance in the active locale. */
export function WelcomeHeader(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return (
    <header className="mb-4 flex items-center gap-3 text-left">
      <div className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted font-[Georgia,serif] text-lg text-foreground" aria-hidden="true">F</div>
      <div className="min-w-0">
        <h1 className="text-lg leading-6 font-semibold">{chinese ? '你的知识，自成一页。' : 'A home for your knowledge.'}</h1>
        <p className="text-support text-muted-foreground">{chinese ? '打开一个知识库，继续记录与探索。' : 'Open a vault. Pick up where you left off.'}</p>
      </div>
    </header>
  )
}
