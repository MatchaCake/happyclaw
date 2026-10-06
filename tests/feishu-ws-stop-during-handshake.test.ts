import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ws-stop-'));
fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });

// Fake Feishu long-connection provider: the endpoint-discovery POST answers
// after PULL_DELAY_MS (a slow/flaky network), then hands out a local WS URL.
const PULL_DELAY_MS = 400;
const provider = vi.hoisted(() => ({ domain: '', live: 0, opened: 0 }));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Real SDK WSClient / EventDispatcher; only the REST client is faked and the
// WS client is pointed at the local provider.
vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => {
  const real =
    (await importOriginal()) as typeof import('@larksuiteoapi/node-sdk');
  class LocalWSClient extends real.WSClient {
    constructor(params: ConstructorParameters<typeof real.WSClient>[0]) {
      super({
        ...params,
        appId: 'cli_0123456789abcdef',
        domain: provider.domain,
        loggerLevel: real.LoggerLevel.error,
      });
    }
  }
  const empty = vi
    .fn()
    .mockResolvedValue({ data: { items: [], has_more: false } });
  return {
    ...real,
    WSClient: LocalWSClient,
    Client: class {
      request = vi
        .fn()
        .mockResolvedValue({ bot: { open_id: 'ou_bot', app_name: 'Bot' } });
      im = {
        v1: { chat: { list: empty }, message: { list: empty, get: empty } },
      };
    },
  };
});

const db = await import('../src/db.js');
const { createFeishuConnection } = await import('../src/feishu.js');

let wss: WebSocketServer;
let server: http.Server;

beforeAll(async () => {
  db.initDatabase();
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (s) => {
    provider.live += 1;
    provider.opened += 1;
    s.on('close', () => (provider.live -= 1));
  });
  const wsPort = (wss.address() as { port: number }).port;
  server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            URL: `ws://127.0.0.1:${wsPort}/ws?device_id=d1&service_id=1`,
            ClientConfig: {
              PingInterval: 120,
              ReconnectCount: -1,
              ReconnectInterval: 2,
              ReconnectNonce: 0,
            },
          },
        }),
      );
    }, PULL_DELAY_MS);
  });
  await new Promise<void>((r) => server.listen(0, r));
  provider.domain = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.close();
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('stop() during the WS handshake leaves no live Feishu long connection', async () => {
  const connection = createFeishuConnection({
    appId: 'app_handshake',
    appSecret: 'secret',
    channelAccountId: `acct-${Date.now()}`,
  });
  expect(
    await connection.connect({
      onReady: vi.fn(),
      ignoreMessagesBefore: Date.now(),
    }),
  ).toBe(true);
  // connect() returned before the provider handshake finished.
  expect(provider.live).toBe(0);

  // im-manager disconnect / account reload / disable lands here.
  await connection.stop();
  expect(connection.isConnected()).toBe(false);

  await new Promise((r) => setTimeout(r, PULL_DELAY_MS + 600));
  // A stopped connector must not own (or orphan) a provider socket. Feishu
  // long connections are cluster-mode: each event goes to ONE random client,
  // so an orphan steals events from the live replacement connector.
  expect(provider.live).toBe(0);
}, 15_000);
