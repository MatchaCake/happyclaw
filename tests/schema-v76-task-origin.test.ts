import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v76-origin-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state VALUES ('schema_version', '75');
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    INSERT INTO registered_groups (jid, name, folder, added_at, created_by, is_home)
    VALUES ('web:legacy', 'Legacy Workspace', 'legacy-ws',
            '2026-09-01T00:00:00.000Z', 'legacy-owner', 0);
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       context_mode, next_run, status, created_at)
    VALUES
      ('legacy-task', 'legacy-ws', 'web:legacy',
       'daily report', 'cron', '0 9 * * *', 'isolated',
       '2026-09-02T01:00:00.000Z', 'active', '2026-09-01T00:00:00.000Z');
  `);
  legacy.close();
});

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v76 scheduled-task origin migration', () => {
  test('backfills legacy rows as user-authored and reaches head idempotently', () => {
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    // Every row written before the column existed came from a person (Web UI,
    // REST, or the schedule_task MCP tool acting on the user's behalf), which
    // is exactly the 'user' default.
    expect(db.getTaskById('legacy-task')?.origin).toBe('user');

    // Re-running initDatabase must not disturb the backfilled value.
    db.closeDatabase();
    db.initDatabase();
    expect(db.getTaskById('legacy-task')?.origin).toBe('user');
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });

  test('a run_background_task registration persists its agent provenance', () => {
    db.createTask({
      id: 'bg-task',
      group_folder: 'legacy-ws',
      chat_jid: 'web:legacy',
      prompt: 'crawl the docs site and summarize every page',
      schedule_type: 'once',
      schedule_value: '2026-09-03T10:00:00',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: '2026-09-03T02:00:00.000Z',
      status: 'active',
      created_at: '2026-09-03T01:59:00.000Z',
      notify_channels: null,
      origin: 'agent_background',
    } as Parameters<typeof db.createTask>[0]);

    expect(db.getTaskById('bg-task')?.origin).toBe('agent_background');

    // A caller that does not state provenance stays user-authored.
    db.createTask({
      id: 'plain-task',
      group_folder: 'legacy-ws',
      chat_jid: 'web:legacy',
      prompt: 'weekly digest',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: '2026-09-08T01:00:00.000Z',
      status: 'active',
      created_at: '2026-09-03T02:00:00.000Z',
      notify_channels: null,
    } as Parameters<typeof db.createTask>[0]);

    expect(db.getTaskById('plain-task')?.origin).toBe('user');
  });
});
