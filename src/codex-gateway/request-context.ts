// Codex HTTP context defaults and Claude execution identity follow CLIProxyAPI
// a2976eb8 (MIT; see docs/licenses/CLIProxyAPI-MIT.txt). HappyClaw additionally
// scopes the cache identity to the provider/account for multi-user isolation.

import { createHash } from 'node:crypto';

const CODEX_USER_AGENT =
  'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)';
const UUID_OID_NAMESPACE = Buffer.from(
  '6ba7b8129dad11d180b400c04fd430c8',
  'hex',
);

function identityPart(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (
    !trimmed ||
    Buffer.byteLength(trimmed) > 1024 ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  )
    return;
  return trimmed;
}

function metadataSession(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') return;
  const metadata = (request as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return;
  const userId = (metadata as Record<string, unknown>).user_id;
  if (typeof userId !== 'string' || Buffer.byteLength(userId) > 8192) return;
  const suffix = /_session_([a-f0-9-]+)$/.exec(userId);
  if (suffix) return identityPart(suffix[1]);
  if (userId.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(userId);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return identityPart((parsed as Record<string, unknown>).session_id);
    } catch {
      // Opaque metadata is optional and never echoed or logged.
    }
  }
}

function uuidV5(identity: string): string {
  const bytes = createHash('sha1')
    .update(UUID_OID_NAMESPACE)
    .update(identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function codexRequestContext(
  incomingHeaders: Headers,
  request: unknown,
  upstream: {
    providerId: string;
    accountId: string | null;
    model: string;
    serviceTier?: string;
  },
): { headers: Record<string, string>; promptCacheKey?: string } {
  const headers: Record<string, string> = {
    'User-Agent': CODEX_USER_AGENT,
    originator: 'codex-tui',
    Connection: 'Keep-Alive',
  };
  // Request model strings are opaque until the upstream validates them. Never
  // turn an oversized/non-ASCII body field into an invalid HTTP header.
  if (upstream.model.length <= 1024 && /^[\x20-\x7e]+$/.test(upstream.model))
    headers['X-Codex-Routing-Hint'] =
      `model=${upstream.model}${upstream.serviceTier === 'priority' ? ';tier=priority' : ''}`;
  const sessionId =
    identityPart(incomingHeaders.get('x-claude-code-session-id')) ??
    metadataSession(request);
  if (!sessionId) return { headers };
  const agentId =
    identityPart(incomingHeaders.get('x-claude-code-agent-id')) ?? 'main';
  const promptCacheKey = uuidV5(
    JSON.stringify([
      'happyclaw:codex:claude-code',
      upstream.providerId,
      upstream.accountId,
      upstream.model,
      sessionId,
      agentId,
    ]),
  );
  headers['Session-Id'] = promptCacheKey;
  return { headers, promptCacheKey };
}
