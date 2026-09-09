import { cn } from '@folio/ui/lib/utils'
import { useLocale } from '../preferences'

/** Keeps the same localized, retryable open failure in welcome and workspace actions. */
export function VaultOpenError({ className }: { className?: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  return <p role="alert" className={cn("m-0 max-w-110 text-support text-destructive", className)}>
    {chinese ? '无法打开知识库。请检查目录是否存在及 vault 配置后重试。' : 'Could not open the vault. Check that the folder exists and its configuration is accessible, then try again.'}
  </p>
}
