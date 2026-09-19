import { Effect, FileSystem, Schema } from 'effect'
import { lstat, rmdir, symlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { VaultError } from '../../../shared/vault'
import { makeVaultGit } from '../git/vault-git'

const Marker = Schema.Struct({
  version: Schema.Literal(1),
  initialCommit: Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{40,64}$/.test(value)))
})
const instructions = `# Vault workspace

- Work inside this Task workspace. Read AGENTS.md before editing.
- Folio owns Git commits, branches and synchronization. Use Git only for reading status and diffs.
- Keep original source material under raws/ unchanged. Call the provided Integration scripts to obtain new source material.
- Do not leave background processes writing this workspace after a turn ends.
- Place curated user content under wiki/.
`

/**
 * Initializes a main Git checkout before publishing the reverse link. Existing user content is never
 * moved; rmdir atomically refuses a nonempty source. A published checkout is retained on link failure.
 */
export const initializeVaultWorkspace = Effect.fn('VaultWorkspace.initialize')(
  function* (directory: string, selected: string) {
    const fs = yield* FileSystem.FileSystem
    if (!isAbsolute(directory) || !isAbsolute(selected))
      return yield* Effect.fail(new Error('Absolute vault paths are required'))
    const workspace = join(directory, 'workspace')
    const wiki = join(workspace, 'wiki')
    const git = yield* makeVaultGit
    yield* git(directory, ['--version'])
    if (!(yield* fs.exists(workspace))) {
      const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: '.workspace-' })
      const staged = join(temporary, 'workspace')
      yield* fs.makeDirectory(staged)
      yield* fs.makeDirectory(join(staged, 'wiki'))
      yield* fs.makeDirectory(join(staged, 'raws'))
      yield* fs.writeFileString(join(staged, 'AGENTS.md'), instructions)
      yield* fs.writeFileString(join(staged, '.gitignore'), '.DS_Store\n')
      yield* git(staged, ['init', '--initial-branch=main', '--template='])
      yield* git(staged, ['add', '--', 'AGENTS.md', '.gitignore'])
      yield* git(staged, ['commit', '-m', 'Initialize Folio vault workspace'])
      const initialCommit = (yield* git(staged, ['rev-parse', 'HEAD'])).trim()
      yield* fs.writeFileString(
        join(staged, '.git', 'folio-workspace.json'),
        JSON.stringify({ version: 1, initialCommit }),
        { mode: 0o600 }
      )
      // The complete nonempty checkout is published in one rename. Competing initializers cannot replace it.
      yield* fs.rename(staged, workspace)
    }
    for (const owned of [workspace, join(workspace, '.git'), wiki]) {
      const info = yield* Effect.tryPromise(() => lstat(owned))
      if (!info.isDirectory() || info.isSymbolicLink())
        return yield* Effect.fail(new Error('Managed workspace was redirected'))
    }
    const marker = yield* fs
      .readFileString(join(workspace, '.git', 'folio-workspace.json'))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Marker))))
    const canonicalWorkspace = yield* fs.realPath(workspace)
    if (
      (yield* git(workspace, ['rev-parse', '--show-toplevel'])).trim() !== canonicalWorkspace ||
      (yield* git(workspace, ['branch', '--show-current'])).trim() !== 'main'
    )
      return yield* Effect.fail(new Error('Workspace repository mismatch'))
    yield* git(workspace, ['cat-file', '-e', `${marker.initialCommit}^{commit}`])
    const canonicalWiki = yield* fs.realPath(wiki)
    const current = yield* fs
      .realPath(selected)
      .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(null)))
    if (current === canonicalWiki)
      return { workspace: canonicalWorkspace, wiki: canonicalWiki, initialCommit: marker.initialCommit }
    if (current !== null) {
      const info = yield* Effect.tryPromise(() => lstat(selected))
      if (!info.isDirectory() || info.isSymbolicLink())
        return yield* Effect.fail(new Error('Select an empty directory'))
      // Unlike recursive removal, this refuses files added after any earlier emptiness check.
      yield* Effect.tryPromise(() => rmdir(selected))
    }
    yield* Effect.tryPromise(() => symlink(canonicalWiki, selected, process.platform === 'win32' ? 'junction' : 'dir'))
    return { workspace: canonicalWorkspace, wiki: canonicalWiki, initialCommit: marker.initialCommit }
  },
  Effect.scoped,
  Effect.mapError(
    () =>
      new VaultError({
        message: 'Could not initialize the vault workspace. Choose an empty directory and check Git availability.',
        cause: undefined
      })
  )
)
