// ─── ChatGPT/Codex 订阅 — 网关侧 token 管理 ────────────────────────
//
// 网关收到请求后用 provider 的 gateway token（存在 anthropicAuthToken 里，
// 与真实 ChatGPT token 无关）找到 provider，再按需刷新上游 access_token。
// 刷新沿用 Claude OAuth 的 CAS（compare-and-swap）落盘模式：只在 provider
// 仍持有发起刷新时的那份凭据快照时才写回，避免与并发的 admin 修改互相覆盖。
// 并发刷新做单飞（in-flight promise 复用）：上游会轮换 refresh_token，
// 同一时刻只允许一个网络刷新，其余请求共享同一结果，避免输家拿到
// invalid_grant 造成假 401。

import { timingSafeEqual } from 'node:crypto';
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

/** 常数时间比较 bearer token，长度不同直接不等（长度本身不是机密）。 */
function isSameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function resolveCodexProvider(gatewayToken: string): UnifiedProvider {
  const provider = getProviders().find(
    (candidate) =>
      candidate.enabled &&
      typeof candidate.anthropicAuthToken === 'string' &&
      candidate.anthropicAuthToken.length > 0 &&
      isSameSecret(candidate.anthropicAuthToken, gatewayToken) &&
      !!candidate.codexOAuthCredentials,
  );
  if (!provider) {
    throw new CodexGatewayAuthError('Unknown or disabled Codex gateway token');
  }
  return provider;
}

/** One rotating-token exchange per provider; callers always re-read after it. */
const inFlightRefreshes = new Map<string, Promise<void>>();

function sameCredentials(
  a: CodexOAuthCredentials,
  b: CodexOAuthCredentials | null | undefined,
): boolean {
  return (
    !!b &&
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt &&
    a.accountId === b.accountId
  );
}

async function performRefresh(
  providerId: string,
  credentials: CodexOAuthCredentials,
): Promise<void> {
  const tokenResponse = await refreshCodexToken(credentials.refreshToken);
  const refreshed = buildCodexCredentials(tokenResponse, credentials);
  // A CAS loser must not return its old credential object to other waiters:
  // getProviders() creates separate snapshots, so object identity is irrelevant.
  updateProviderCodexOAuthCredentialsIfCurrent(
    providerId,
    credentials,
    refreshed,
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
  // Recheck both the gateway grant and persisted credentials after every
  // await: an admin may rotate the key, disable/re-authorize the provider, or
  // clear its credentials while a refresh is in flight.
  for (let attempt = 0; attempt <= 3; attempt++) {
    const provider = resolveCodexProvider(gatewayToken);
    const credentials = provider.codexOAuthCredentials!;
    if (Date.now() < credentials.expiresAt - CODEX_TOKEN_REFRESH_MARGIN_MS) {
      return {
        providerId: provider.id,
        accessToken: credentials.accessToken,
        accountId: credentials.accountId,
      };
    }
    if (attempt === 3) {
      throw new CodexGatewayAuthError(
        'Codex OAuth credentials changed concurrently during refresh',
      );
    }
    if (!credentials.refreshToken) {
      throw new CodexGatewayAuthError(
        'Codex OAuth credentials have no refresh_token; re-authorize in Provider settings',
      );
    }
    let inFlight = inFlightRefreshes.get(provider.id);
    if (!inFlight) {
      inFlight = performRefresh(provider.id, credentials).finally(() => {
        inFlightRefreshes.delete(provider.id);
      });
      inFlightRefreshes.set(provider.id, inFlight);
    }
    try {
      await inFlight;
    } catch (err) {
      const latest = resolveCodexProvider(gatewayToken);
      if (!sameCredentials(credentials, latest.codexOAuthCredentials)) continue;
      logger.warn(
        { providerId: provider.id, err },
        'Codex gateway: failed to refresh upstream access token',
      );
      throw err;
    }
  }
  throw new CodexGatewayAuthError('Codex OAuth refresh failed');
}
