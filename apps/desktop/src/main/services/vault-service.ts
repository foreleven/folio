import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from 'effect'
import { v7 as uuidv7 } from 'uuid'
import { Vault, VaultError } from '../../shared/vault'
import { ConfigService } from './config-service'
import { vaultDatabaseLayer } from './vault-database'

/** Owns vault registration; user content remains in the selected directory. */
export class VaultService extends Context.Service<VaultService, {
  /** Resolves an existing directory, saves its identity, and ensures its settings and database. */
  readonly register: (directory: string) => Effect.Effect<Vault, VaultError>
}>()('folio/services/VaultService') {
  static readonly layer = Layer.effect(VaultService, Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const lock = yield* Semaphore.make(1)

    /** Uses the global index for identity; incomplete settings/database initialization retries with the same ID. */
    const register = Effect.fn('VaultService.register')(function*(selected: string) {
      yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(selected)
      const canonicalPath = yield* fs.realPath(path.resolve(selected))
      if ((yield* fs.stat(canonicalPath)).type !== 'Directory') {
        return yield* new VaultError({ message: 'Choose a directory for your vault.', cause: selected })
      }
      const vault = yield* config.addVault({
        id: uuidv7(),
        name: path.basename(canonicalPath) || 'vault',
        path: canonicalPath
      })
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
      return vault
    }, Effect.scoped, lock.withPermit, Effect.mapError((cause) =>
      new VaultError({ message: 'Could not register the vault. Check the folder and vault configuration.', cause })
    ))

    return VaultService.of({ register })
  }))
}
