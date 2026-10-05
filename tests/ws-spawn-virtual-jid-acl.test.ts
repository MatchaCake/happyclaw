import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-ws-spawn-acl-'),
);
process.env.HAPPYCLAW_TEST_DATA_DIR = tmpDataDir;

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

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'alice',
        username: 'alice',
        display_name: 'Alice',
        role: 'member' as const,
        permissions: [],
      });
      return next();
    },
  };
});

const { evaluateWsSpawnCommandAccess } = await import('../src/web.js');
const db = await import('../src/db.js');
const { stripVirtualJidSuffix } = await import('../src/utils.js');

const OWNER = { id: 'owner-user', role: 'member' as const };
const NON_OWNER = { id: 'stranger-user', role: 'member' as const };
const BASE_JID = 'web:ws-spawn-acl-group';
const UNKNOWN_BASE_JID = 'web:missing-group';

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(BASE_JID, {
    name: 'WS Spawn ACL Test Group',
    folder: 'ws-spawn-acl-group',
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER.id,
    is_home: false,
  } as any);
});

describe('evaluateWsSpawnCommandAccess - virtual JID ACL (ClawQA UF-852-1)', () => {
  test('stripVirtualJidSuffix strips both #agent: and #task: suffixes', () => {
    const agentVirtualJid = `${BASE_JID}#agent:agent-uuid-123`;
    const taskVirtualJid = `${BASE_JID}#task:task-uuid-456`;

    expect(stripVirtualJidSuffix(agentVirtualJid)).toBe(BASE_JID);
    expect(stripVirtualJidSuffix(taskVirtualJid)).toBe(BASE_JID);
    expect(stripVirtualJidSuffix(BASE_JID)).toBe(BASE_JID);

    // Note: stripRuntimeJidSuffix only strips #agent:, so stripVirtualJidSuffix
    // is required to avoid missing #task: virtual JIDs.
  });

  test('non-owner on #agent: virtual JID is denied', () => {
    const jid = `${BASE_JID}#agent:agent-uuid-123`;
    expect(evaluateWsSpawnCommandAccess(NON_OWNER, jid)).toEqual({
      dispatched: false,
      reason: 'access',
    });
  });

  test('non-owner on #task: virtual JID is denied', () => {
    const jid = `${BASE_JID}#task:task-uuid-456`;
    expect(evaluateWsSpawnCommandAccess(NON_OWNER, jid)).toEqual({
      dispatched: false,
      reason: 'access',
    });
  });

  test('owner on #agent: virtual JID is granted', () => {
    const jid = `${BASE_JID}#agent:agent-uuid-123`;
    expect(evaluateWsSpawnCommandAccess(OWNER, jid)).toEqual({
      dispatched: true,
    });
  });

  test('owner on #task: virtual JID is granted', () => {
    const jid = `${BASE_JID}#task:task-uuid-456`;
    expect(evaluateWsSpawnCommandAccess(OWNER, jid)).toEqual({
      dispatched: true,
    });
  });

  test('non-owner on bare base JID is denied', () => {
    expect(evaluateWsSpawnCommandAccess(NON_OWNER, BASE_JID)).toEqual({
      dispatched: false,
      reason: 'access',
    });
  });

  test('owner on bare base JID is granted', () => {
    expect(evaluateWsSpawnCommandAccess(OWNER, BASE_JID)).toEqual({
      dispatched: true,
    });
  });

  test('missing group (unknown base) is denied for non-owner and owner', () => {
    expect(evaluateWsSpawnCommandAccess(NON_OWNER, UNKNOWN_BASE_JID)).toEqual({
      dispatched: false,
      reason: 'access',
    });
    expect(evaluateWsSpawnCommandAccess(OWNER, UNKNOWN_BASE_JID)).toEqual({
      dispatched: false,
      reason: 'access',
    });
    expect(
      evaluateWsSpawnCommandAccess(
        OWNER,
        `${UNKNOWN_BASE_JID}#task:task-uuid-789`,
      ),
    ).toEqual({
      dispatched: false,
      reason: 'access',
    });
  });
});
