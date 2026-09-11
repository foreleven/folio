import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { openCodexTurnRuntime } from '../dist/codex/turn-runtime.js';

const execute = promisify(execFile);
const executable = process.env.FOLIO_CODEX_EXECUTABLE || 'codex';
const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-codex-skills-')));
const nativeHome = join(root, 'native-home');
const cwd = join(root, 'task');
const selected = join(root, 'resources/folio-selected/SKILL.md');
const requests = [];
const fixtureScript = join(root, 'resources/folio-selected/write.mjs');
let fixtureError;

/** Quote each fixed fixture argument as one POSIX shell word, including paths containing apostrophes. */
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** Local deterministic Responses fixture: records model-visible context without calling any real model. */
const server = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] };
    const call = requests.length === 1 || requests.length === 3 || requests.length === 5 || requests.length === 6;
    if (call) {
      const tool = requests.at(-1).tools.find(tool => tool.name === 'exec_command');
      assert.equal(tool?.type, 'function');
      assert.deepEqual(tool.parameters.required, ['cmd']);
      assert.ok(tool.parameters.properties.login && tool.parameters.properties.yield_time_ms);
    }
    const item = call ? {
      type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`,
      name: 'exec_command', status: 'completed', arguments: JSON.stringify({
        cmd: `${quote(process.execPath)} ${quote(fixtureScript)}${requests.length === 3 ? ' fail' : requests.length === 5 ? ' cancel' : requests.length === 6 ? ' background' : ''}`,
        login: false, yield_time_ms: requests.length === 6 ? 1000 : 10000,
      }),
    } : message;
    const result = { id: 'resp_fixture', object: 'response', created_at: 0, status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      ...(call ? [] : [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'Fixture complete.' }]),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch (error) {
    fixtureError = error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

/** Runs the production native adapter with an isolated Codex configuration and loopback model fixture. */
async function turn(nativeSessionId, mode = 'normal') {
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const platform = yield* ChildProcessSpawner.ChildProcessSpawner;
    const updates = [];
    const runtime = yield* openCodexTurnRuntime({ cwd, executable, nativeSessionId, skillPaths: [selected],
      onUpdate: async update => { updates.push(update); },
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
      ...platform,
      // CODEX_HOME is used for its native configuration purpose only in this child; the user's home is untouched.
      spawn: command => platform.spawn(command.pipe(ChildProcess.setEnv({ ...process.env, CODEX_HOME: nativeHome }))),
    }));
    const handle = yield* runtime.prompt('Execute the selected fixture script, then report its result.');
    if (mode === 'cancel') {
      // Wait for the actual writer, not only item/started: otherwise cancellation could precede execution.
      yield* Effect.tryPromise(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { await readFile(join(cwd, 'raws/fixture/writer.pid')); return; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await delay(20);
        }
        throw new Error('Native writer did not start.');
      });
      yield* runtime.cancel;
    }
    assert.equal(yield* handle.completion, mode === 'cancel' ? 'cancelled' : 'end_turn');
    if (mode === 'cancel') {
      yield* Effect.tryPromise(async () => {
        const pid = Number(await readFile(join(cwd, 'raws/fixture/writer.pid'), 'utf8'));
        const before = await readFile(join(cwd, 'raws/fixture/heartbeat.txt'), 'utf8');
        await delay(200);
        assert.equal(await readFile(join(cwd, 'raws/fixture/heartbeat.txt'), 'utf8'), before);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      });
    }
    assert.equal(updates.at(-1)?.state, 'idle');
    if (mode === 'background') {
      yield* Effect.tryPromise(async () => {
        const pid = Number(await readFile(join(cwd, 'raws/fixture/writer.pid'), 'utf8'));
        process.kill(pid, 0);
        const before = await readFile(join(cwd, 'raws/fixture/heartbeat.txt'), 'utf8');
        await delay(150);
        assert.notEqual(await readFile(join(cwd, 'raws/fixture/heartbeat.txt'), 'utf8'), before);
      });
      const tools = updates.filter(update => update.sessionUpdate === 'tool_call_update');
      assert.ok(tools.some(update => update.kind === 'execute' && update.status === 'in_progress'));
      assert.ok(!tools.some(update => update.kind === 'execute' && ['completed', 'failed'].includes(update.status)));
    }
    return { nativeSessionId: runtime.nativeSessionId, updates };
  })).pipe(Effect.provide(NodeServices.layer), Effect.timeout('30 seconds')));
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await mkdir(nativeHome);
  await mkdir(join(root, 'resources/folio-selected'), { recursive: true });
  await mkdir(join(cwd, '.agents/skills/folio-unselected'), { recursive: true });
  await writeFile(selected, '---\nname: folio-selected\ndescription: Selected fixture skill\n---\nFOLIO_SELECTED_BODY_SENTINEL\n');
  await writeFile(join(cwd, '.agents/skills/folio-unselected/SKILL.md'),
    '---\nname: folio-unselected\ndescription: FOLIO_UNSELECTED_SENTINEL\n---\nUnselected fixture body.\n');
  await writeFile(join(nativeHome, 'config.toml'), `model = "gpt-5.3-codex"\nmodel_provider = "folio-fixture"\n[model_providers.folio-fixture]\nname = "Folio fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const version = (await execute(executable, ['--version'])).stdout.trim();
  // The debug renderer exercises native automatic catalog suppression without creating a Turn.
  for (const suppressed of [false, true]) {
    const { stdout } = await execute(executable, ['debug', 'prompt-input',
      ...(suppressed ? ['-c', 'skills.include_instructions=false'] : []), 'Render only.'],
    { cwd, env: { ...process.env, CODEX_HOME: nativeHome }, maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
    assert.equal(stdout.includes('FOLIO_UNSELECTED_SENTINEL'), !suppressed);
  }
  await writeFile(fixtureScript, `import { mkdir, writeFile } from 'node:fs/promises';
if (process.argv[2] === 'fail') { console.error('FOLIO_COMMAND_FAILED'); process.exitCode = 7; }
else if (['cancel', 'background'].includes(process.argv[2])) {
  await writeFile('raws/fixture/heartbeat.txt', '0');
  await writeFile('raws/fixture/writer.pid', String(process.pid));
  let tick = 0;
  // A finite lifetime also bounds cleanup if the adapter fails to interrupt this fixture.
  const timer = setInterval(async () => { await writeFile('raws/fixture/heartbeat.txt', String(++tick)); }, 25);
  setTimeout(() => clearInterval(timer), 5000);
}
else {
  await mkdir('wiki', { recursive: true });
  await mkdir('raws/fixture', { recursive: true });
  await writeFile('wiki/fixture.md', 'FOLIO_COMMAND_WRITTEN');
  await writeFile('raws/fixture/cwd.txt', process.cwd());
  console.log('FOLIO_COMMAND_SUCCESS');
}
`);
  await execute('git', ['init', '--initial-branch=main'], { cwd });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'Bootstrap'], { cwd });
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd })).stdout;
  const first = await turn();
  const resumed = await turn(first.nativeSessionId);
  assert.equal(resumed.nativeSessionId, first.nativeSessionId);
  assert.equal(await readFile(join(cwd, 'wiki/fixture.md'), 'utf8'), 'FOLIO_COMMAND_WRITTEN');
  assert.equal(await readFile(join(cwd, 'raws/fixture/cwd.txt'), 'utf8'), cwd);
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd })).stdout, head);
  for (const [result, status, marker] of [[first, 'completed', 'FOLIO_COMMAND_SUCCESS'],
    [resumed, 'failed', 'FOLIO_COMMAND_FAILED']]) {
    const calls = result.updates.filter(update => update.sessionUpdate === 'tool_call_update');
    assert.ok(calls.some(update => update.kind === 'execute' && update.status === 'in_progress'));
    assert.ok(calls.some(update => update.kind === 'execute' && update.status === status
      && JSON.stringify(update.content).includes(marker)), JSON.stringify(calls));
  }
  const cancelled = await turn(first.nativeSessionId, 'cancel');
  assert.equal(cancelled.nativeSessionId, first.nativeSessionId);
  assert.equal(cancelled.updates.at(-1)?.stopReason, 'cancelled');
  await turn(first.nativeSessionId, 'background');
  const backgroundPid = Number(await readFile(join(cwd, 'raws/fixture/writer.pid'), 'utf8'));
  assert.throws(() => process.kill(backgroundPid, 0), { code: 'ESRCH' });
  assert.equal(fixtureError, undefined);
  await appendFile(join(nativeHome, 'config.toml'), `\n[skills]\nconfig = [{ path = ${JSON.stringify(selected)}, enabled = false }]\n`);
  await assert.rejects(turn(first.nativeSessionId));
  assert.equal(requests.length, 7);
  for (const [index, marker, exitCode] of [[1, 'FOLIO_COMMAND_SUCCESS', 0], [3, 'FOLIO_COMMAND_FAILED', 7]]) {
    const outputs = requests[index].input.filter(item => item.type === 'function_call_output');
    assert.ok(outputs.some(item => JSON.stringify(item.output).includes(marker)
      && JSON.stringify(item.output).includes(`Process exited with code ${exitCode}`)));
  }
  for (const request of requests) {
    assert.ok(JSON.stringify(request.input).includes('FOLIO_SELECTED_BODY_SENTINEL'));
    assert.ok(!JSON.stringify(request.input).includes('FOLIO_UNSELECTED_SENTINEL'));
  }
  console.log(JSON.stringify({ version, selectedSkillBody: 'passed', unselectedCatalogExcluded: 'passed',
    nativeResume: 'passed', disabledSkillBlocksPrompt: 'passed', turns: 4, foregroundCancellation: 'passed', backgroundTerminalCleanup: 'passed', modelRequests: requests.length, nativeCommandExecution: 'passed',
    failedCommandProjection: 'passed', taskCwd: 'passed', noAutomaticCommit: 'passed',
    model: 'loopback fixture only', persistentUserConfigWrites: false }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await delay(5500); // Bound the finite writer's lifetime even if native shutdown leaves it alive.
  await rm(root, { recursive: true, force: true });
}
