import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodexOAuthCredentials } from '../src/codex-gateway/types.js';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  persist: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  updateProviderCodexOAuthCredentialsIfCurrent: mocks.persist,
}));
vi.mock('../src/codex-gateway/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshCodexToken: mocks.refresh,
}));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));

import {
  CodexGatewayAuthError,
  resolveCodexAccess,
} from '../src/codex-gateway/token-manager.js';

function credentials(
  token = 'upstream-token',
  expired = false,
): CodexOAuthCredentials {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: Date.now() + (expired ? -1 : 3_600_000),
    accountId: 'account-id',
    planType: 'plus',
    email: 'fake@example.invalid',
    updatedAt: 'now',
  };
}
function tokenResponse(token: string) {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: Date.now() + 3_600_000,
    idToken: null,
  };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let provider: {
  id: string;
  enabled: boolean;
  anthropicAuthToken: string;
  codexOAuthCredentials: CodexOAuthCredentials | null;
};
beforeEach(() => {
  vi.clearAllMocks();
  provider = {
    id: 'provider',
    enabled: true,
    anthropicAuthToken: 'gateway-token',
    codexOAuthCredentials: credentials(),
  };
  // Production getProviders deserializes a fresh credential snapshot per call.
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.persist.mockImplementation((_id, expected, refreshed) => {
    if (provider.codexOAuthCredentials?.accessToken !== expected.accessToken)
      return false;
    provider.codexOAuthCredentials = refreshed;
    return true;
  });
});

describe('resolveCodexAccess', () => {
  test('rejects disabled providers even with the matching token', async () => {
    provider.enabled = false;
    await expect(resolveCodexAccess('gateway-token')).rejects.toThrow(
      CodexGatewayAuthError,
    );
  });
  test('returns current credentials for an enabled provider', async () => {
    await expect(resolveCodexAccess('gateway-token')).resolves.toEqual({
      providerId: 'provider',
      accessToken: 'upstream-token',
      accountId: 'account-id',
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  test('concurrent snapshots share one rotating-token refresh', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = Array.from({ length: 8 }, () =>
      resolveCodexAccess('gateway-token'),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    exchange.resolve(tokenResponse('new'));
    for (const value of await Promise.all(requests))
      expect(value.accessToken).toBe('new');
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  test('CAS losers re-read valid admin credentials instead of returning an expired waiter snapshot', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = [
      resolveCodexAccess('gateway-token'),
      resolveCodexAccess('gateway-token'),
    ];
    provider.codexOAuthCredentials = credentials('admin-new');
    provider.codexOAuthCredentials.accountId = 'admin-workspace';
    exchange.resolve(tokenResponse('discarded'));
    for (const value of await Promise.all(requests))
      expect(value).toMatchObject({
        accessToken: 'admin-new',
        accountId: 'admin-workspace',
      });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  test('CAS losers share a second refresh when the replacement credentials also expired', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh
      .mockReturnValueOnce(exchange.promise)
      .mockResolvedValueOnce(tokenResponse('latest'));
    const requests = [
      resolveCodexAccess('gateway-token'),
      resolveCodexAccess('gateway-token'),
    ];
    provider.codexOAuthCredentials = credentials('admin-expired', true);
    exchange.resolve(tokenResponse('discarded'));
    for (const value of await Promise.all(requests))
      expect(value.accessToken).toBe('latest');
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenNthCalledWith(2, 'refresh-admin-expired');
  });
  test.each(['disable', 'rotate', 'clear'])(
    'revalidates authorization after admin %s during refresh',
    async (action) => {
      provider.codexOAuthCredentials = credentials('old', true);
      const exchange = gate<ReturnType<typeof tokenResponse>>();
      mocks.refresh.mockReturnValue(exchange.promise);
      const request = resolveCodexAccess('gateway-token');
      if (action === 'disable') provider.enabled = false;
      if (action === 'rotate')
        provider.anthropicAuthToken = 'new-gateway-token';
      if (action === 'clear') provider.codexOAuthCredentials = null;
      exchange.resolve(tokenResponse('new'));
      await expect(request).rejects.toThrow(
        'Unknown or disabled Codex gateway token',
      );
    },
  );
  test('a failed old refresh can use credentials concurrently replaced by admin', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const request = resolveCodexAccess('gateway-token');
    provider.codexOAuthCredentials = credentials('admin-valid');
    exchange.reject(new Error('invalid_grant'));
    await expect(request).resolves.toMatchObject({
      accessToken: 'admin-valid',
    });
  });
  test('refresh rejection releases singleflight for a later retry', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    mocks.refresh
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(tokenResponse('retry'));
    await expect(resolveCodexAccess('gateway-token')).rejects.toThrow(
      'transient',
    );
    await expect(resolveCodexAccess('gateway-token')).resolves.toMatchObject({
      accessToken: 'retry',
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
  test('persistent CAS conflicts are bounded and never return expired credentials', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    mocks.persist.mockReturnValue(false);
    mocks.refresh.mockResolvedValue(tokenResponse('discarded'));
    await expect(resolveCodexAccess('gateway-token')).rejects.toThrow(
      'changed concurrently',
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });
});
