import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, FileSystem, Schema } from 'effect'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lark } from './lark/index.ts'
import { IntegrationError } from './integration.ts'
import { readState, writeState } from './lark/state.ts'
import type { LarkContext } from './lark/index.ts'

/** Interactive host example: each action requires confirmation; state updates display authorization URLs. */
const program = Effect.gen(function*() {
  const terminal = yield* Effect.acquireRelease(
    Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
    (terminal) => Effect.sync(() => terminal.close())
  )
  const directory = join(process.env.FOLIO_CONFIG_DIR || join(homedir(), '.folio'), 'integrations', 'lark')
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  const ResourceMetadata = Schema.Struct({ id: Schema.String, name: Schema.String })
  const registered = new Map(((yield* readState(join(directory, 'resources.json'), Schema.Array(ResourceMetadata))) ?? [])
    .map((resource) => [resource.id, resource]))
  const context: LarkContext = {
    directory,
    writeState: (state, data) => writeState(join(directory, 'state.json'), { state, data }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(() => new IntegrationError({ message: 'Could not persist integration state.' })),
      Effect.andThen(Console.log(state, data))
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
    const result = yield* lark.check(context)
    if (result.state === 'ready') { yield* Console.log('Lark ready'); return }
    const action = lark.actions.find((item) => result.actionIds.includes(item.id))!
    const answer = yield* Effect.promise((signal) => terminal.question(`${action.label}? [y/N] `, { signal }))
    if (answer.toLowerCase() !== 'y') return
    yield* lark.onActionCallback(context, action.id)
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
NodeRuntime.runMain(program)
