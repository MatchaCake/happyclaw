/**
 * Child harness for tests/safe-git-proxy-tunnel-error.test.ts.
 * Starts the real pinned HTTPS proxy and forces a TCP reset on one side of a
 * CONNECT tunnel. Exit 0 only if the process survives and proxy.close() works.
 *
 * SCENARIO=upstream-reset: upstream RSTs mid-transfer after the tunnel is up.
 * SCENARIO=client-reset-during-resolve: client RSTs while DNS is pending.
 */
import net from 'node:net';

import { startPinnedHttpsProxy } from '../src/safe-git-proxy.js';

const scenario = process.env.SCENARIO;
if (
  scenario !== 'upstream-reset' &&
  scenario !== 'client-reset-during-resolve'
) {
  console.error('SCENARIO required');
  process.exit(2);
}

process.on('uncaughtException', (error) => {
  const code = (error as NodeJS.ErrnoException).code ?? error.message;
  console.log('UNCAUGHT', code);
  process.exit(1);
});

const upstreamServer = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.on('data', () => {
    socket.write('partial-pack-data');
    setTimeout(() => socket.resetAndDestroy(), 20);
  });
});
await new Promise<void>((resolve) =>
  upstreamServer.listen(0, '127.0.0.1', () => resolve()),
);
const upstreamAddress = upstreamServer.address();
if (!upstreamAddress || typeof upstreamAddress === 'string') {
  console.error('Missing upstream address');
  process.exit(2);
}
const upstreamPort = upstreamAddress.port;

let resolveStarted: () => void = () => {};
const resolveStartedPromise = new Promise<void>((resolve) => {
  resolveStarted = resolve;
});

const proxy = await startPinnedHttpsProxy('git.example.test', {
  resolveAddresses: async () => {
    resolveStarted();
    if (scenario === 'client-reset-during-resolve') {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return [{ address: '93.184.216.34', family: 4 }];
  },
  connectAddress: () => net.connect({ host: '127.0.0.1', port: upstreamPort }),
});
const proxyPort = Number(new URL(proxy.url).port);

const client = net.connect({ host: '127.0.0.1', port: proxyPort });
client.on('error', () => {});
let received = '';
client.setEncoding('utf8');
client.on('data', (chunk) => {
  received += chunk;
  if (
    scenario === 'upstream-reset' &&
    received.includes('200 Connection Established') &&
    !received.includes('git-pack-request-sent')
  ) {
    received += 'git-pack-request-sent';
    client.write('git-pack-request');
  }
});
client.once('connect', () => {
  client.write(
    'CONNECT git.example.test:443 HTTP/1.1\r\nHost: git.example.test:443\r\n\r\n',
  );
});

if (scenario === 'client-reset-during-resolve') {
  await resolveStartedPromise;
  client.resetAndDestroy();
}

await new Promise((resolve) => setTimeout(resolve, 600));
console.log('ALIVE', scenario);

await proxy.close();
console.log('PROXY_CLOSED');
await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
client.destroy();
console.log('PASS');
process.exit(0);
