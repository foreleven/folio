import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Run against a macOS directory build, outside the repository: otherwise Node
// can hide missing packaged dependencies by loading ancestor node_modules.
const source = process.argv[2]
if (process.platform !== 'darwin' || !source?.endsWith('.app')) {
  throw new Error('Usage on macOS: pnpm package:smoke <path/to/Folio.app>')
}
const temporary = await mkdtemp(join(tmpdir(), 'folio-package-smoke-'))
try {
  const app = join(temporary, 'Folio.app')
  // macOS cp preserves relative framework symlinks and clones files on APFS.
  const copy = spawnSync('cp', ['-cR', resolve(source), app], { encoding: 'utf8' })
  if (copy.error) throw copy.error
  if (copy.status !== 0) throw new Error(`Could not copy package: ${copy.stderr}`)
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { resolve } from 'node:path';
    import { Worker } from 'node:worker_threads';
    const root = resolve('Folio.app/Contents/Resources/app.asar.unpacked');
    const require = createRequire(root + '/package.json');
    require('@larksuiteoapi/node-sdk');
    require('googleapis/build/src/apis/gmail/v1.js');
    require('imapflow');
    require('mailparser');
    require('html-to-text');
    const worker = new Worker(root + '/out/main/agent-worker.js', { execArgv: [] });
    let disposed = false;
    const timer = setTimeout(() => {
      console.error('Packaged Worker did not exit');
      process.exitCode = 1;
      void worker.terminate();
    }, 15000);
    worker.on('message', event => {
      if (event.type === 'result' && event.id === 1) disposed = true;
      if (event.type === 'error') { console.error(event); process.exitCode = 1; }
    });
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => {
      clearTimeout(timer);
      assert.equal(code, 0);
      assert.equal(disposed, true, 'Worker must acknowledge disposal');
      console.log('Relocated package: SDK imports and Worker disposal passed');
    });
    worker.postMessage({ type: 'dispose', id: 1 });
  `
  const result = spawnSync(join(app, 'Contents/MacOS/Folio'), ['--input-type=module', '-e', script], {
    cwd: temporary,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', NODE_OPTIONS: '' },
    encoding: 'utf8', timeout: 30000
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Packaged smoke failed: ${result.signal ?? result.status}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
