import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from '../src/agent-output-parser.js';
import type {
  AgentRunner,
  ContainerInput,
  ContainerOutput,
} from '../src/container-runner.js';
import {
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
  PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
  resolveTerminalProviderFailureNotice,
} from '../src/provider-failure.js';
import type { RegisteredGroup } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  enabledProviders: [
    {
      id: 'parser-provider-a',
      enabled: true,
      weight: 1,
      anthropicModel: 'primary-model',
    },
    {
      id: 'parser-provider-b',
      enabled: true,
      weight: 1,
      anthropicModel: 'primary-model',
    },
  ],
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getEnabledProviders: () => mocks.enabledProviders,
    getSystemSettings: () => ({
      ...actual.getSystemSettings(),
      fallbackModel: '',
    }),
  };
});

const {
  applyProviderFailureDisposition,
  runAgentWithModelFallback,
  transientRetryProfileForInput,
} = await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');

const group: RegisteredGroup = {
  name: 'parser-scheduled-replay',
  folder: 'parser-scheduled-replay',
  added_at: '2026-09-17T05:00:00.000Z',
};

beforeEach(() => {
  providerPool.refreshFromConfig(mocks.enabledProviders, {
    strategy: 'round-robin',
    unhealthyThreshold: 1,
    recoveryIntervalMs: 300_000,
  });
  for (const provider of mocks.enabledProviders)
    providerPool.resetHealth(provider.id);
});

/** Real stdout parsing, disposition ledger, close handling and scheduled replay
 * loop; replace only process launch/provider I/O. The launcher normally restores
 * its computed terminal flag after close, without consuming the ledger twice. */
async function runScheduledFailure(options: {
  turnId: string;
  recoverOnSecondAttempt: boolean;
  livenessTimeout?: boolean;
}) {
  const attemptedProviders: string[] = [];
  const projected: ContainerOutput[] = [];
  const closeOutputs: ContainerOutput[] = [];
  const run: AgentRunner = async (_group, input, onProcess, onOutput) => {
    const providerId =
      transientRetryProfileForInput(input.turnId) ??
      providerPool.selectProvider();
    attemptedProviders.push(providerId);
    onProcess(
      new ChildProcess(),
      `parser-attempt-${attemptedProviders.length}`,
      providerId,
    );
    if (options.recoverOnSecondAttempt && attemptedProviders.length === 2) {
      const recovered: ContainerOutput = {
        status: 'success',
        result: 'Recovered answer',
        inputTurnCompleted: true,
      };
      await onOutput?.(recovered);
      return recovered;
    }

    let terminal: boolean | undefined;
    const state = createStdoutParserState();
    const stream = new PassThrough();
    const handleOutput = async (output: ContainerOutput): Promise<void> => {
      terminal = applyProviderFailureDisposition(output, providerId);
      await onOutput?.(output);
    };
    attachStdoutHandler(stream, state, {
      groupName: group.name,
      label: 'Host agent',
      resetTimeout: () => {},
      onOutput: handleOutput,
    });
    const failure: ContainerOutput = {
      status: 'success',
      result: null,
      providerFailure: true,
      providerFailureClass: 'transient',
      inputTurnId: input.turnId,
      ...(options.livenessTimeout ? { providerLivenessTimeout: true } : {}),
    };
    stream.end(
      `${OUTPUT_START_MARKER}${JSON.stringify(failure)}${OUTPUT_END_MARKER}`,
    );
    const closed = await new Promise<ContainerOutput>((resolve) => {
      expect(
        handleNonZeroExit(
          {
            groupName: group.name,
            label: 'Host Agent',
            filePrefix: 'host',
            identifier: 'parser-scheduled',
            logsDir: '/tmp',
            input,
            stdoutState: state,
            stderrState: createStderrState(),
            onOutput: handleOutput,
            resolvePromise: resolve,
            startTime: Date.now(),
            timeoutMs: 1_000,
          },
          null,
          'SIGTERM',
          10,
          '/tmp/parser-scheduled.log',
        ),
      ).toBe(true);
    });
    closeOutputs.push({ ...closed });
    expect(terminal).toBeDefined();
    closed.providerFailureTerminal = terminal;
    closed.inputTurnCompleted = terminal;
    if (terminal) {
      const notice = resolveTerminalProviderFailureNotice(closed);
      if (notice) closed.providerFailureNotice = notice;
    }
    return closed;
  };
  const input: ContainerInput = {
    prompt: 'Recover the scheduled input',
    groupFolder: group.folder,
    chatJid: 'web:parser-scheduled-replay',
    isMain: false,
    isScheduledTask: true,
    turnId: options.turnId,
  };
  const output = await runAgentWithModelFallback(
    run,
    group,
    input,
    () => {},
    async (frame) => {
      projected.push({ ...frame });
    },
  );
  return { output, attemptedProviders, projected, closeOutputs };
}

describe('provider failure parsing through scheduled replay', () => {
  test('a transient frame followed by SIGTERM preserves the granted same-provider replay', async () => {
    const result = await runScheduledFailure({
      turnId: 'parser-recovery',
      recoverOnSecondAttempt: true,
    });
    expect(result.attemptedProviders).toHaveLength(2);
    expect(result.attemptedProviders[1]).toBe(result.attemptedProviders[0]);
    expect(result.output.result).toBe('Recovered answer');
    expect(result.projected).toEqual([
      expect.objectContaining({
        result: 'Recovered answer',
        inputTurnCompleted: true,
      }),
    ]);
    expect(result.closeOutputs).toHaveLength(1);
    expect(result.closeOutputs[0]).toMatchObject({
      providerFailure: true,
      providerFailureClass: 'transient',
    });
    expect(result.closeOutputs[0].inputTurnId).toBeUndefined();
    expect(result.closeOutputs[0].ipcReceipts).toBeUndefined();
  });

  test.each([false, true])(
    'repeated transient failure stays bounded and keeps its honest notice (liveness=%s)',
    async (livenessTimeout) => {
      const result = await runScheduledFailure({
        turnId: `parser-exhausted-${livenessTimeout}`,
        recoverOnSecondAttempt: false,
        livenessTimeout,
      });
      expect(result.attemptedProviders).toHaveLength(2);
      expect(result.attemptedProviders[1]).toBe(result.attemptedProviders[0]);
      const notice = livenessTimeout
        ? PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE
        : PROVIDER_TRANSIENT_FAILURE_USER_NOTICE;
      expect(result.output).toMatchObject({
        providerFailure: true,
        providerFailureClass: 'transient',
        providerFailureTerminal: true,
        inputTurnCompleted: true,
        providerFailureNotice: notice,
      });
      expect(result.output.providerFailureNotice).not.toContain('额度已用尽');
      expect(result.projected).toHaveLength(1);
      expect(result.projected[0]).toMatchObject({
        providerFailureTerminal: true,
        providerFailureNotice: notice,
      });
      for (const provider of mocks.enabledProviders)
        expect(providerPool.getHealthStatus(provider.id).healthy).toBe(true);
    },
  );
});
