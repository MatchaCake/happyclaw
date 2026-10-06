// Run after npm run build, including on the deployed Mac mini.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeExclusiveIpcResult } from '../dist/ipc-exclusive-result.js';

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-ipc-portability-'),
);
let checks = 0;
try {
  const root = path.join(directory, 'tasks');
  const outside = path.join(directory, 'outside');
  const nested = path.join(root, 'nested');
  const held = path.join(root, 'held');
  const name = 'list_tasks_result_req.json';
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, name);
  fs.writeFileSync(sentinel, 'SENTINEL');
  const result = path.join(nested, name);
  fs.symlinkSync(sentinel, `${result}.tmp`);
  fs.symlinkSync(sentinel, result);
  writeExclusiveIpcResult(root, result, '{"success":true}');
  assert.equal(fs.readFileSync(result, 'utf8'), '{"success":true}');
  assert.equal(fs.lstatSync(result).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SENTINEL');
  checks++;

  const linked = path.join(root, 'linked');
  fs.symlinkSync(outside, linked);
  assert.throws(
    () => writeExclusiveIpcResult(root, path.join(linked, name), 'BAD'),
    /symlink/i,
  );
  assert.throws(
    () => writeExclusiveIpcResult(linked, path.join(linked, name), 'BAD'),
    /symlink/i,
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SENTINEL');
  checks++;

  const badResult = path.join(root, 'directory-result.json');
  fs.mkdirSync(badResult);
  assert.throws(() => writeExclusiveIpcResult(root, badResult, 'BAD'));
  assert.equal(
    fs.readdirSync(root).some((file) => file.endsWith('.tmp')),
    false,
  );
  checks++;

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
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(String(chunk)));
  try {
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        writeExclusiveIpcResult(root, result, `RESULT ${attempt}`);
      } catch {
        /* A switched/missing directory must fail closed. */
      }
    }
  } finally {
    child.send('stop');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(fs.readdirSync(outside), [name]);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SENTINEL');
  checks++;
  console.log(
    JSON.stringify({ platform: process.platform, checks, status: 'passed' }),
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
