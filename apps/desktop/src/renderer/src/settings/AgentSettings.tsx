import { BotIcon, CheckIcon } from 'lucide-react'
import { useLocale } from '../preferences'
import { ModelsSettings } from './ModelsSettings'

/** Pi is the only selectable agent today; each future agent will own its settings panel. */
export function AgentSettings(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-3 text-support text-muted-foreground">{chinese ? '选择 Agent，然后配置它使用的 Provider 和模型。' : 'Choose an agent, then configure its providers and models.'}</p>
        <div role="group" aria-label={chinese ? '选择 Agent' : 'Choose agent'} className="grid grid-cols-2 gap-3">
          <button type="button" aria-label="Pi" aria-pressed="true" className="flex items-center gap-3 rounded-xl border border-primary bg-primary/5 p-4 text-left focus-visible:outline-2 focus-visible:outline-ring">
            <BotIcon className="size-5 text-primary" aria-hidden="true" />
            <span className="flex-1"><span className="block text-ui font-medium">Pi</span><span className="text-support text-muted-foreground">{chinese ? '内置 · 默认 Agent' : 'Built in · Default agent'}</span></span>
            <CheckIcon className="size-4 text-primary" aria-hidden="true" />
          </button>
          <button type="button" disabled aria-pressed="false" className="flex items-center gap-3 rounded-xl border border-dashed p-4 text-left opacity-50">
            <BotIcon className="size-5" aria-hidden="true" />
            <span><span className="block text-ui font-medium">Codex</span><span className="text-support text-muted-foreground">{chinese ? '后续支持' : 'Coming later'}</span></span>
          </button>
        </div>
      </div>
      <ModelsSettings />
    </div>
  )
}
