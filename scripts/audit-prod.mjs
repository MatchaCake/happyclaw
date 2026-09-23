import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_ADVISORIES = new Set();

const workspaces = [
  { label: 'root', cwd: root },
  { label: 'web', cwd: path.join(root, 'web') },
  { label: 'agent-runner', cwd: path.join(root, 'container/agent-runner') },
];

function advisoryIds(report) {
  const ids = new Set();
  const vulns = report?.vulnerabilities;
  if (!vulns || typeof vulns !== 'object') return ids;
  for (const entry of Object.values(vulns)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    for (const item of via) {
      if (typeof item === 'string' && item.startsWith('GHSA-')) ids.add(item);
      if (item && typeof item === 'object') {
        const url = typeof item.url === 'string' ? item.url : '';
        const match = url.match(/GHSA-[a-z0-9-]+/i);
        if (match) ids.add(match[0]);
        if (
          typeof item.source === 'string' &&
          item.source.startsWith('GHSA-')
        ) {
          ids.add(item.source);
        }
      }
    }
  }
  return ids;
}

let failed = false;
for (const workspace of workspaces) {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: workspace.cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    console.error(
      `[${workspace.label}] npm audit failed to start:`,
      result.error,
    );
    failed = true;
    continue;
  }
  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch (err) {
    console.error(`[${workspace.label}] npm audit JSON parse failed:`, err);
    console.error(result.stdout);
    console.error(result.stderr);
    failed = true;
    continue;
  }
  const ids = advisoryIds(report);
  const unexpected = [...ids].filter((id) => !ALLOWED_ADVISORIES.has(id));
  const allowed = [...ids].filter((id) => ALLOWED_ADVISORIES.has(id));
  if (allowed.length > 0) {
    console.warn(
      `[${workspace.label}] allowing unpatched production advisories: ${allowed.join(', ')}`,
    );
  }
  if (unexpected.length > 0) {
    console.error(
      `[${workspace.label}] production audit failed: ${unexpected.join(', ')}`,
    );
    failed = true;
  } else if (ids.size === 0 && result.status !== 0) {
    console.error(`[${workspace.label}] npm audit exited ${result.status}`);
    console.error(result.stderr || result.stdout);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('Production dependency audit passed.');
