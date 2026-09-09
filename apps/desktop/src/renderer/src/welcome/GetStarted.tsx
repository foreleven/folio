import { Button } from '@folio/ui/components/ui/button'
import { ArrowRightIcon, FolderOpenIcon } from 'lucide-react'
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
      <h2 className="mb-2 text-support font-medium text-muted-foreground" id="get-started-heading">{chinese ? '开始使用' : 'GET STARTED'}</h2>
      <Button variant="outline" className="h-8 w-full justify-start gap-2 px-2.5 shadow-xs" disabled={opening !== null} onClick={() => void onOpen()}>
        <FolderOpenIcon className="size-4 text-primary" />
        <span>{opening === 'picker' ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}</span>
        <ArrowRightIcon className="ml-auto size-3.5 text-muted-foreground" />
      </Button>
      <p className="mt-2 text-support text-muted-foreground">{chinese ? '选择一个文件夹作为你的知识库。' : 'Choose a folder for your knowledge.'}</p>
    </section>
  )
}
