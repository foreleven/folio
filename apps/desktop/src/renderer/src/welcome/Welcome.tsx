import { useLocale } from '../preferences'
import { useVaultOpen } from '../vault/use-vault-open'
import { VaultOpenError } from '../vault/VaultOpenError'
import { GetStarted } from './GetStarted'
import { RecentVaults } from './RecentVaults'
import { WelcomeHeader } from './WelcomeHeader'

/** Coordinates one opening operation across the picker and recent-vault list. */
export function Welcome(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const { openVault, opening, failed } = useVaultOpen()

  return (
    <main className="grid min-h-svh place-items-center-safe overflow-y-auto bg-background px-6 py-12 max-[480px]:px-4 [@media(max-height:599px)]:py-6">
      <section className="w-full max-w-160">
        <WelcomeHeader />
        <div className="flex flex-col gap-8 text-left">
          <GetStarted opening={opening} onOpen={openVault} />
          <RecentVaults opening={opening} onOpen={openVault} />
        </div>
        {opening !== null ? <span role="status" className="sr-only">{chinese ? '正在打开知识库…' : 'Opening vault…'}</span> : null}
        {failed ? <VaultOpenError className="mt-4 border-l-2 border-destructive pl-3" /> : null}
      </section>
    </main>
  )
}
