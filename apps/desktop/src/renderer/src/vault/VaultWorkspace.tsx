import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { FolderIcon, GitBranchIcon, ListTodoIcon, WorkflowIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { VaultWorkspaceLayout, type WorkspaceSection } from './layouts/VaultWorkspaceLayout'
import { useLocale } from '../preferences'
import { VaultRpcClient } from '../rpc/vault-rpc'
import { RoutinePanel } from '../routines/RoutinePanel'
import { TaskPanel } from '../tasks/TaskPanel'
import { OpenVaultButton } from './OpenVaultButton'
import { WorkspaceChangesPanel } from './WorkspaceChangesPanel'

/** Resolves this window's vault by stable ID; reloads keep the same window context. */
export function VaultWorkspace({ id }: { id: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = VaultRpcClient.query('vault.get', { id })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const name = result._tag === 'Success' ? result.value?.name : undefined
  const [section, setSection] = useState<WorkspaceSection>('overview')

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
    <VaultWorkspaceLayout chinese={chinese} vault={vault} section={section} onSectionChange={setSection}>
      {section === 'overview' ? (
        <OverviewContent chinese={chinese} vaultName={vault.name} vaultPath={vault.path} onNavigate={setSection} />
      ) : section === 'changes' ? (
        <WorkspaceChangesPanel key={`changes:${vault.id}`} vaultId={vault.id} />
      ) : section === 'routines' ? (
        <RoutinePanel key={`routines:${vault.id}`} vaultId={vault.id} />
      ) : (
        <TaskPanel key={vault.id} vaultId={vault.id} />
      )}
    </VaultWorkspaceLayout>
  )
}

function OverviewContent({
  chinese,
  vaultName,
  vaultPath,
  onNavigate
}: {
  chinese: boolean
  vaultName: string
  vaultPath: string
  onNavigate: (section: WorkspaceSection) => void
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-6" aria-labelledby="vault-overview-title">
      <div>
        <p className="text-support font-medium text-primary">{chinese ? '知识库概览' : 'Vault overview'}</p>
        <h3 id="vault-overview-title" className="mt-1 text-xl leading-7 font-semibold">
          {chinese ? '知识库已打开' : 'Your vault is open'}
        </h3>
        <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">
          {chinese ? '这是你的个人 Wiki 文件存储位置。选择一个工作区模块开始工作。' : 'This folder is home to your personal wiki files. Choose a workspace section to get started.'}
        </p>
      </div>
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <FolderIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-ui font-medium" title={vaultName}>
              {vaultName}
            </p>
            <p className="mt-1 truncate font-mono text-support text-muted-foreground" title={vaultPath}>
              {vaultPath}
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <WorkspaceLink
          icon={GitBranchIcon}
          title={chinese ? '文件变更' : 'File changes'}
          description={chinese ? '检查并保存磁盘变更' : 'Review and save disk changes'}
          onClick={() => onNavigate('changes')}
        />
        <WorkspaceLink icon={WorkflowIcon} title="Routines" description={chinese ? '管理自动化工作流' : 'Manage automated workflows'} onClick={() => onNavigate('routines')} />
        <WorkspaceLink
          icon={ListTodoIcon}
          title={chinese ? '任务' : 'Tasks'}
          description={chinese ? '打开 Agent 工作区' : 'Open Agent workspaces'}
          onClick={() => onNavigate('tasks')}
        />
      </div>
    </section>
  )
}

function WorkspaceLink({ icon: Icon, title, description, onClick }: { icon: typeof GitBranchIcon; title: string; description: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex min-h-20 flex-col items-start gap-2 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      <Icon className="size-4 text-primary" aria-hidden="true" />
      <span className="text-ui font-medium">{title}</span>
      <span className="text-support text-muted-foreground">{description}</span>
    </button>
  )
}
