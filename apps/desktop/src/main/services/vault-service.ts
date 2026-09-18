import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from 'effect'
import { v7 as uuidv7 } from 'uuid'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { Vault, VaultError } from '../../shared/vault'
import { ConfigService } from './config-service'
import { vaultDatabaseLayer } from './vault-database'
import { initializeVaultWorkspace } from './vault-workspace'

/** Owns stable Vault identities and publishes a reverse link to Folio-managed content. */
export class VaultService extends Context.Service<
  VaultService,
  {
    /** Registers an empty directory or reopens a known entry, ensuring storage and its managed wiki link. */
    readonly register: (directory: string) => Effect.Effect<Vault, VaultError>
    /** Deletes Folio's managed workspace for a vault and its published source link. */
    readonly remove: (vault: Vault) => Effect.Effect<void, VaultError>
  }
>()('folio/services/VaultService') {
  static readonly layer = Layer.effect(
    VaultService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* ConfigService
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const lock = yield* Semaphore.make(1)

      /** Uses the global index for identity; incomplete settings/database initialization retries with the same ID. */
      const register = Effect.fn('VaultService.register')(
        function* (selected: string) {
          yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(selected)
          const resolved = path.resolve(selected)
          // Normalize parents even if the final link is absent after an interrupted publication.
          const requested = path.join(yield* fs.realPath(path.dirname(resolved)), path.basename(resolved))
          const entries = (yield* config.get).vaults
          let existing = entries.find((entry) => entry.path === requested)
          const canonicalPath = yield* fs
            .realPath(requested)
            .pipe(Effect.catchReason('PlatformError', 'NotFound', (cause) => (existing ? Effect.succeed(null) : Effect.fail(cause))))
          if (canonicalPath !== null && (yield* fs.stat(canonicalPath)).type !== 'Directory') {
            return yield* new VaultError({ message: 'Choose a directory for your vault.', cause: selected })
          }
          // Following the published link changes realPath, but must never allocate another Vault identity.
          if (!existing)
            for (const entry of entries) {
              const target = yield* fs.realPath(entry.path).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(null)))
              if (target !== null && target === canonicalPath) {
                existing = entry
                break
              }
            }
          if (!existing && (yield* fs.readDirectory(canonicalPath!)).length > 0) {
            return yield* new VaultError({
              message: 'Choose an empty directory for a new vault. Existing content is not migrated.',
              cause: undefined
            })
          }
          const vault =
            existing ??
            (yield* config.addVault({
              id: uuidv7(),
              name: path.basename(canonicalPath!) || 'vault',
              path: canonicalPath!
            }))
          const directory = path.join(config.directory, 'vaults', vault.id)
          const filePath = path.join(directory, 'config.json')
          if (!(yield* fs.exists(filePath))) {
            yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
            const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: '.config-' })
            const staged = path.join(temporary, 'config.json')
            // Identity lives only in the global index; this file is reserved for vault-level settings.
            yield* fs.writeFileString(staged, '{}\n', { mode: 0o600 })
            yield* fs.rename(staged, filePath).pipe(Effect.uninterruptible)
          }
          // Initialize existing vaults too; the registration scope closes the client
          // before returning, and later SQL consumers acquire their own scoped layer.
          yield* Layer.build(vaultDatabaseLayer(directory))
          yield* initializeVaultWorkspace(directory, vault.path).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
          return vault
        },
        Effect.scoped,
        lock.withPermit,
        Effect.mapError((cause) =>
          cause instanceof VaultError
            ? cause
            : new VaultError({
                message: 'Could not register the vault. Check the folder and vault configuration.',
                cause
              })
        )
      )

      /**
       * Removes only paths proven to belong to this vault. The selected path is
       * deleted only when it is a link to this vault's managed wiki directory;
       * a user-replaced path is left untouched.
       */
      const remove = Effect.fn('VaultService.remove')(
        function* (vault: Vault) {
          const managed = path.join(config.directory, 'vaults', vault.id)
          const managedWiki = path.join(managed, 'workspace', 'wiki')
          // Deletion may have removed the managed tree before the global index
          // commit failed. Resolve the stable root to make that retry idempotent.
          const managedWikiCanonical = yield* fs.realPath(managedWiki).pipe(
            Effect.catchReason('PlatformError', 'NotFound', () =>
              fs.realPath(config.directory).pipe(Effect.map(root => path.join(root, 'vaults', vault.id, 'workspace', 'wiki'))))
          )
          const linkTarget = yield* fs.readLink(vault.path).pipe(
            Effect.map((target) => path.resolve(path.dirname(vault.path), target)),
            Effect.catch(() => Effect.succeed(null))
          )
          yield* fs.remove(managed, { recursive: true, force: true })
          if (linkTarget === managedWikiCanonical) {
            yield* fs.remove(vault.path, { force: true })
          }
        },
        lock.withPermit,
        Effect.mapError((cause) => (cause instanceof VaultError ? cause : new VaultError({ message: 'Could not delete the vault files.', cause })))
      )

      return VaultService.of({ register, remove })
    })
  )
}
