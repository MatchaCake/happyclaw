// Codex store=false reasoning continuity travels through thinking.signature.
// Standard encrypted_content uses CLIProxyAPI's native Fernet-shaped format;
// legacy codexrs1 envelopes remain readable for existing HappyClaw histories.
// Ported from CLIProxyAPI a2976eb8. See docs/licenses/CLIProxyAPI-MIT.txt.

const SIGNATURE_PREFIX = 'codexrs1_';
const MAX_SIGNATURE_LENGTH = 32 * 1024 * 1024;

/**
 * CLIProxyAPI internal/signature/gpt_validation.go transport-shape check.
 * This validates the Fernet envelope, not its authenticity or decryptability.
 */
export function isCodexReasoningSignature(signature: string): boolean {
  if (
    signature.length > MAX_SIGNATURE_LENGTH ||
    !signature.startsWith('gAAAA') ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(signature)
  ) {
    return false;
  }
  const unpadded = signature.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return false;
  if (signature.includes('=') && signature.length % 4 !== 0) return false;
  const decoded = Buffer.from(signature, 'base64url');
  const ciphertextLength = decoded.length - 1 - 8 - 16 - 32;
  return (
    decoded.length >= 73 &&
    decoded[0] === 0x80 &&
    ciphertextLength > 0 &&
    ciphertextLength % 16 === 0
  );
}

interface ReasoningSignaturePayload {
  /** 上游 reasoning item id（rs_...），可能缺失。 */
  id: string | null;
  /** 上游 reasoning item 的 encrypted_content。 */
  encryptedContent: string;
}

export function encodeReasoningSignature(
  payload: ReasoningSignaturePayload,
): string | null {
  if (!payload.encryptedContent) return null;
  // Standard Codex signatures are carried verbatim, matching CLIProxyAPI.
  // Retain the legacy envelope for already supported opaque backend payloads.
  if (isCodexReasoningSignature(payload.encryptedContent)) {
    return payload.encryptedContent;
  }
  const json = JSON.stringify({
    v: 1,
    id: payload.id,
    ec: payload.encryptedContent,
  });
  return `${SIGNATURE_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

export function decodeReasoningSignature(
  signature: unknown,
): ReasoningSignaturePayload | null {
  if (
    typeof signature !== 'string' ||
    signature.length > MAX_SIGNATURE_LENGTH
  ) {
    return null;
  }
  const normalized = signature.trim();
  const raw = normalized.startsWith('gpt#') ? normalized.slice(4) : normalized;
  if (isCodexReasoningSignature(raw)) {
    return { id: null, encryptedContent: raw };
  }
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    return null;
  }
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(signature.slice(SIGNATURE_PREFIX.length))) {
      return null;
    }
    const json = Buffer.from(
      signature.slice(SIGNATURE_PREFIX.length),
      'base64url',
    ).toString('utf8');
    const parsed = JSON.parse(json) as {
      v?: unknown;
      id?: unknown;
      ec?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.ec !== 'string' || !parsed.ec) {
      return null;
    }
    return {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : null,
      encryptedContent: parsed.ec,
    };
  } catch {
    return null;
  }
}
