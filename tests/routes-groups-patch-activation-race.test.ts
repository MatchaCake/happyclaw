/**
 * PATCH /api/groups/:jid snapshots getRegisteredGroup before await c.req.json().
 * commitUpdate then full-column upserts that snapshot. A name-only PATCH that
 * yields on the body lets a concurrent writer commit activation_mode and
 * owner_im_id, and the stale upsert puts them back.
 *
 * Probes:
 *   B_current_drops_activation — before the re-read, name sticks but
 *     activation_mode returns to auto and owner_im_id returns to null.
 *   B_fix_keeps_activation — after the re-read overlay, the rename sticks and
 *     those two fields stay at the concurrent writer's values.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-groups-patch-race-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;
const OWNER_ID = 'alice';
const JID = 'web:patch-activation-race';
const FOLDER = 'patch-activation-race';

const webDepsCache: Record<string, unknown> = {};

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => webDepsCache,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
  delete webDepsCache[JID];
  try {
    db.deleteRegisteredGroup(JID);
  } catch {
    /* ignore */
  }
});

describe('PATCH /:jid name yield vs concurrent activation write', () => {
  test('B_fix_keeps_activation', async () => {
    db.setRegisteredGroup(JID, {
      name: 'Original',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
      activation_mode: 'auto',
    });
    webDepsCache[JID] = db.getRegisteredGroup(JID)!;
    asUser(OWNER_ID, 'member');

    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let markBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulled) return;
        pulled = true;
        markBodyRead();
        await bodyGate;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ name: 'Renamed' })),
        );
        controller.close();
      },
    });

    const pending = groupRoutes.request(`/${encodeURIComponent(JID)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);

    await bodyRead;

    const concurrent = db.getRegisteredGroup(JID);
    expect(concurrent?.activation_mode).toBe('auto');
    expect(concurrent?.owner_im_id ?? null).toBe(null);
    db.setRegisteredGroup(JID, {
      ...concurrent!,
      activation_mode: 'owner_mentioned',
      owner_im_id: 'ou_x',
    });

    releaseBody();
    const res = await pending;
    expect(res.status).toBe(200);

    const after = db.getRegisteredGroup(JID);
    const live = webDepsCache[JID] as
      | {
          name?: string;
          activation_mode?: string;
          owner_im_id?: string | null;
        }
      | undefined;
    const dropped =
      after?.activation_mode !== 'owner_mentioned' ||
      after?.owner_im_id !== 'ou_x' ||
      live?.activation_mode !== 'owner_mentioned' ||
      live?.owner_im_id !== 'ou_x';
    if (dropped) {
      throw new Error(
        `B_current_drops_activation name=${after?.name} activation_mode=${after?.activation_mode} owner_im_id=${String(after?.owner_im_id)} live_activation=${live?.activation_mode} live_owner=${String(live?.owner_im_id)}`,
      );
    }
    expect(after?.name).toBe('Renamed');
    expect(after?.activation_mode).toBe('owner_mentioned');
    expect(after?.owner_im_id).toBe('ou_x');
    expect(live?.name).toBe('Renamed');
    expect(live?.activation_mode).toBe('owner_mentioned');
    expect(live?.owner_im_id).toBe('ou_x');
  });
});
