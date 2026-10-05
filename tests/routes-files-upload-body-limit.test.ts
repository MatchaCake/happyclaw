import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Shrink the per-file cap through the real env knob (read by config.ts at
// import time) instead of touching config defaults: cap = 1 MiB + 256 KiB.
const priorMaxFileSizeMb = vi.hoisted(() => {
  const prior = process.env.MAX_FILE_SIZE_MB;
  process.env.MAX_FILE_SIZE_MB = '1';
  return prior;
});

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-upload-body-limit-'),
);
const groupsDir = path.join(tmpDir, 'groups');
const workspaceDir = path.join(groupsDir, 'limit-workspace');

const dbMocks = vi.hoisted(() => ({ getRegisteredGroup: vi.fn() }));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
    GROUPS_DIR: groupsDir,
    STORE_DIR: path.join(tmpDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'member-user',
      username: 'member-user',
      role: 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: dbMocks.getRegisteredGroup,
}));

vi.mock('../src/web-context.js', () => ({
  canAccessGroup: () => true,
  isHostExecutionGroup: () => false,
  hasHostExecutionPermission: () => true,
}));

vi.mock('../src/billing.js', () => ({
  isBillingEnabled: () => false,
  checkStorageLimit: () => ({ allowed: true }),
}));

const routes = (await import('../src/routes/files.js')).default;
const { MAX_FILE_SIZE } = await import('../src/config.js');

const MIB = 1024 * 1024;
const CAP_BYTES = MAX_FILE_SIZE + 256 * 1024;
const BOUNDARY = '----happyclaw-body-limit';
const URL = 'http://localhost/web%3Alimit/files';

function multipartParts(fileName: string, fileSize: number) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return { head, payload: Buffer.alloc(fileSize, 0x61), tail };
}

beforeEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  dbMocks.getRegisteredGroup.mockReset();
  dbMocks.getRegisteredGroup.mockImplementation((jid: string) =>
    jid === 'web:limit'
      ? {
          jid,
          name: 'Limit workspace',
          folder: 'limit-workspace',
          added_at: '2026-10-05T00:00:00.000Z',
          executionMode: 'container',
          created_by: 'member-user',
          is_home: false,
        }
      : undefined,
  );
});

afterAll(() => {
  if (priorMaxFileSizeMb === undefined) delete process.env.MAX_FILE_SIZE_MB;
  else process.env.MAX_FILE_SIZE_MB = priorMaxFileSizeMb;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /:jid/files body limit', () => {
  test('cap is derived from MAX_FILE_SIZE_MB', () => {
    expect(MAX_FILE_SIZE).toBe(1 * MIB);
  });

  test('chunked body (no Content-Length) over the cap -> 413 before the handler buffers it', async () => {
    const { head, payload, tail } = multipartParts('big.bin', 2 * MIB);
    let pulledBytes = 0;
    const chunks = [head];
    for (let i = 0; i < payload.length; i += 64 * 1024) {
      chunks.push(payload.subarray(i, i + 64 * 1024));
    }
    chunks.push(tail);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (!next) return controller.close();
        pulledBytes += next.length;
        controller.enqueue(new Uint8Array(next));
      },
    });
    const request = new Request(URL, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(request.headers.get('content-length')).toBeNull();

    const response = await routes.request(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    expect(dbMocks.getRegisteredGroup).not.toHaveBeenCalled();
    // The limiter stops reading shortly after the cap instead of draining it.
    expect(pulledBytes).toBeLessThan(CAP_BYTES + 128 * 1024);
    expect(fs.existsSync(path.join(workspaceDir, 'big.bin'))).toBe(false);
  });

  test('declared Content-Length over the cap -> 413 without invoking the handler', async () => {
    const { head, payload, tail } = multipartParts('big.bin', 2 * MIB);
    const body = Buffer.concat([head, payload, tail]);
    expect(body.length).toBeGreaterThan(CAP_BYTES);

    const response = await routes.request(URL, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'content-length': String(body.length),
      },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    expect(dbMocks.getRegisteredGroup).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspaceDir, 'big.bin'))).toBe(false);
  });

  test('a single file exactly at MAX_FILE_SIZE still uploads (multipart overhead allowed)', async () => {
    const form = new FormData();
    form.append(
      'files',
      new File([Buffer.alloc(MAX_FILE_SIZE, 0x62)], 'ok.bin', {
        type: 'application/octet-stream',
      }),
    );

    const response = await routes.request(URL, { method: 'POST', body: form });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, files: ['ok.bin'] });
    expect(fs.statSync(path.join(workspaceDir, 'ok.bin')).size).toBe(
      MAX_FILE_SIZE,
    );
  });
});
