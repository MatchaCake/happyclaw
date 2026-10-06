import { expect, test, vi } from 'vitest';
import { DurableInputTurnCompletion } from '../container/agent-runner/src/background-task-drain.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

test('a drain waits for Tasks, their completion summary, and all admitted follow-ups', async () => {
  const completion = new DurableInputTurnCompletion();
  const globals: Record<string, any> = {
    ipcPolling: true,
    shouldClose: () => false,
    shouldInterrupt: () => false,
    shouldDrain: () => true,
    resultCount: 1,
    durableInputCompletion: completion,
    ipcDeliveryTracker: { hasPendingTurns: false },
    processor: { getBlockingBackgroundProtocolCount: () => 2 },
    cancelBackgroundResultCompletion: vi.fn(),
    clearBackgroundProtocolDebtWatchdog: vi.fn(),
    interruptQueryForShutdown: vi.fn(),
    stream: { end: vi.fn() },
    ipcQueryWatcher: { close: vi.fn() },
    closedDuringQuery: false,
    log: vi.fn(),
    resultReceivedAt: null,
    shouldAcceptIpcMessagesDuringQuery: () => false,
    emitOutput: true,
    acceptIpcMessagesDuringQuery: true,
  };
  const harness = createRuntimeSourceHarness(
    globals,
    new URL('../container/agent-runner/src/index.ts', import.meta.url),
  );
  harness.install('pollIpcDuringQuery', 'runQueryAttempt');
  completion.publishResult(false, false); // Held result, Tasks still running.
  await globals.pollIpcDuringQuery();
  expect(globals.stream.end).not.toHaveBeenCalled();
  globals.processor.getBlockingBackgroundProtocolCount = () => 0;
  await globals.pollIpcDuringQuery(); // Tasks finished, final summary still pending.
  expect(globals.stream.end).not.toHaveBeenCalled();
  completion.publishResult(true, true);
  globals.ipcDeliveryTracker.hasPendingTurns = true;
  await globals.pollIpcDuringQuery(); // A finished, B is already admitted.
  expect(globals.stream.end).not.toHaveBeenCalled();
  globals.ipcDeliveryTracker.hasPendingTurns = false;
  completion.publishResult(true, false);
  await globals.pollIpcDuringQuery();
  expect(globals.stream.end).toHaveBeenCalledOnce();
  expect(globals.interruptQueryForShutdown).toHaveBeenCalledOnce();
  expect(globals.closedDuringQuery).toBe(true);
});
