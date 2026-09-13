import { RoutineSchedulerLive } from './services/routine-scheduler'
import { NodeServices } from '@effect/platform-node'
import { lark, LarkCliArchive, LarkSkillsDirectory, LarkWorkflowsDirectory } from '@folio/integrations/lark'
import { gmail, GmailAssetsDirectory } from '@folio/integrations/gmail'
import { app } from 'electron'
import { join } from 'node:path'
import larkCliArchive from '../../../../packages/integrations/src/lark/assets/lark-cli-1.0.94-darwin-arm64.tar.gz?asset&asarUnpack'
import larkCliLinuxArchive from '../../../../packages/integrations/src/lark/assets/lark-cli-1.0.94-linux-amd64.tar.gz?asset&asarUnpack'

const larkCliArchiveForPlatform = process.platform === 'linux' && process.arch === 'x64' ? larkCliLinuxArchive : larkCliArchive

const larkSkillsDirectory = app.isPackaged
  ? join(process.resourcesPath, 'lark-skills')
  : join(app.getAppPath(), '../../packages/integrations/src/lark/assets/skills')
const larkWorkflowsDirectory = app.isPackaged
  ? join(process.resourcesPath, 'lark-workflows')
  : join(app.getAppPath(), '../../packages/integrations/src/lark/assets/workflows')
const gmailAssetsDirectory = app.isPackaged
  ? join(process.resourcesPath, 'gmail-assets')
  : join(app.getAppPath(), '../../packages/integrations/src/gmail/assets')
import { IntegrationService } from './services/integration-service'
import type { Integration } from '@folio/integrations/base'
import type { IntegrationPlatform } from './services/integration-catalog'
import { IntegrationCatalog } from './services/integration-catalog'
import { IntegrationStore } from './services/integration-store'
import { IntegrationBrowser } from './electron/IntegrationBrowser'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner'
import { Effect, Layer, References, Stream } from 'effect'
import { ElectronApp, type ElectronAppEvent } from './electron/ElectronApp'
import { MainWindow } from './electron/MainWindow'
import { MainRpcLive } from './rpc/runtime'
import { ConfigService } from './services/config-service'
import { ModelService } from './services/model-service'
import { SettingsWindow } from './electron/SettingsWindow'
import { ApplicationMenuLive } from './electron/ApplicationMenu'
import { ApplicationThemeLive } from './electron/ApplicationTheme'

import { VaultService } from './services/vault-service'
import { TaskService } from './services/task-service'
import { AgentRuntime } from './services/agent-runtime'
import { VaultLauncher } from './electron/VaultLauncher'

const ConfigLive = ConfigService.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const IntegrationsLive = IntegrationService.layer.pipe(
  Layer.provide(IntegrationStore.layer),
  Layer.provide(Layer.succeed(IntegrationCatalog)([{
    ...lark,
    // electron-vite resolves this asset outside app.asar; the provider stays Electron-independent.
    setup: () => lark.setup!().pipe(
      Effect.provideService(LarkSkillsDirectory, larkSkillsDirectory),
      Effect.provideService(LarkWorkflowsDirectory, larkWorkflowsDirectory)
    ),
    install: () => lark.install().pipe(
      Effect.provideService(LarkCliArchive, larkCliArchiveForPlatform),
      Effect.provideService(LarkSkillsDirectory, larkSkillsDirectory),
      Effect.provideService(LarkWorkflowsDirectory, larkWorkflowsDirectory)
    ),
    onActionCallback: (id, payload) => lark.onActionCallback(id, payload).pipe(
      Effect.provideService(LarkCliArchive, larkCliArchiveForPlatform),
      Effect.provideService(LarkSkillsDirectory, larkSkillsDirectory),
      Effect.provideService(LarkWorkflowsDirectory, larkWorkflowsDirectory)
    )
  }, {
    ...gmail,
    install: () => gmail.install().pipe(Effect.provideService(GmailAssetsDirectory, gmailAssetsDirectory)),
    onActionCallback: (id, payload) => gmail.onActionCallback(id, payload).pipe(
      Effect.provideService(GmailAssetsDirectory, gmailAssetsDirectory)
    )
  }])),
  Layer.provide(IntegrationBrowser.layer),
  Layer.provide(NodeServices.layer)
)

/** Handles one Electron lifecycle event through the injected application services. */
const handleEvent = Effect.fn('main.handleElectronEvent')(
  function*(event: ElectronAppEvent) {
    const mainWindow = yield* MainWindow

    switch (event._tag) {
      case 'Activate':
        if (!(yield* mainWindow.isOpen)) {
          yield* mainWindow.open
        }
        return
      case 'WindowAllClosed':
        // A Task belongs to the application scope, not a window. Explicit Quit ends that scope.
        return
    }
  }
)

/** Main application workflow, independent of concrete Electron adapters. */
export const application = Effect.gen(function*() {
  const electronApp = yield* ElectronApp
  const mainWindow = yield* MainWindow

  yield* electronApp.whenReady
  yield* Effect.logInfo('Electron application ready').pipe(Effect.annotateLogs({ subsystem: 'application' }))
  yield* mainWindow.open
  yield* Effect.logInfo('Folio main window opened').pipe(Effect.annotateLogs({ subsystem: 'application' }))
  yield* Stream.runForEach(electronApp.events, handleEvent)
})

/** Complete main-process layer with one shared Electron application boundary. */
export const MainLive = Layer.mergeAll(MainRpcLive, ApplicationMenuLive, RoutineSchedulerLive).pipe(
  Layer.provide(VaultLauncher.layer),
  Layer.provideMerge(MainWindow.layer),
  Layer.provide(VaultService.layer),
  Layer.provide(TaskService.layer),
  Layer.provide(IntegrationsLive),
  Layer.provide(ModelService.layer()),
  Layer.provideMerge(AgentRuntime.layer(join(app.getAppPath(), 'out/main'))),
  Layer.provide(NodeChildProcessSpawner.layer),
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  Layer.provide(SettingsWindow.layer),
  Layer.provide(ApplicationThemeLive),
  Layer.provideMerge(ConfigLive),
  Layer.provideMerge(ElectronApp.layer)
)

/** Fully wired process program; completion releases every scoped main resource. */
export const program = Effect.logInfo('Folio main process starting').pipe(
  Effect.annotateLogs({ subsystem: 'application' }),
  // This marker runs before MainLive acquisition so layer-construction failures still have a startup boundary.
  Effect.andThen(application.pipe(Effect.provide(MainLive))),
  // Development keeps lifecycle diagnostics visible in the terminal; packaged builds retain operational events.
  Effect.provideService(References.MinimumLogLevel, app.isPackaged ? 'Info' : 'Debug')
)
