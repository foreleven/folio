import { expect, it } from 'vitest'
import { NodeServices } from '@effect/platform-node'
import { Console, Effect, FileSystem, Schema } from 'effect'
import { createInterface } from 'node:readline/promises'
import { openSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lark } from '../src/lark/index.ts'
import { IntegrationContext, IntegrationError } from '../src/base/index.ts'
import { readState, writeState } from '../src/lark/state.ts'

/** Live installation test: confirms each action and passes only after readiness and resource registration. */
it.skipIf(process.env.FOLIO_LARK_LIVE !== '1')('installs Lark through confirmed actions and reaches ready', async ({ signal }) => {
  await Effect.runPromise(Effect.gen(function*() {
    // Vitest workers do not inherit stdin. Read the controlling terminal directly
    // so confirmation remains interactive instead of waiting on a disconnected pipe.
    const input = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new ReadStream(openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r')),
        catch: () => new IntegrationError({ message: 'Run the live installation test in an interactive terminal.' })
      }),
      (input) => Effect.sync(() => { input.destroy() })
    )
    const terminal = yield* Effect.acquireRelease(
      Effect.sync(() => createInterface({ input, output: process.stdout })),
      (terminal) => Effect.sync(() => terminal.close())
    )
    const directory = join(process.env.FOLIO_CONFIG_DIR || join(homedir(), '.folio'), 'integrations', 'lark')
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const ResourceMetadata = Schema.Struct({ id: Schema.String, name: Schema.String })
    const registered = new Map(((yield* readState(join(directory, 'resources.json'), Schema.Array(ResourceMetadata))) ?? [])
      .map((resource) => [resource.id, resource]))
    const context: IntegrationContext["Service"] = {
      directory,
      writeState: (state, data, actions = []) => writeState(join(directory, 'state.json'), { state, data, actions }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(() => new IntegrationError({ message: 'Could not persist integration state.' })),
        Effect.andThen(Console.log(state, data, actions))
      ),
      registerResource: (resource) => Effect.gen(function*() {
        registered.set(resource.id, { id: resource.id, name: resource.name })
        yield* writeState(join(directory, 'resources.json'), [...registered.values()])
        yield* Console.log(`Resource: lark/${resource.id}`)
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(() => new IntegrationError({ message: 'Could not register integration resource.' })))
    }
    // Rebind runtime resources even when shared dependencies were installed by an earlier host.
    if (yield* readState(join(directory, 'installed.json'), Schema.Boolean)) {
      for (const resource of lark.resources) yield* context.registerResource(resource)
    }
    while (true) {
      const result = yield* lark.inspect().pipe(Effect.provideService(IntegrationContext, context))
      if (result.state === 'ready') {
        expect([...registered.keys()].sort()).toEqual(lark.resources.map((resource) => resource.id).sort())
        expect(result.actions).toEqual([])
        return
      }
      const action = lark.actions.find((item) => result.actions.some((action) => action.id === item.id && action.type === 'callback'))
      if (!action) return yield* new IntegrationError({ message: `No action available for state: ${result.state}` })
      const answer = yield* Effect.promise((signal) => terminal.question(`${action.label}? [y/N] `, { signal }))
      if (answer.toLowerCase() !== 'y') return yield* new IntegrationError({ message: 'Installation cancelled before reaching ready.' })
      yield* lark.onActionCallback(action.id).pipe(Effect.provideService(IntegrationContext, context))
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { signal })
}, 15 * 60_000)
