import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { StreamingBuffer } = await import('../src/streaming-buffer.js');

const directories: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // The assertion failure is the result we need; cleanup must not mask it.
    }
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('saveInterrupted SQLITE_BUSY', () => {
  test('keeps that jid buffer, inserts no row, and does not drop another jid buffer as part of the failure', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-streaming-buffer-busy-'),
    );
    const dbDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-streaming-buffer-busy-db-'),
    );
    directories.push(directory, dbDirectory);

    const dbPath = path.join(dbDirectory, 'messages.sqlite');
    const dbLock = new Database(dbPath);
    const dbWriter = new Database(dbPath);
    closers.push(
      () => dbLock.close(),
      () => dbWriter.close(),
    );
    dbLock.exec(
      'CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, content TEXT NOT NULL)',
    );
    dbLock.pragma('busy_timeout = 0');
    dbWriter.pragma('busy_timeout = 0');
    dbLock.exec('BEGIN IMMEDIATE');
    const insert = dbWriter.prepare(
      'INSERT INTO messages (id, jid, content) VALUES (?, ?, ?)',
    );

    let probeCode = '';
    try {
      insert.run('probe', 'web:busy', 'probe');
    } catch (error) {
      probeCode = String((error as { code?: string }).code ?? '');
    }
    expect(probeCode).toBe('SQLITE_BUSY');

    const busyJid = 'web:busy';
    const otherJid = 'web:other';
    const active = new Map<string, string>([
      [busyJid, 'partial busy'],
      [otherJid, 'partial other'],
    ]);
    const buffer = new StreamingBuffer(directory, {
      getActiveTexts: () => active,
      persistInterrupted: (jid, text) => {
        insert.run(`${jid}-recovered`, jid, text);
      },
    });
    buffer.flush();

    const fileFor = (jid: string) =>
      path.join(directory, `${Buffer.from(jid).toString('base64url')}.txt`);
    const busyFile = fileFor(busyJid);
    const otherFile = fileFor(otherJid);
    expect(fs.existsSync(busyFile)).toBe(true);
    expect(fs.existsSync(otherFile)).toBe(true);

    const saved: string[] = [];
    buffer.saveInterrupted(active, (jid, text) => {
      if (jid === busyJid) {
        insert.run(`${jid}-shutdown`, jid, text);
      }
      if (jid === otherJid) {
        // The busy failure must not have cleaned the sibling file first.
        expect(fs.existsSync(busyFile)).toBe(true);
        expect(fs.existsSync(otherFile)).toBe(true);
        saved.push(text);
      }
    });

    const busyRows = dbWriter
      .prepare('SELECT jid, content FROM messages WHERE jid = ?')
      .all(busyJid);

    expect({
      busyFile: fs.existsSync(busyFile),
      otherFile: fs.existsSync(otherFile),
      busyRows,
      saved,
    }).toEqual({
      busyFile: true,
      otherFile: false,
      busyRows: [],
      saved: ['partial other'],
    });

    dbLock.exec('ROLLBACK');
    buffer.recover();
    const replayed = dbWriter
      .prepare('SELECT content FROM messages WHERE jid = ?')
      .all(busyJid);
    expect(replayed).toEqual([{ content: 'partial busy' }]);
    expect(fs.existsSync(busyFile)).toBe(false);
    expect(fs.existsSync(otherFile)).toBe(false);
  });
});
