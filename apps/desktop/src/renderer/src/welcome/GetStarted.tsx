import { Button } from '@folio/ui/components/ui/button'
import { Separator } from '@folio/ui/components/ui/separator'
import { cn } from '@folio/ui/lib/utils'
import { FolderOpenIcon, LoaderCircleIcon } from 'lucide-react'
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
      <div className="mb-3 flex w-full items-center gap-4">
        <h2 className={cn('shrink-0 font-mono text-xs font-medium text-muted-foreground', !chinese && 'tracking-[0.04em]')} id="get-started-heading">
          {chinese ? '开始使用' : 'GET STARTED'}
        </h2>
        <Separator className="min-w-0 flex-1 bg-border/80" />
      </div>
      <Button variant="ghost" className="h-11 w-full justify-start gap-3 rounded-md px-3 text-sm font-normal sm:px-4 sm:text-base" disabled={opening !== null}
        aria-label={opening === 'picker' ? (chinese ? '正在打开' : 'Opening') : (chinese ? '打开知识库' : 'Open Vault')}
        aria-describedby="open-vault-guidance" onClick={() => void onOpen()}>
        {opening === 'picker'
          ? <LoaderCircleIcon data-icon="inline-start" className="size-4 animate-spin text-primary motion-reduce:animate-none" />
          : <FolderOpenIcon data-icon="inline-start" className="size-4 text-primary" />}
        <span>{opening === 'picker' ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}</span>
        <span className="ml-auto hidden text-sm font-normal text-muted-foreground sm:inline">
          {chinese ? '选择文件夹' : 'Choose a folder'}
        </span>
      </Button>
      <p className="sr-only" id="open-vault-guidance">
        {chinese ? '选择一个文件夹作为你的知识库。' : 'Choose a folder for your knowledge.'}
      </p>
    </section>
  )
}
