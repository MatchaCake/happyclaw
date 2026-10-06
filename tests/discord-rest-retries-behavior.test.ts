import { describe, expect, test } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { Client, Routes } from 'discord.js';

function createTestServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  return {
    server,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe('discord.js REST retry behavior', () => {
  describe('B_default_retries_four_creates', () => {
    test('AbortError: default retries (3) issues 4 visible creates', async () => {
      let creates = 0;
      const s = createTestServer((req, res) => {
        req.resume();
        if (req.method === 'POST') {
          creates++;
          // Never respond to trigger AbortError
        }
      });
      const url = await s.listen();
      const client = new Client({
        intents: [],
        rest: {
          api: url,
          timeout: 100,
        },
      });
      client.rest.setToken('test-token');

      let error: any = null;
      try {
        await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
        await s.close();
      }

      expect(error).not.toBeNull();
      expect(error.name).toBe('AbortError');
      expect(creates).toBe(4);
    });

    test('ECONNRESET: default retries (3) issues 4 visible creates', async () => {
      let creates = 0;
      const client = new Client({
        intents: [],
        rest: {
          makeRequest: async () => {
            creates++;
            const err = new Error('read ECONNRESET');
            (err as any).code = 'ECONNRESET';
            throw err;
          },
        },
      });
      client.rest.setToken('test-token');

      let error: any = null;
      try {
        await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
      }

      expect(error).not.toBeNull();
      expect(error.code).toBe('ECONNRESET');
      expect(creates).toBe(4);
    });

    test('HTTP 500: default retries (3) issues 4 visible creates', async () => {
      let creates = 0;
      const s = createTestServer((req, res) => {
        req.resume();
        if (req.method === 'POST') {
          creates++;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ message: 'Internal Server Error', code: 0 }),
          );
        }
      });
      const url = await s.listen();
      const client = new Client({
        intents: [],
        rest: {
          api: url,
        },
      });
      client.rest.setToken('test-token');

      let error: any = null;
      try {
        await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
        await s.close();
      }

      expect(error).not.toBeNull();
      expect(error.status).toBe(500);
      expect(creates).toBe(4);
    });
  });

  describe('B_retries_0_one_create', () => {
    test('AbortError: rest.retries: 0 issues exactly 1 visible create then rejects', async () => {
      let creates = 0;
      const s = createTestServer((req, res) => {
        req.resume();
        if (req.method === 'POST') {
          creates++;
          // Never respond to trigger AbortError
        }
      });
      const url = await s.listen();
      const client = new Client({
        intents: [],
        rest: {
          api: url,
          timeout: 100,
          retries: 0,
        },
      });
      client.rest.setToken('test-token');

      let error: any = null;
      try {
        await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
        await s.close();
      }

      expect(error).not.toBeNull();
      expect(error.name).toBe('AbortError');
      expect(creates).toBe(1);
    });

    test('ECONNRESET: rest.retries: 0 issues exactly 1 visible create then rejects', async () => {
      let creates = 0;
      const client = new Client({
        intents: [],
        rest: {
          retries: 0,
          makeRequest: async () => {
            creates++;
            const err = new Error('read ECONNRESET');
            (err as any).code = 'ECONNRESET';
            throw err;
          },
        },
      });
      client.rest.setToken('test-token');

      let error: any = null;
      try {
        await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
      }

      expect(error).not.toBeNull();
      expect(error.code).toBe('ECONNRESET');
      expect(creates).toBe(1);
    });

    test('HTTP 500: rest.retries: 0 issues exactly 1 visible create then rejects', async () => {
      let creates = 0;
      const s = createTestServer((req, res) => {
        req.resume();
        if (req.method === 'POST') {
          creates++;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ message: 'Internal Server Error', code: 0 }),
          );
        }
      });
      const url = await s.listen();
      const client = new Client({
        intents: [],
        rest: {
          api: url,
          retries: 0,
        },
      });
      client.rest.setToken('test-token');

      let error: any = null;
      try {
        await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
        await s.close();
      }

      expect(error).not.toBeNull();
      expect(error.status).toBe(500);
      expect(creates).toBe(1);
    });
  });

  describe('429 rate limit retry behavior', () => {
    test('HTTP 429 is still retried with rest.retries: 0 (2 visible creates then success)', async () => {
      let creates = 0;
      const s = createTestServer((req, res) => {
        req.resume();
        if (req.method === 'POST') {
          creates++;
          if (creates === 1) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': '0',
              'X-RateLimit-Scope': 'user',
              'X-RateLimit-Bucket': 'b1',
              'X-RateLimit-Limit': '1',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset-After': '0',
            });
            res.end(
              JSON.stringify({
                message: 'You are being rate limited.',
                retry_after: 0,
                global: false,
              }),
            );
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'msg-success', content: 'test' }));
          }
        }
      });
      const url = await s.listen();
      const client = new Client({
        intents: [],
        rest: {
          api: url,
          retries: 0,
          offset: 0,
        },
      });
      client.rest.setToken('test-token');

      let result: any = null;
      let error: any = null;
      try {
        result = await client.rest.post(Routes.channelMessages('chan-1'), {
          body: { content: 'test' },
        });
      } catch (err) {
        error = err;
      } finally {
        client.destroy();
        await s.close();
      }

      expect(error).toBeNull();
      expect(result).toEqual({ id: 'msg-success', content: 'test' });
      expect(creates).toBe(2);
    });
  });
});
