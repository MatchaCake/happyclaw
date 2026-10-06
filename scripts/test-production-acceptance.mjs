#!/usr/bin/env node
// Run only with an explicitly supplied, short-lived owner session. This creates
// disposable workspaces through the deployed API and removes only those IDs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = process.env.HAPPYCLAW_URL;
const cookieFile = process.env.HAPPYCLAW_ACCEPTANCE_COOKIE_FILE;
if (!base || !cookieFile) {
  throw new Error('Set HAPPYCLAW_URL and HAPPYCLAW_ACCEPTANCE_COOKIE_FILE');
}
const cookie = fs.readFileSync(cookieFile, 'utf8').trim();
const nonce = `ACCEPT_${Date.now().toString(36)}`;
const ownedWorkspaces = [];
const workspaceFolders = new Map();
const ownedTasks = [];
const ownedRuns = [];
const cases = [];
let profileId;
let ws;
const events = [];

async function api(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok)
    throw new Error(`${method} ${route}: HTTP ${response.status}`);
  return response.json();
}

async function waitUntil(predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Acceptance condition timed out');
}

function scopedEvents(jid, agentId, after) {
  return events
    .slice(after)
    .filter(
      (event) =>
        event.chatJid === jid && (event.agentId || undefined) === agentId,
    );
}

