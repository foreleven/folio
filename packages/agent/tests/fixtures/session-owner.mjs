import { SessionLeaseStore } from '../../dist/acp/session-lease.js';

// Keep the owner alive until the parent deliberately kills it to exercise recovery.
const lease = await new SessionLeaseStore(process.argv[2]).acquire('session', { agent: 'codex', nativeSessionId: 'native' });
await lease.bind({ agent: 'codex', nativeSessionId: 'native' }, Number(process.argv[3]) || process.pid);
process.send('ready');
setInterval(() => {}, 1000);
