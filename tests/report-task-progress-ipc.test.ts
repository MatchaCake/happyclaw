import { describe, expect, test, vi } from 'vitest';

import { extractDurableTaskRunIdFromNamespace } from '../src/isolated-task-ipc.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

// Valid durable run id for the task-run-<uuid>-attempt-<n> namespace shape.
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NAMESPACE = `task-run-${RUN_ID}-attempt-1`;

// Use the real production resolver so the test exercises the actual trust
// boundary (isolated-only, workspace ownership, payload runId consistency)
// instead of a permissive stand-in.
const schedulerGlobals: Record<string, unknown> = {};
const schedulerHarness = createRuntimeSourceHarness(
  schedulerGlobals,
  new URL('../src/task-scheduler.ts', import.meta.url),
);
schedulerHarness.install('SCHEDULED_GROUP_PROMPT_ID_PREFIX');
schedulerHarness.install('scheduledGroupRunIdFromPromptMessageId');
schedulerHarness.install('resolveScheduledTaskIpcRunId');

interface WrittenResult {
  type: string;
  requestId: string | undefined;
  payload: Record<string, unknown>;
}

function setup(options: { runStatus?: 'running' | 'success' } = {}) {
  const run = {
    id: RUN_ID,
    task_id: 'task-1',
    status: options.runStatus ?? 'running',
    definition_snapshot: {
      context_mode: 'isolated',
      group_folder: 'ws',
      chat_jid: 'web:ws',
    },
  };
  const results: WrittenResult[] = [];
  const updateTaskRunProgress = vi.fn(
    (runId: string) => runId === RUN_ID && run.status === 'running',
  );
  const globals: Record<string, unknown> = {
    resolveScheduledTaskIpcRunId: schedulerGlobals.resolveScheduledTaskIpcRunId,
    extractDurableTaskRunIdFromNamespace,
    getTaskRunById: (id: string) => (id === RUN_ID ? run : undefined),
    updateTaskRunProgress,
    getUserHomeGroup: () => undefined,
    resolveBroadcastFolder: () => 'ws',
    canAccessGroup: () => true,
    registeredGroups: {},
    getRegisteredGroup: () => undefined,
    getUserById: () => undefined,
    writeTaskResult: (
      _dir: string,
      type: string,
      requestId: string | undefined,
      payload: Record<string, unknown>,
    ) => {
      results.push({ type, requestId, payload });
    },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('processTaskIpc');
  const dispatch = (
    data: Record<string, unknown>,
    ipcTaskId: string | null,
  ): Promise<void> =>
    (globals.processTaskIpc as (...args: unknown[]) => Promise<void>)(
      data,
      'ws',
      false,
      false,
      undefined,
      '/nonexistent/tasks',
      null,
      ipcTaskId,
    );
  return { dispatch, results, updateTaskRunProgress, run };
}

describe('report_task_progress host IPC handler', () => {
  test('rejects requests outside an isolated durable task-run namespace', async () => {
    const { dispatch, results, updateTaskRunProgress } = setup();
    await dispatch(
      { type: 'report_task_progress', requestId: 'r1', summary: 'hi' },
      null,
    );
    expect(results).toEqual([
      {
        type: 'report_task_progress',
        requestId: 'r1',
        payload: {
          success: false,
          error:
            'Progress reporting is only available inside a background/scheduled task run.',
        },
      },
    ]);
    expect(updateTaskRunProgress).not.toHaveBeenCalled();
  });

  test('ignores a forged payload run id that contradicts the namespace', async () => {
    const { dispatch, results, updateTaskRunProgress } = setup();
    await dispatch(
      {
        type: 'report_task_progress',
        requestId: 'r2',
        summary: 'hi',
        scheduledTaskRunId: '22222222-2222-4222-8222-222222222222',
      },
      NAMESPACE,
    );
    expect(results[0].payload.success).toBe(false);
    expect(updateTaskRunProgress).not.toHaveBeenCalled();
  });

  test('updates a running run and truncates the summary to 300 chars', async () => {
    const { dispatch, results, updateTaskRunProgress } = setup();
    await dispatch(
      {
        type: 'report_task_progress',
        requestId: 'r3',
        summary: `  ${'x'.repeat(400)}  `,
        percent: 42,
      },
      NAMESPACE,
    );
    expect(updateTaskRunProgress).toHaveBeenCalledWith(RUN_ID, {
      summary: 'x'.repeat(300),
      percent: 42,
    });
    expect(results).toEqual([
      {
        type: 'report_task_progress',
        requestId: 'r3',
        payload: { success: true, updated: true },
      },
    ]);
  });

  test('a finished run yields success with updated:false', async () => {
    const { dispatch, results } = setup({ runStatus: 'success' });
    await dispatch(
      { type: 'report_task_progress', requestId: 'r4', summary: 'late' },
      NAMESPACE,
    );
    // The resolver only accepts isolated runs owned by this workspace; status
    // is the db guard's concern, so the write is attempted and reported back
    // as not updated.
    expect(results).toEqual([
      {
        type: 'report_task_progress',
        requestId: 'r4',
        payload: { success: true, updated: false },
      },
    ]);
  });

  test('rejects an empty summary inside a valid namespace', async () => {
    const { dispatch, results, updateTaskRunProgress } = setup();
    await dispatch(
      { type: 'report_task_progress', requestId: 'r5', summary: '   ' },
      NAMESPACE,
    );
    expect(results[0].payload).toEqual({
      success: false,
      error: 'summary must be a non-empty string.',
    });
    expect(updateTaskRunProgress).not.toHaveBeenCalled();
  });
});
