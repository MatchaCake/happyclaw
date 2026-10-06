import { afterEach, describe, expect, test, vi } from 'vitest';

import { setChannelImplementationLoaderForTest } from '../src/channel-registry.js';
import { createDiscordChannel } from '../src/im-channel.js';

function createDeferredTypingConnection() {
  const state = { pulses: 0 };
  const connection = {
    async connect() {
      return true;
    },
    async disconnect() {},
    async setTyping() {
      state.pulses += 1;
      // Real discord.ts setTyping awaits resolveChannel() + sendTyping().
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    isConnected() {
      return true;
    },
  };
  return { state, connection };
}

describe('Discord typing adapter concurrent leases', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.useRealTimers();
  });

  async function connectDiscord() {
    const { state, connection } = createDeferredTypingConnection();
    restore = setChannelImplementationLoaderForTest(
      'discord',
      async () => ({ createDiscordConnection: () => connection }) as never,
    );
    const channel = createDiscordChannel({} as never);
    await channel.connect({} as never);
    return { state, channel };
  }

  test('keeps one pulse per chat and stops it once both racing leases release', async () => {
    vi.useFakeTimers();
    const { state, channel } = await connectDiscord();

    const a = channel.setTyping('c1', true, 'A');
    const b = channel.setTyping('c1', true, 'B');
    await vi.advanceTimersByTimeAsync(60);
    await Promise.all([a, b]);
    await channel.setTyping('c1', false, 'A');
    await channel.setTyping('c1', false, 'B');

    // Every lease is released: no pulse may keep the indicator alive.
    const afterRelease = state.pulses;
    await vi.advanceTimersByTimeAsync(9_000 * 5);
    expect(state.pulses - afterRelease).toBe(0);

    // disconnect + reconnect must not resurrect a pulse either.
    await channel.disconnect();
    await channel.connect({} as never);
    const afterReconnect = state.pulses;
    await vi.advanceTimersByTimeAsync(9_000 * 5);
    expect(state.pulses - afterReconnect).toBe(0);
  });

  test('a release landing during the first provider call leaves no pulse', async () => {
    vi.useFakeTimers();
    const { state, channel } = await connectDiscord();

    const acquire = channel.setTyping('c1', true, 'A');
    // Release while the first inner.setTyping round trip is still pending.
    await channel.setTyping('c1', false, 'A');
    await vi.advanceTimersByTimeAsync(60);
    await acquire;

    const afterRelease = state.pulses;
    await vi.advanceTimersByTimeAsync(9_000 * 5);
    expect(state.pulses - afterRelease).toBe(0);
  });
});
