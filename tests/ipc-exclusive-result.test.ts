import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { writeExclusiveIpcResult } from '../src/ipc-exclusive-result.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-result-'));
  tempDirs.push(dir);
  return dir;
}

describe('writeExclusiveIpcResult', () => {
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
