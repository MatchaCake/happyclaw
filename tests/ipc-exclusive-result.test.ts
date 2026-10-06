import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { writeExclusiveIpcResult } from '../src/ipc-exclusive-result.js';

const tempDirs: string[] = [];
const nativePlatform = process.platform;
const adapters =
  nativePlatform === 'linux' ? ['linux', 'darwin'] : [nativePlatform];

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: nativePlatform });
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-result-'));
  tempDirs.push(dir);
  return dir;
}

describe.each(adapters)('writeExclusiveIpcResult (%s adapter)', (adapter) => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: adapter });
  });
  test('does not replace a planted predictable temp file and writes a regular result', () => {
    const tasksRoot = tempDir();
    const resultFilePath = path.join(tasksRoot, 'list_tasks_result_req.json');
    const planted = `${resultFilePath}.tmp`;
    fs.writeFileSync(planted, 'SENTINEL');

    writeExclusiveIpcResult(tasksRoot, resultFilePath, '{"success":true}');

    expect(fs.readFileSync(planted, 'utf8')).toBe('SENTINEL');
    const stat = fs.lstatSync(resultFilePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(resultFilePath, 'utf8')).toBe('{"success":true}');
  });

  test('does not follow a planted symlink at the predictable temp path', () => {
    const tasksRoot = tempDir();
    const sentinelFile = path.join(tempDir(), 'secret');
    fs.writeFileSync(sentinelFile, 'SENTINEL');
    const resultFilePath = path.join(
      tasksRoot,
      'install_skill_result_req.json',
    );
    fs.symlinkSync(sentinelFile, `${resultFilePath}.tmp`);

    writeExclusiveIpcResult(tasksRoot, resultFilePath, '{"success":true}');

    expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('SENTINEL');
    expect(fs.lstatSync(`${resultFilePath}.tmp`).isSymbolicLink()).toBe(true);
    const stat = fs.lstatSync(resultFilePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(resultFilePath, 'utf8')).toBe('{"success":true}');
  });

  test('refuses a symlinked parent directory under the ipc tasks root', () => {
    const tasksRoot = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'keep'), 'SENTINEL');
    fs.symlinkSync(outside, path.join(tasksRoot, 'linked'));
    const resultFilePath = path.join(
      tasksRoot,
      'linked',
      'uninstall_skill_result_req.json',
    );

    expect(() =>
      writeExclusiveIpcResult(tasksRoot, resultFilePath, '{"success":true}'),
    ).toThrow(/symlink/i);
    expect(fs.readdirSync(outside).sort()).toEqual(['keep']);
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe(
      'SENTINEL',
    );
  });

  test('refuses when the ipc tasks directory itself is a symlink', () => {
    const parent = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'keep'), 'SENTINEL');
    const tasksRoot = path.join(parent, 'tasks');
    fs.symlinkSync(outside, tasksRoot);
    const resultFilePath = path.join(
      tasksRoot,
      'discord_get_history_result_req.json',
    );

    expect(() =>
      writeExclusiveIpcResult(tasksRoot, resultFilePath, '{"success":true}'),
    ).toThrow(/symlink/i);
    expect(fs.readdirSync(outside).sort()).toEqual(['keep']);
  });

  test('writes a regular file through a real nested directory', () => {
    const tasksRoot = tempDir();
    const nested = path.join(tasksRoot, 'nested', 'deeper');
    fs.mkdirSync(nested, { recursive: true });
    const resultFilePath = path.join(nested, 'list_tasks_result_req.json');

    writeExclusiveIpcResult(tasksRoot, resultFilePath, '{"success":true}');

    const stat = fs.lstatSync(resultFilePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(resultFilePath, 'utf8')).toBe('{"success":true}');
  });
});

