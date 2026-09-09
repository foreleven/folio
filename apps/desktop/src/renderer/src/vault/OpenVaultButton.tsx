import { Button } from '@folio/ui/components/ui/button'
import { useLocale } from '../preferences'
import { useVaultOpen } from './use-vault-open'
import { VaultOpenError } from './VaultOpenError'

/** Opens the native directory picker from an existing workspace or closed-vault screen. */
export function OpenVaultButton(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const { openVault, opening, failed } = useVaultOpen()
  return (
    <div className="grid justify-items-start gap-2">
      <Button variant="outline" disabled={opening !== null} onClick={() => void openVault()}>
        {opening ? (chinese ? '正在打开…' : 'Opening…') : (chinese ? '打开知识库' : 'Open Vault')}
      </Button>
      {failed ? <VaultOpenError /> : null}
    </div>
  )
}