async function turn(jid, prompt, marker, agentId) {
  const after = events.length;
  const started = Date.now();
  ws.send(
    JSON.stringify({
      type: 'send_message',
      chatJid: jid,
      agentId,
      content: prompt,
    }),
  );
  await waitUntil(() =>
    scopedEvents(jid, agentId, after).some(
      (event) =>
        event.type === 'new_message' &&
        event.message?.is_from_me &&
        event.message.sender !== '__system__' &&
        event.message.content?.includes(marker),
    ),
  );
  const route = `/api/groups/${encodeURIComponent(jid)}/messages${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
  await waitUntil(async () => {
    const history = await api('GET', route);
    return history.messages.some(
      (message) => message.is_from_me && message.content?.includes(marker),
    );
  }, 15_000);
  const scoped = scopedEvents(jid, agentId, after);
  assert(
    scoped.some((event) => event.type === 'stream_event'),
    'Missing deployed streaming events',
  );
  cases.push({
    marker,
    passed: true,
    elapsedMs: Date.now() - started,
    streamEvents: scoped.filter((event) => event.type === 'stream_event')
      .length,
    toolEvents: scoped.filter(
      (event) => event.event?.eventType === 'tool_use_start',
    ).length,
  });
}

async function workspace(mode) {
  const created = await api('POST', '/api/groups', {
    name: `${nonce} ${mode}`,
    execution_mode: mode,
    agent_profile_id: profileId,
  });
  ownedWorkspaces.push(created.jid);
  workspaceFolders.set(created.jid, created.group.folder);
  assert.equal(created.group.execution_mode, mode);
  return created.jid;
}

async function verifyFile(jid, filename, expected) {
  const encoded = Buffer.from(filename).toString('base64url');
  const response = await api(
    'GET',
    `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`,
  );
  assert.equal(response.content.trim(), expected);
}

async function run() {
  const me = await api('GET', '/api/auth/me');
  assert.equal(me.user.role, 'admin', 'Use an authorized owner session');
  const created = await api('POST', '/api/agent-profiles', {
    name: nonce,
    prompt_schema_version: 2,
    prompt_mode: 'append',
    identity_prompt:
      'You are running an authorized HappyClaw acceptance test. Only work in the current disposable workspace. Follow exact output markers and use tools when requested.',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
  });
  profileId = created.profile.id;
  ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
    headers: { Cookie: cookie },
  });
  ws.on('message', (data) => {
    try {
      events.push(JSON.parse(data.toString()));
    } catch {
      /* ignore non-JSON heartbeats */
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  for (const mode of ['host', 'container']) {
    const jid = await workspace(mode);
    const marker = `${nonce}_${mode.toUpperCase()}_FILE`;
    await turn(
      jid,
      `Use a tool to create acceptance.txt in your current workspace containing exactly ${marker}. Read it back with a tool, then reply exactly ${marker}. Do not use any other directories.`,
      marker,
    );
    await verifyFile(jid, 'acceptance.txt', marker);
    const warm = `${nonce}_${mode.toUpperCase()}_WARM`;
    await turn(
      jid,
      `Read acceptance.txt with a tool and confirm it contains ${marker}. Then reply exactly ${warm}.`,
      warm,
    );
    const a = (
      await api('POST', `/api/groups/${encodeURIComponent(jid)}/sessions`, {
        name: 'Acceptance A',
      })
    ).session.id;
    const b = (
      await api('POST', `/api/groups/${encodeURIComponent(jid)}/sessions`, {
        name: 'Acceptance B',
      })
    ).session.id;
    await Promise.all([
      turn(
        jid,
        `Reply exactly ${nonce}_${mode}_SESSION_A`,
        `${nonce}_${mode}_SESSION_A`,
        a,
      ),
      turn(
        jid,
        `Reply exactly ${nonce}_${mode}_SESSION_B`,
        `${nonce}_${mode}_SESSION_B`,
        b,
      ),
    ]);
    const interruptAfter = events.length;
    ws.send(
      JSON.stringify({
        type: 'send_message',
        chatJid: jid,
        content:
          'Run Bash sleep 15 in the foreground. Wait until it finishes before replying.',
      }),
    );
    await waitUntil(() =>
      scopedEvents(jid, undefined, interruptAfter).some(
        (event) => event.event?.eventType === 'tool_use_start',
      ),
    );
    const interruptedMarker = `${nonce}_${mode}_INTERRUPT_FOLLOWUP`;
    const followup = turn(
      jid,
      `Reply exactly ${interruptedMarker}`,
      interruptedMarker,
    );
    // Wait for the durable receipt before interrupting the preceding query.
    await waitUntil(() =>
      scopedEvents(jid, undefined, interruptAfter).some(
        (event) =>
          event.type === 'new_message' &&
          !event.message?.is_from_me &&
          event.message?.content?.includes(interruptedMarker),
      ),
    );
    const interrupted = await api(
      'POST',
      `/api/groups/${encodeURIComponent(jid)}/interrupt`,
      {},
    );
    assert.equal(interrupted.interrupted, true);
    await followup;
    const taskMarker = `${nonce}_${mode}_SCHEDULED`;
    const task = await api('POST', '/api/tasks', {
      chat_jid: jid,
      group_folder: workspaceFolders.get(jid),
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      execution_type: 'agent',
      prompt: `Use a tool to write acceptance-scheduled.txt containing exactly ${taskMarker}, then reply exactly ${taskMarker}.`,
    });
    ownedTasks.push(task.taskId);
    const run = await api(
      'POST',
      `/api/tasks/${encodeURIComponent(task.taskId)}/runs`,
      { idempotency_key: nonce },
    );
    ownedRuns.push(run.runId);
    await waitUntil(async () => {
      const current = (
        await api('GET', `/api/tasks/runs/${encodeURIComponent(run.runId)}`)
      ).run;
      if (['failed', 'cancelled', 'missed'].includes(current.status))
        throw new Error(`Acceptance task status: ${current.status}`);
      return ['success', 'delivered'].includes(current.status);
    });
    await verifyFile(jid, 'acceptance-scheduled.txt', taskMarker);
    cases.push({ marker: taskMarker, passed: true, scheduler: true });
  }
  const host = ownedWorkspaces[0];
  const bg = `${nonce}_BACKGROUND_DONE`;
  await turn(
    host,
    `Run Bash with run_in_background=true to execute: sleep 2; printf '${bg}' > acceptance-background.txt. Wait for the actual background task completion notification, read acceptance-background.txt, and only then reply exactly ${bg}.`,
    bg,
  );
  await verifyFile(host, 'acceptance-background.txt', bg);
  console.log(JSON.stringify({ passed: true, cases }, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(
    JSON.stringify({ passed: false, error: error.message, cases }, null, 2),
  );
  process.exitCode = 1;
} finally {
  ws?.close();
  let cleanupFailed = false;
  for (const runId of ownedRuns) {
    try {
      const current = (
        await api('GET', `/api/tasks/runs/${encodeURIComponent(runId)}`)
      ).run;
      if (['queued', 'running', 'retry_wait'].includes(current.status)) {
        await api(
          'POST',
          `/api/tasks/runs/${encodeURIComponent(runId)}/cancel`,
          {},
        );
        await waitUntil(async () => {
          const run = (
            await api('GET', `/api/tasks/runs/${encodeURIComponent(runId)}`)
          ).run;
          return !['queued', 'running', 'retry_wait'].includes(run.status);
        }, 30_000);
      }
    } catch {
      cleanupFailed = true;
      console.error('Acceptance run cleanup failed');
    }
  }
  for (const taskId of ownedTasks) {
    try {
      const task = (await api('GET', '/api/tasks')).tasks.find(
        (item) => item.id === taskId,
      );
      assert(task, 'Acceptance task is missing');
      const deleted = await api(
        'DELETE',
        `/api/tasks/${encodeURIComponent(taskId)}?expected_revision=${task.revision}`,
      );
      await api('POST', '/api/tasks/purge', {
        tasks: [{ id: taskId, expected_revision: deleted.task.revision }],
      });
    } catch {
      cleanupFailed = true;
      console.error('Acceptance task cleanup failed');
    }
  }
  for (const jid of ownedWorkspaces.reverse()) {
    try {
      await api('DELETE', `/api/groups/${encodeURIComponent(jid)}`);
    } catch {
      cleanupFailed = true;
      console.error('Acceptance workspace cleanup failed');
    }
  }
  if (profileId && !cleanupFailed) {
    try {
      await api(
        'DELETE',
        `/api/agent-profiles/${encodeURIComponent(profileId)}`,
      );
    } catch {
      cleanupFailed = true;
      console.error('Acceptance profile cleanup failed');
    }
  }
  if (cleanupFailed) process.exitCode = 1;
}