describe.each(adapters)('rooted IPC result races (%s adapter)', (adapter) => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: adapter });
  });

  test.each(['symlink', 'hardlink'])(
    'replaces a planted final %s without touching its target',
    (kind) => {
      const tasksRoot = tempDir();
      const sentinel = path.join(tempDir(), 'secret');
      const result = path.join(tasksRoot, 'list_tasks_result_req.json');
      fs.writeFileSync(sentinel, 'SENTINEL');
      if (kind === 'symlink') fs.symlinkSync(sentinel, result);
      else fs.linkSync(sentinel, result);
      writeExclusiveIpcResult(tasksRoot, result, '{"success":true}');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('SENTINEL');
      expect(fs.lstatSync(result).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(result, 'utf8')).toBe('{"success":true}');
      expect(fs.statSync(result).mode & 0o777).toBe(0o600);
    },
  );

  test('pins the original root when its pathname is switched to an outside symlink', () => {
    const parent = tempDir();
    const tasksRoot = path.join(parent, 'tasks');
    const pinned = path.join(parent, 'pinned');
    const outside = tempDir();
    const name = 'list_tasks_result_req.json';
    fs.mkdirSync(tasksRoot);
    fs.writeFileSync(path.join(outside, name), 'SENTINEL');
    const open = fs.openSync;
    let switched = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const fd = open(...args);
      if (!switched && args[0] === tasksRoot) {
        switched = true;
        fs.renameSync(tasksRoot, pinned);
        fs.symlinkSync(outside, tasksRoot);
      }
      return fd;
    });
    writeExclusiveIpcResult(tasksRoot, path.join(tasksRoot, name), 'RESULT');
    expect(switched).toBe(true);
    expect(fs.readFileSync(path.join(outside, name), 'utf8')).toBe('SENTINEL');
    expect(fs.readFileSync(path.join(pinned, name), 'utf8')).toBe('RESULT');
  });

  test('rejects results outside the tasks root', () => {
    const root = tempDir();
    const outside = tempDir();
    expect(() =>
      writeExclusiveIpcResult(
        root,
        path.join(outside, 'result.json'),
        'RESULT',
      ),
    ).toThrow(/escapes/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('does not unlink a collided exclusive temp owned by someone else', () => {
    const root = tempDir();
    const name = 'list_tasks_result_req.json';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-0000-0000-000000000000',
    );
    const temp = path.join(
      root,
      `.${name}.${process.pid}.00000000-0000-0000-0000-000000000000.tmp`,
    );
    fs.writeFileSync(temp, 'SENTINEL');
    expect(() =>
      writeExclusiveIpcResult(root, path.join(root, name), 'RESULT'),
    ).toThrow();
    expect(fs.readFileSync(temp, 'utf8')).toBe('SENTINEL');
    expect(fs.existsSync(path.join(root, name))).toBe(false);
  });

  test('cleans its exclusive temp after the final rename fails', () => {
    const root = tempDir();
    const name = 'list_tasks_result_req.json';
    fs.mkdirSync(path.join(root, name));
    expect(() =>
      writeExclusiveIpcResult(root, path.join(root, name), 'RESULT'),
    ).toThrow();
    expect(fs.readdirSync(root)).toEqual([name]);
    expect(fs.statSync(path.join(root, name)).isDirectory()).toBe(true);
  });

  test('concurrent nested directory switching never writes outside the pinned root', async () => {
    const root = tempDir();
    const outside = tempDir();
    const nested = path.join(root, 'nested');
    const held = path.join(root, 'held');
    const name = 'list_tasks_result_req.json';
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(outside, name), 'SENTINEL');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const [nested, held, outside] = process.argv.slice(1);
      let linked = false;
      const flip = () => {
        if (!linked) { fs.renameSync(nested, held); fs.symlinkSync(outside, nested); }
        else { fs.unlinkSync(nested); fs.renameSync(held, nested); }
        linked = !linked;
      };
      const timer = setInterval(flip, 1);
      process.on('message', () => { clearInterval(timer); if (linked) flip(); process.exit(0); });
      process.send('ready');
    `,
        nested,
        held,
        outside,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const errors: string[] = [];
    child.stderr!.on('data', (chunk) => errors.push(String(chunk)));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
      });
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          writeExclusiveIpcResult(
            root,
            path.join(nested, name),
            `RESULT ${attempt}`,
          );
        } catch {
          // A symlink/missing-name refusal is the expected safe race outcome.
        }
      }
    } finally {
      child.send('stop');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    expect(errors).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([name]);
    expect(fs.readFileSync(path.join(outside, name), 'utf8')).toBe('SENTINEL');
  });
});
