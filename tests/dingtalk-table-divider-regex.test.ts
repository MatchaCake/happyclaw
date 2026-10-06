import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { ensureTableBlankLines } from '../src/dingtalk-streaming-card.js';

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'src', 'dingtalk-streaming-card.ts'),
).href;

// A table row followed by a long run of dashes and a non-divider tail.
// With the old divider regex this backtracks exponentially.
const ATTACK_TEXT = `intro\na | b\n${'-'.repeat(40)} end`;

describe('ensureTableBlankLines table divider regex', () => {
  test('40-dash non-divider line after a table row completes quickly', () => {
    // Run in a child process so a catastrophic-backtracking regression
    // is killed by the timeout instead of freezing the test runner.
    const script = `
      const { ensureTableBlankLines } = await import(${JSON.stringify(moduleUrl)});
      const text = ${JSON.stringify(ATTACK_TEXT)};
      const start = process.hrtime.bigint();
      const out = ensureTableBlankLines(text);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // The real logger's pino transport delays a normal exit by seconds;
      // the result is flushed, so hard-kill instead of waiting for it.
      process.stdout.write(JSON.stringify({ ms, out }) + '\\n', () =>
        process.kill(process.pid, 'SIGKILL'),
      );
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 },
    );
    // A timeout surfaces as ETIMEDOUT; the child otherwise ends itself
    // with SIGKILL right after printing its result.
    expect(child.error?.message ?? null).toBeNull();
    expect(child.stderr).toBe('');
    const result = JSON.parse(child.stdout.trim().split('\n').pop()!);
    expect(result.ms).toBeLessThan(200);
    expect(result.out).toBe(ATTACK_TEXT);
  }, 30_000);

  test('long whitespace and dash attacks remain bounded in a child process', () => {
    const script = `
      const { ensureTableBlankLines } = await import(${JSON.stringify(moduleUrl)});
      const lines = [
        '---' + ' '.repeat(128000) + 'x',
        ' '.repeat(128000) + 'x',
        '-'.repeat(128000) + ' end',
        '|' + ' '.repeat(128000) + 'x',
      ];
      const start = process.hrtime.bigint();
      const unchanged = lines.every(line => {
        const text = 'intro\\na | b\\n' + line;
        return ensureTableBlankLines(text) === text;
      });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      process.stdout.write(JSON.stringify({ ms, unchanged }) + '\\n', () =>
        process.kill(process.pid, 'SIGKILL'),
      );
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 },
    );
    expect(child.error?.message ?? null).toBeNull();
    expect(child.stderr).toBe('');
    const result = JSON.parse(child.stdout.trim().split('\n').pop()!);
    expect(result.unchanged).toBe(true);
    expect(result.ms).toBeLessThan(200);
  }, 30_000);

  const header = 'para\nh1 | h2';
  const inserted = (divider: string) =>
    ensureTableBlankLines(`${header}\n${divider}`) ===
    `para\n\nh1 | h2\n${divider}`;

  test.each(['|---|', '|---|---|', '---|---', '| :--- | ---: |', '--', '---'])(
    'divider %j is recognised',
    (divider) => {
      expect(inserted(divider)).toBe(true);
    },
  );

  test.each(['a|b', '|-a-|', '---- end', '--- ---', '---:-', '|||', ''])(
    'non-divider %j is not treated as a divider',
    (line) => {
      expect(inserted(line)).toBe(false);
      expect(ensureTableBlankLines(`${header}\n${line}`)).toBe(
        `${header}\n${line}`,
      );
    },
  );

  test('blank line still inserted before a table that follows a paragraph', () => {
    const input = [
      'Here is a table:',
      '| Name | Value |',
      '| --- | ---: |',
      '| a | 1 |',
    ].join('\n');
    expect(ensureTableBlankLines(input)).toBe(
      [
        'Here is a table:',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| a | 1 |',
      ].join('\n'),
    );
  });

  test('no extra blank line when table already separated or at start', () => {
    const separated = 'para\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(ensureTableBlankLines(separated)).toBe(separated);
    const atStart = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(ensureTableBlankLines(atStart)).toBe(atStart);
  });
});
