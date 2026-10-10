import { afterEach, describe, expect, test } from 'vitest';

import {
  createDurableTaskDispatchGuard,
  isDurableTaskDispatchEnabled,
} from '../container/agent-runner/src/durable-task-dispatch-guard.js';

const ENV_KEY = 'HAPPYCLAW_DURABLE_TASK_DISPATCH';

afterEach(() => {
  delete process.env[ENV_KEY];
});

function hookInput(patch: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t',
    cwd: '/tmp',
    tool_name: 'Task',
    tool_input: {
      description: 'long research',
      prompt: 'research the thing',
      subagent_type: 'general-purpose',
    },
    tool_use_id: 'tool-1',
    ...patch,
  };
}

async function run(
  guard: ReturnType<typeof createDurableTaskDispatchGuard>,
  input: Record<string, unknown>,
) {
  return guard(input as never, 'tool-1', {
    signal: new AbortController().signal,
  });
}

describe('isDurableTaskDispatchEnabled', () => {
  test('only the value "redirect" enables the guard', () => {
    expect(isDurableTaskDispatchEnabled({})).toBe(false);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: undefined })).toBe(false);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: '' })).toBe(false);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: 'off' })).toBe(false);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: 'true' })).toBe(false);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: '1' })).toBe(false);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: 'redirect' })).toBe(true);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: 'Redirect' })).toBe(true);
    expect(isDurableTaskDispatchEnabled({ [ENV_KEY]: ' REDIRECT ' })).toBe(
      true,
    );
  });

  test('defaults to process.env', () => {
    delete process.env[ENV_KEY];
    expect(isDurableTaskDispatchEnabled()).toBe(false);
    process.env[ENV_KEY] = 'redirect';
    expect(isDurableTaskDispatchEnabled()).toBe(true);
  });
});

describe('createDurableTaskDispatchGuard', () => {
  test('disabled by default: background Task dispatch passes through', async () => {
    delete process.env[ENV_KEY];
    const guard = createDurableTaskDispatchGuard();
    await expect(run(guard, hookInput())).resolves.toEqual({});
    await expect(
      run(guard, hookInput({ tool_input: { run_in_background: true } })),
    ).resolves.toEqual({});
  });

  test('enabled: denies main-thread Task with default (background) dispatch', async () => {
    process.env[ENV_KEY] = 'redirect';
    const guard = createDurableTaskDispatchGuard();
    for (const input of [
      hookInput(),
      hookInput({
        tool_input: { prompt: 'work', run_in_background: true },
      }),
    ]) {
      const result = await run(guard, input);
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      });
      const reason = (
        result as {
          hookSpecificOutput: { permissionDecisionReason: string };
        }
      ).hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain('run_background_task');
      expect(reason).toContain('run_in_background: false');
    }
  });

  test('enabled: allows a declared in-turn helper (run_in_background: false)', async () => {
    process.env[ENV_KEY] = 'redirect';
    const guard = createDurableTaskDispatchGuard();
    await expect(
      run(
        guard,
        hookInput({
          tool_input: { prompt: 'quick parallel', run_in_background: false },
        }),
      ),
    ).resolves.toEqual({});
  });

  test('enabled: ignores sub-agent Task calls and non-Task tools', async () => {
    process.env[ENV_KEY] = 'redirect';
    const guard = createDurableTaskDispatchGuard();
    await expect(
      run(guard, hookInput({ agent_id: 'sdk-subagent-1' })),
    ).resolves.toEqual({});
    await expect(
      run(
        guard,
        hookInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      ),
    ).resolves.toEqual({});
    await expect(
      run(
        guard,
        hookInput({ tool_name: 'mcp__happyclaw__run_background_task' }),
      ),
    ).resolves.toEqual({});
  });

  test("enabled: 'Agent' tool name behaves like 'Task'", async () => {
    process.env[ENV_KEY] = 'redirect';
    const guard = createDurableTaskDispatchGuard();
    const denied = await run(guard, hookInput({ tool_name: 'Agent' }));
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    await expect(
      run(
        guard,
        hookInput({
          tool_name: 'Agent',
          tool_input: { run_in_background: false },
        }),
      ),
    ).resolves.toEqual({});
  });
});
