import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v77-progress-'));
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

const SNAPSHOT = JSON.stringify({
  prompt: 'long background job',
  group_folder: 'legacy-ws',
  chat_jid: 'web:legacy',
  delivery_route_jid: 'web:legacy',
  context_mode: 'isolated',
  execution_type: 'agent',
  execution_mode: 'container',
  script_command: null,
  notify_channels: null,
});

beforeAll(() => {
  const legacy = new Database(databasePath);
  // Exact v76 shape of the tables this migration touches: task_runs has every
  // pre-v77 column (the startup CREATE INDEX statements reference them before
  // ensureColumn runs) but none of the three progress columns.
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state VALUES ('schema_version', '76');
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
       'long background job', 'once', '2026-09-02T01:00:00',
       'isolated', NULL, 'active', '2026-09-01T00:00:00.000Z');
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_type TEXT NOT NULL,
      idempotency_key TEXT,
      scheduled_for TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      definition_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      notification_status TEXT NOT NULL DEFAULT 'pending',
      notification_error TEXT,
      notification_summary TEXT,
      notification_payload TEXT,
      notification_attempt INTEGER NOT NULL DEFAULT 0,
      notification_available_at TEXT,
      notification_lease_owner TEXT,
      notification_lease_token INTEGER NOT NULL DEFAULT 0,
      notification_lease_expires_at TEXT,
      notification_lease_payload TEXT,
      notification_generation INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    INSERT INTO task_runs
      (id, task_id, occurrence_key, trigger_type, scheduled_for,
       definition_revision, definition_snapshot, status, attempt,
       available_at, lease_owner, lease_token, lease_expires_at,
       started_at, created_at, updated_at)
    VALUES
      ('run-running', 'legacy-task', 'occ-running', 'manual',
       '2026-09-02T01:00:00.000Z', 1, '${SNAPSHOT}', 'running', 1,
       '2026-09-02T01:00:00.000Z', 'worker-1', 1, '2099-01-01T00:00:00.000Z',
       '2026-09-02T01:00:01.000Z', '2026-09-02T01:00:00.000Z',
       '2026-09-02T01:00:01.000Z');
    INSERT INTO task_runs
      (id, task_id, occurrence_key, trigger_type, scheduled_for,
       definition_revision, definition_snapshot, status, attempt,
       available_at, completed_at, created_at, updated_at)
    VALUES
      ('run-finished', 'legacy-task', 'occ-finished', 'manual',
       '2026-09-01T01:00:00.000Z', 1, '${SNAPSHOT}', 'success', 1,
       '2026-09-01T01:00:00.000Z', '2026-09-01T01:05:00.000Z',
       '2026-09-01T01:00:00.000Z', '2026-09-01T01:05:00.000Z');
  `);
  legacy.close();
});

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v77 task-run progress migration', () => {
  test('adds nullable progress columns and reaches head idempotently', () => {
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    // Legacy rows never reported progress, so NULL is the accurate backfill.
    const running = db.getTaskRunById('run-running')!;
    expect(running.progress_summary).toBeNull();
    expect(running.progress_percent).toBeNull();
    expect(running.progress_updated_at).toBeNull();

    // Re-running initDatabase must be a no-op.
    db.closeDatabase();
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getTaskRunById('run-running')?.progress_summary).toBeNull();
  });

  test('updateTaskRunProgress overwrites the snapshot only while running', () => {
    expect(
      db.updateTaskRunProgress('run-running', {
        summary: 'Crawled 40/120 pages',
        percent: 33,
      }),
    ).toBe(true);
    let run = db.getTaskRunById('run-running')!;
    expect(run.progress_summary).toBe('Crawled 40/120 pages');
    expect(run.progress_percent).toBe(33);
    expect(run.progress_updated_at).toBeTruthy();

    // Overwrite semantics: the latest call wins; percent may be omitted.
    expect(
      db.updateTaskRunProgress('run-running', { summary: 'Summarizing' }),
    ).toBe(true);
    run = db.getTaskRunById('run-running')!;
    expect(run.progress_summary).toBe('Summarizing');
    expect(run.progress_percent).toBeNull();

    // A finished run drops the report and keeps its (empty) snapshot.
    expect(
      db.updateTaskRunProgress('run-finished', { summary: 'late', percent: 1 }),
    ).toBe(false);
    expect(db.getTaskRunById('run-finished')?.progress_summary).toBeNull();
  });

  test('retry release and the next claim both clear stale progress', () => {
    // releaseTaskRunForRetry: the retry_wait row must not show old progress.
    expect(
      db.releaseTaskRunForRetry(
        'run-running',
        'worker-1',
        1,
        '2026-09-02T01:00:02.000Z',
        'transient failure',
      ),
    ).toBe(true);
    let run = db.getTaskRunById('run-running')!;
    expect(run.status).toBe('retry_wait');
    expect(run.progress_summary).toBeNull();
    expect(run.progress_percent).toBeNull();
    expect(run.progress_updated_at).toBeNull();

    // Simulate a stale snapshot surviving on disk, then claim a new attempt:
    // the claim itself must wipe it so attempt N+1 starts clean.
    const raw = new Database(databasePath);
    raw
      .prepare(
        `UPDATE task_runs
         SET progress_summary = 'stale', progress_percent = 99,
             progress_updated_at = '2026-09-02T01:00:03.000Z'
         WHERE id = 'run-running'`,
      )
      .run();
    raw.close();

    const claimed = db.claimNextTaskRun('worker-2', 60_000);
    expect(claimed?.id).toBe('run-running');
    run = db.getTaskRunById('run-running')!;
    expect(run.status).toBe('running');
    expect(run.progress_summary).toBeNull();
    expect(run.progress_percent).toBeNull();
    expect(run.progress_updated_at).toBeNull();
  });
});
