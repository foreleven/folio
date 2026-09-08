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
    <main className="grid min-h-screen place-items-center bg-background p-10 max-[600px]:p-6">
      <section className="w-full max-w-140 text-center">
        <WelcomeHeader />
        <div className="flex flex-col gap-7 text-left">
          <GetStarted opening={opening} onOpen={openVault} />
          <RecentVaults opening={opening} onOpen={openVault} />
        </div>
        {opening !== null ? <span role="status" className="sr-only">{chinese ? '正在打开知识库…' : 'Opening vault…'}</span> : null}
        {failed ? <VaultOpenError className="mx-auto mt-6 leading-[1.7]" /> : null}
      </section>
    </main>
  )
}
