import net from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  startPinnedHttpsProxy,
  type PinnedHttpsProxy,
} from '../src/safe-git-proxy.js';

const proxies: PinnedHttpsProxy[] = [];
const sockets = new Set<net.Socket>();
const servers: net.Server[] = [];
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function tracked(socket: net.Socket) {
  sockets.add(socket);
  socket.on('error', () => {});
  return socket;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const addresses = [{ address: '93.184.216.34', family: 4 as const }];
async function connectClient(proxy: PinnedHttpsProxy) {
  const client = tracked(
    net.connect(Number(new URL(proxy.url).port), '127.0.0.1'),
  );
  await new Promise<void>((resolve) => client.once('connect', resolve));
  client.write(
    'CONNECT git.example.test:443 HTTP/1.1\r\nHost: git.example.test:443\r\n\r\n',
  );
  return client;
}
async function listen(server: net.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

describe('CONNECT cancellation and peer cleanup', () => {
  test.each(['reset', 'close'] as const)(
    'does not dial after a client %s during DNS',
    async (kind) => {
      const dns = deferred<typeof addresses>();
      const resolveAddresses = vi.fn(() => dns.promise);
      const connectAddress = vi.fn(() => tracked(new net.Socket()));
      const proxy = await startPinnedHttpsProxy('git.example.test', {
        resolveAddresses,
        connectAddress,
      });
      proxies.push(proxy);
      const client = await connectClient(proxy);
      await vi.waitFor(() => expect(resolveAddresses).toHaveBeenCalledOnce());
      if (kind === 'reset') client.resetAndDestroy();
      else client.destroy();
      // Deliver FIN/RST before DNS finishes; the server must remember retirement.
      await new Promise((resolve) => setTimeout(resolve, 50));
      dns.resolve(addresses);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connectAddress).not.toHaveBeenCalled();
    },
  );

  test('cancels an upstream still waiting for connect when the client closes', async () => {
    const upstream = tracked(new net.Socket());
    const connectAddress = vi.fn(() => upstream);
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses: async () => addresses,
      connectAddress,
    });
    proxies.push(proxy);
    const client = await connectClient(proxy);
    await vi.waitFor(() => expect(connectAddress).toHaveBeenCalledOnce());
    client.destroy();
    await vi.waitFor(() => expect(upstream.destroyed).toBe(true));
    expect(upstream.listenerCount('connect')).toBe(0);
  });

  test('proxy close cancels pending DNS before it can create an upstream', async () => {
    const dns = deferred<typeof addresses>();
    const resolveAddresses = vi.fn(() => dns.promise);
    const connectAddress = vi.fn(() => tracked(new net.Socket()));
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses,
      connectAddress,
    });
    proxies.push(proxy);
    await connectClient(proxy);
    await vi.waitFor(() => expect(resolveAddresses).toHaveBeenCalledOnce());
    await proxy.close();
    proxies.pop();
    dns.resolve(addresses);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connectAddress).not.toHaveBeenCalled();
  });

  test('an upstream orderly FIN flushes all buffered pack bytes', async () => {
    const pack = Buffer.alloc(1024 * 1024, 0x61);
    const port = await listen(
      net.createServer((socket) => tracked(socket).end(pack)),
    );
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses: async () => addresses,
      connectAddress: () => tracked(net.connect(port, '127.0.0.1')),
    });
    proxies.push(proxy);
    const client = await connectClient(proxy);
    const chunks: Buffer[] = [];
    client.on('data', (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => client.once('end', resolve));
    const response = Buffer.concat(chunks);
    const headerEnd = response.indexOf('\r\n\r\n') + 4;
    expect(response.subarray(0, headerEnd).toString()).toContain(
      '200 Connection Established',
    );
    expect(response.subarray(headerEnd)).toEqual(pack);
  });

  test('releases an established upstream when a client closes normally', async () => {
    const accepted: net.Socket[] = [];
    const port = await listen(
      net.createServer((socket) => {
        accepted.push(tracked(socket));
        socket.write('ready');
      }),
    );
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses: async () => addresses,
      connectAddress: () => tracked(net.connect(port, '127.0.0.1')),
    });
    proxies.push(proxy);
    const client = await connectClient(proxy);
    client.resume();
    await vi.waitFor(() => expect(accepted.length).toBe(1));
    client.destroy();
    await vi.waitFor(() => expect(accepted[0].destroyed).toBe(true));
  });
});
