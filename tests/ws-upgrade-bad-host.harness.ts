/**
 * Child harness for tests/ws-upgrade-bad-host.test.ts.
 * Starts the real web server, sends a malformed-Host WebSocket upgrade, then
 * a plain HTTP request. Exit 0 only if upgrade returns 400 and HTTP still works.
 */
import http from 'node:http';
import net from 'node:net';

const port = Number(process.env.WEB_PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error('WEB_PORT required');
  process.exit(2);
}

const { startWebServer, shutdownWebServer } = await import('../src/web.js');

const queue = {
  setOnContainerExit() {},
  setOnRunnerStateChange() {},
  setOnQueryStart() {},
  setOnQueryFinish() {},
  stopGroup: async () => {},
  getActiveQueryId: () => null,
};

startWebServer({
  queue,
  getRegisteredGroups: () => ({}),
  sessions: {},
  getSessions: () => ({}),
  processGroupMessages: async () => false,
  ensureTerminalContainerStarted: () => false,
  formatMessages: () => '',
  getLastAgentTimestamp: () => ({}),
  setLastAgentTimestamp: () => {},
  advanceCursors: () => {},
  advanceNextPullCursorOnly: () => {},
  advanceGlobalCursor: () => {},
} as any);

await new Promise((r) => setTimeout(r, 300));

const upgradeStatus = await new Promise<string>((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => {
    c.write(
      'GET /ws HTTP/1.1\r\n' +
        'Host: exa mple.com\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
  });
  let buf = '';
  c.on('data', (d) => {
    buf += d.toString();
  });
  c.on('close', () => resolve(buf.split('\r\n')[0] || ''));
  c.on('error', () => resolve(buf.split('\r\n')[0] || 'error'));
  setTimeout(() => resolve(buf.split('\r\n')[0] || 'timeout'), 2000);
});

console.log('UPGRADE_STATUS', upgradeStatus);

const httpStatus = await new Promise<number | string>((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
    res.resume();
    resolve(res.statusCode ?? 0);
  });
  req.on('error', (e) => resolve(`error:${e.message}`));
  setTimeout(() => resolve('timeout'), 2000);
});

console.log('HTTP_STATUS', httpStatus);

await shutdownWebServer().catch(() => {});

if (upgradeStatus !== 'HTTP/1.1 400 Bad Request') {
  console.error('FAIL expected 400 Bad Request, got:', upgradeStatus);
  process.exit(1);
}
if (typeof httpStatus !== 'number' || httpStatus < 100) {
  console.error('FAIL server did not serve next HTTP request:', httpStatus);
  process.exit(1);
}
console.log('PASS');
process.exit(0);
