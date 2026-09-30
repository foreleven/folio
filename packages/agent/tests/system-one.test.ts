import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { afterEach, expect, it } from 'vitest';
import { evaluateSystemOne, makeSystemOneToolExecutor } from '../src/system-one.js';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const input = { rawRef: 'folio-raw:head/raws/chat.md', context: 'Original evidence',
  goals: [{ id: 'idea', description: 'Preserve unfinished ideas.' }, { id: 'question', description: 'Preserve unresolved questions.' }] };

/** Real HTTP validates the TypeSafe wire format without model credentials or inference costs. */
async function service(answer: (attempt: number) => { status?: number; body: unknown }) {
  const requests: Array<{ url?: string; authorization?: string; body: any }> = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
    const result = answer(requests.length);
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  }).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}
const answers = { model: 'local-jev', answers: { idea: { type: 'noul', noul: 0.7 }, question: { type: 'noul', noul: 0.6999 } } };

it.each(['', '/v1', '/v1/'])('uses the native Noul API and exact >=0.7 boundary with base suffix %s', async suffix => {
  const local = await service(() => ({ body: answers }));
  const result = await Effect.runPromise(evaluateSystemOne({ baseUrl: local.baseUrl + suffix, model: 'local-jev' },
    Redacted.make('test-secret'), input).pipe(Effect.provide(FetchHttpClient.layer)));
  expect(result.results).toEqual([{ goalId: 'idea', probability: 0.7, matched: true }, { goalId: 'question', probability: 0.6999, matched: false }]);
  expect(local.requests[0]).toMatchObject({ url: '/v1/systemone', authorization: 'Bearer test-secret', body: {
    model: 'local-jev', state: { rawRef: input.rawRef, context: input.context }, questions: { idea: { type: 'noul' }, question: { type: 'noul' } },
  } });
});

it('retries transient failures, but authentication errors expose only stage and status', async () => {
  const transient = await service(attempt => attempt === 1 ? { status: 529, body: { detail: 'private-server-diagnostic' } } : { body: answers });
  await Effect.runPromise(evaluateSystemOne({ baseUrl: transient.baseUrl, model: 'jev' }, Redacted.make('test-secret'), input).pipe(Effect.provide(FetchHttpClient.layer)));
  expect(transient.requests).toHaveLength(2);
  const unauthorized = await service(() => ({ status: 401, body: { detail: 'test-secret Original evidence' } }));
  const error = await Effect.runPromise(evaluateSystemOne({ baseUrl: unauthorized.baseUrl, model: 'jev' }, Redacted.make('test-secret'), input)
    .pipe(Effect.provide(FetchHttpClient.layer), Effect.flip));
  expect(error).toMatchObject({ reason: 'http', stage: 'request', status: 401 });
  expect(JSON.stringify(error)).not.toContain('test-secret');
  expect(JSON.stringify(error)).not.toContain('Original evidence');
  expect(unauthorized.requests).toHaveLength(1);
});

it.each([
  { model: 'jev', answers: { idea: { type: 'noul', noul: 1.1 } } },
  { model: 'jev', answers: { idea: { type: 'noul', noul: 0.9 } } },
  { model: 'jev', answers: { idea: { type: 'choice', choice: 'yes' }, question: { type: 'noul', noul: 0.9 } } },
])('rejects invalid or missing answers rather than silently skipping goals', async body => {
  const local = await service(() => ({ body }));
  expect(await Effect.runPromise(evaluateSystemOne({ baseUrl: local.baseUrl, model: 'jev' }, Redacted.make('test'), input)
    .pipe(Effect.provide(FetchHttpClient.layer), Effect.flip))).toMatchObject({ reason: 'invalid_response', stage: 'decode' });
  expect(local.requests).toHaveLength(1);
});

it('loads settings and the host credential without returning the API key in tool history', async () => {
  const local = await service(() => ({ body: answers }));
  const root = await mkdtemp(join(tmpdir(), 'folio-systemone-')); roots.push(root);
  await mkdir(join(root, 'agent'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ agent: { systemOne: { baseUrl: local.baseUrl, model: 'jev' } } }));
  await writeFile(join(root, 'agent/auth.json'), JSON.stringify({ 'folio-system-one': { type: 'api_key', key: 'host-only-key' } }), { mode: 0o600 });
  const execute = makeSystemOneToolExecutor(root, join(root, 'agent'));
  const result = await execute('system_one', 'call', input);
  expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('"matched":true') }]);
  expect(JSON.stringify(result)).not.toContain('host-only-key');
  expect(local.requests[0]?.authorization).toBe('Bearer host-only-key');
  await writeFile(join(root, 'config.json'), '{}');
  await expect(execute('system_one', 'missing', input)).rejects.toMatchObject({ reason: 'not_configured', stage: 'configuration' });
});
