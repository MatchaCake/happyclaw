import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const harnessPath = path.join(
  repositoryRoot,
  'tests',
  'ws-upgrade-bad-host.harness.ts',
);
const tsxCli = path.join(
  repositoryRoot,
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
);

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const port = addr.port;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

describe('WebSocket upgrade malformed Host', () => {
  test('returns 400 and keeps serving HTTP when Host is an invalid URL', async () => {
    const port = await allocatePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uf893-ws-'));
    try {
      const result = spawnSync(process.execPath, [tsxCli, harnessPath], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          WEB_PORT: String(port),
          HAPPYCLAW_DATA_DIR: dataDir,
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      expect(result.status, combined).toBe(0);
      expect(combined).toMatch(/UPGRADE_STATUS HTTP\/1\.1 400 Bad Request/);
      expect(combined).toMatch(/HTTP_STATUS \d+/);
      expect(combined).toMatch(/\bPASS\b/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
