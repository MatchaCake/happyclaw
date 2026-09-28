// ─── ChatGPT/Codex 订阅 — 网关侧 token 管理 ────────────────────────
//
// 网关收到请求后用 provider 的 gateway token（存在 anthropicAuthToken 里，
// 与真实 ChatGPT token 无关）找到 provider，再按需刷新上游 access_token。
// 刷新沿用 Claude OAuth 的 CAS（compare-and-swap）落盘模式：只在 provider
// 仍持有发起刷新时的那份凭据快照时才写回，避免与并发的 admin 修改互相覆盖。

import { logger } from '../logger.js';
import {
  getProviders,
  updateProviderCodexOAuthCredentialsIfCurrent,
  type UnifiedProvider,
} from '../runtime-config.js';
import { buildCodexCredentials, refreshCodexToken } from './oauth.js';
import {
  CODEX_TOKEN_REFRESH_MARGIN_MS,
  type CodexOAuthCredentials,
} from './types.js';

export class CodexGatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexGatewayAuthError';
  }
}

function findProviderByGatewayToken(gatewayToken: string): UnifiedProvider {
  const provider = getProviders().find(
    (candidate) =>
      candidate.anthropicAuthToken === gatewayToken &&
      !!candidate.codexOAuthCredentials,
  );
  if (!provider) {
    throw new CodexGatewayAuthError('Unknown or disabled Codex gateway token');
  }
  return provider;
}

async function refreshIfNeeded(
  providerId: string,
  credentials: CodexOAuthCredentials,
  attemptsLeft = 2,
): Promise<CodexOAuthCredentials> {
  if (Date.now() < credentials.expiresAt - CODEX_TOKEN_REFRESH_MARGIN_MS) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new CodexGatewayAuthError(
      'Codex OAuth credentials have no refresh_token; re-authorize in Provider settings',
    );
  }
  const tokenResponse = await refreshCodexToken(credentials.refreshToken);
  const refreshed = buildCodexCredentials(tokenResponse, credentials);
  const persisted = updateProviderCodexOAuthCredentialsIfCurrent(
    providerId,
    credentials,
    refreshed,
  );
  if (persisted) {
    return refreshed;
  }
  if (attemptsLeft <= 0) {
    throw new CodexGatewayAuthError(
      'Codex OAuth credentials changed concurrently during refresh',
    );
  }
  // 另一路请求已经先一步刷新并落盘：重新读取当前凭据再判断是否仍需刷新。
  const latest = getProviders().find((p) => p.id === providerId);
  if (!latest?.codexOAuthCredentials) {
    throw new CodexGatewayAuthError('Provider Codex credentials were cleared');
  }
  return refreshIfNeeded(
    providerId,
    latest.codexOAuthCredentials,
    attemptsLeft - 1,
  );
}

export interface CodexAccessContext {
  providerId: string;
  accessToken: string;
  accountId: string | null;
}

/** 用网关 token（provider 的 anthropicAuthToken）解析出可用的上游 access_token。 */
export async function resolveCodexAccess(
  gatewayToken: string,
): Promise<CodexAccessContext> {
  const provider = findProviderByGatewayToken(gatewayToken);
  const credentials = provider.codexOAuthCredentials;
  if (!credentials) {
    throw new CodexGatewayAuthError('Provider has no Codex OAuth credentials');
  }
  try {
    const valid = await refreshIfNeeded(provider.id, credentials);
    return {
      providerId: provider.id,
      accessToken: valid.accessToken,
      accountId: valid.accountId,
    };
  } catch (err) {
    logger.warn(
      { providerId: provider.id, err },
      'Codex gateway: failed to resolve a valid upstream access token',
    );
    throw err;
  }
}
