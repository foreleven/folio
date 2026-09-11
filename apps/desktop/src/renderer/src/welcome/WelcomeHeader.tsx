import { useLocale } from '../preferences'
import { FolioMark } from '../FolioMark'

/** Presents the welcome title and folder-opening guidance in the active locale. */
export function WelcomeHeader(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return (
    <header className="mb-7 flex items-center justify-center gap-4 text-left [-webkit-app-region:drag] sm:mb-8 sm:gap-5">
      <FolioMark size="welcome" />
      <div className="min-w-0">
        <h1 className="text-xl leading-tight font-medium tracking-tight sm:text-3xl">{chinese ? '你的知识，自成一页。' : 'A home for your knowledge.'}</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground italic sm:text-base">
          {chinese ? '打开一个知识库，继续记录与探索。' : 'Open a vault. Pick up where you left off.'}
        </p>
      </div>
    </header>
  )
}
