import { WikiPanel } from '../wiki/WikiPanel'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useEffect, useState } from 'react'
import { VaultWorkspaceLayout, type WorkspaceSection } from './layouts/VaultWorkspaceLayout'
import { useLocale } from '../preferences'
import { VaultRpcClient } from '../rpc/vault-rpc'
import { RoutinePanel } from '../routines/RoutinePanel'
import { TaskPanel } from '../tasks/TaskPanel'
import { OpenVaultButton } from './OpenVaultButton'
import { WorkspaceChangesPanel } from './WorkspaceChangesPanel'
import { TaskFeed } from './TaskFeed'

/** Reads the Vault bound to this native window by main; route text does not select its identity. */
export function VaultWorkspace(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = VaultRpcClient.query('vault.get', {})
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const name = result._tag === 'Success' ? result.value?.name : undefined
  const [section, setSection] = useState<WorkspaceSection>('wiki')

  // The HTML document title otherwise overrides Electron's initial native window title.
  useEffect(() => {
    document.title = name ? `${name} — Folio` : 'Folio'
  }, [name])

  if (result._tag !== 'Success') {
    return (
      <main className="min-h-svh bg-background p-4">
        <section className="w-full max-w-190" role="status">
          <p className="text-support text-muted-foreground">
            {result._tag === 'Failure' ? (chinese ? '无法加载知识库。' : 'Could not load the vault.') : chinese ? '正在加载…' : 'Loading…'}
          </p>
          {result._tag === 'Failure' ? (
            <Button className="mt-3" onClick={refresh}>
              {chinese ? '重试' : 'Retry'}
            </Button>
          ) : null}
        </section>
      </main>
    )
  }

  if (!result.value) {
    return (
      <main className="min-h-svh bg-background p-4">
        <section className="w-full max-w-190">
          <h1 className="text-sm leading-5 font-semibold">{chinese ? '此知识库已关闭' : 'This vault is closed'}</h1>
          <p className="mt-2 text-support text-muted-foreground">{chinese ? '重新选择文件夹以打开知识库。' : 'Select its folder to open the vault again.'}</p>
          <div className="mt-4">
            <OpenVaultButton />
          </div>
        </section>
      </main>
    )
  }

  const vault = result.value
  return (
    <WikiPanel key={vault.id} active={section === 'wiki'} onActivate={() => setSection('wiki')}>
      {({ navigation, content }) => <VaultWorkspaceLayout chinese={chinese} vault={vault} section={section} onSectionChange={setSection} wikiNavigation={navigation}>
      <div hidden={section !== 'wiki'}>{content}</div>
      {section === 'wiki' ? null : section === 'overview' ? (
        <TaskFeed key={vault.id} />
      ) : section === 'changes' ? (
        <WorkspaceChangesPanel key={`changes:${vault.id}`} />
      ) : section === 'routines' ? (
        <RoutinePanel key={`routines:${vault.id}`} />
      ) : (
        <TaskPanel key={vault.id} />
      )}
      </VaultWorkspaceLayout>}
    </WikiPanel>
  )
}
