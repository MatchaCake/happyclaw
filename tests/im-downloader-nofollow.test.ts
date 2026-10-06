import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GROUPS_DIR } from '../src/config.js';
import { saveDownloadedFile } from '../src/im-downloader.js';

describe('saveDownloadedFile date-directory symlink', () => {
  const created: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const target of created.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('refuses a planted date-dir symlink that points at a host directory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T03:00:00.000Z'));
    const dateStr = '2026-10-05';
    const groupFolder = `im-dl-nofollow-${process.pid}-${Date.now()}`;
    const groupRoot = path.join(GROUPS_DIR, groupFolder);
    const hostTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'im-dl-host-'));
    created.push(groupRoot, hostTarget);

    const channelDir = path.join(groupRoot, 'downloads', 'telegram');
    fs.mkdirSync(channelDir, { recursive: true });
    fs.symlinkSync(hostTarget, path.join(channelDir, dateStr));

    const filename = 'planted-outside.bin';
    await expect(
      saveDownloadedFile(
        groupFolder,
        'telegram',
        filename,
        Buffer.from('secret-bytes'),
      ),
    ).rejects.toThrow(/outside the group workspace/);

    expect(fs.readdirSync(hostTarget)).not.toContain(filename);
    expect(fs.existsSync(path.join(hostTarget, filename))).toBe(false);
  });

  test('still writes a normal download inside the group workspace', async () => {
    const groupFolder = `im-dl-real-${process.pid}-${Date.now()}`;
    const groupRoot = path.join(GROUPS_DIR, groupFolder);
    created.push(groupRoot);

    const rel = await saveDownloadedFile(
      groupFolder,
      'telegram',
      'note.txt',
      Buffer.from('ok'),
    );

    expect(rel).toMatch(/^downloads\/telegram\/\d{4}-\d{2}-\d{2}\/note\.txt$/);
    const abs = path.join(groupRoot, rel);
    const inside = path.relative(
      fs.realpathSync(groupRoot),
      fs.realpathSync(abs),
    );
    expect(
      inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside)),
    ).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('ok');
  });
});
