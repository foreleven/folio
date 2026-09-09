import { Button } from '@folio/ui/components/ui/button'
import { FolderOpenIcon } from 'lucide-react'
import { useLocale } from '../preferences'
import { useVaultOpen } from './use-vault-open'
import { VaultOpenError } from './VaultOpenError'

/** Opens the native directory picker from an existing workspace or closed-vault screen. */
export function OpenVaultButton(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const { openVault, opening, failed } = useVaultOpen()
  return (
    <div className="relative grid justify-items-start">
      <Button variant="outline" disabled={opening !== null} onClick={() => void openVault()}>
        <FolderOpenIcon />
        {opening ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}
      </Button>
      {failed ? <div className="absolute top-full right-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-popover p-3 shadow-lg ring-1 ring-foreground/10"><VaultOpenError /></div> : null}
    </div>
  )
}
