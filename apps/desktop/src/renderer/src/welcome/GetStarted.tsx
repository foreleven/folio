import { Button } from '@folio/ui/components/ui/button'
import { useLocale } from '../preferences'

interface GetStartedProps {
  opening: string | null
  onOpen: () => Promise<void>
}

/** Opens the folder picker while respecting the shared welcome action state. */
export function GetStarted({ opening, onOpen }: GetStartedProps): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return (
    <section className="min-w-0" aria-labelledby="get-started-heading">
      <h2 className="mb-4 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground" id="get-started-heading">{chinese ? '开始使用' : 'GET STARTED'}</h2>
      <Button variant="outline" className="h-12 w-full justify-between px-4" disabled={opening !== null} onClick={() => void onOpen()}>
        <span>{opening === 'picker' ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}</span>
        <span aria-hidden="true">↗</span>
      </Button>
      <p className="mt-3 text-[0.8rem] leading-[1.7] text-muted-foreground">{chinese ? '选择一个文件夹作为你的知识库。' : 'Choose a folder for your knowledge.'}</p>
    </section>
  )
}
