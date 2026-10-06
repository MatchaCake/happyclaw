import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const harnessPath = path.join(
  repositoryRoot,
  'tests',
  'safe-git-proxy-tunnel-error.harness.ts',
);
const tsxCli = path.join(
  repositoryRoot,
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
);

function runHarness(scenario: string) {
  const result = spawnSync(process.execPath, [tsxCli, harnessPath], {
    cwd: repositoryRoot,
    env: { ...process.env, SCENARIO: scenario, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

describe('startPinnedHttpsProxy CONNECT tunnel socket errors', () => {
  test('survives an upstream ECONNRESET mid-tunnel and still closes', () => {
    const { status, output } = runHarness('upstream-reset');
    expect(output).not.toMatch(/UNCAUGHT/);
    expect(status, output).toBe(0);
    expect(output).toMatch(/ALIVE upstream-reset/);
    expect(output).toMatch(/PROXY_CLOSED/);
    expect(output).toMatch(/\bPASS\b/);
  });

  test('survives a client reset while DNS resolution is pending', () => {
    const { status, output } = runHarness('client-reset-during-resolve');
    expect(output).not.toMatch(/UNCAUGHT/);
    expect(status, output).toBe(0);
    expect(output).toMatch(/ALIVE client-reset-during-resolve/);
    expect(output).toMatch(/PROXY_CLOSED/);
    expect(output).toMatch(/\bPASS\b/);
  });
});
