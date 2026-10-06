import { describe, expect, test } from 'vitest';
import {
  decodeReasoningSignature,
  encodeReasoningSignature,
  isCodexReasoningSignature,
} from '../src/codex-gateway/reasoning-signature.js';

function signature(ciphertextLength = 32): string {
  return Buffer.concat([
    Buffer.from([0x80]),
    Buffer.alloc(8),
    Buffer.alloc(16, 3),
    Buffer.alloc(ciphertextLength, 4),
    Buffer.alloc(32, 5),
  ]).toString('base64url');
}

describe('CLIProxyAPI reasoning transport compatibility', () => {
  test('carries raw encrypted reasoning without a private wrapper or item id', () => {
    const raw = signature();
    expect(
      encodeReasoningSignature({ id: 'rs_previous', encryptedContent: raw }),
    ).toBe(raw);
    expect(decodeReasoningSignature(raw)).toEqual({
      id: null,
      encryptedContent: raw,
    });
    expect(decodeReasoningSignature(` gpt#${raw} `)).toEqual({
      id: null,
      encryptedContent: raw,
    });
  });

  test('accepts padded and unpadded Fernet payloads', () => {
    const raw = signature(16);
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    expect(isCodexReasoningSignature(raw)).toBe(true);
    expect(isCodexReasoningSignature(padded)).toBe(true);
  });

  test.each([
    'gAAAA',
    'gAAAA***',
    'claude#not-codex',
    'gpt#gpt#not-codex',
    signature(15),
    signature(0),
    signature() + '===',
    'gAAAA' + 'a'.repeat(32 * 1024 * 1024),
  ])('rejects malformed or foreign raw signatures', (raw) => {
    expect(decodeReasoningSignature(raw)).toBeNull();
  });

  test('keeps historical gateway envelopes replayable', () => {
    const old = encodeReasoningSignature({
      id: 'rs_old',
      encryptedContent: 'old-opaque-backend-payload',
    });
    expect(old).toMatch(/^codexrs1_/);
    expect(decodeReasoningSignature(old)).toEqual({
      id: 'rs_old',
      encryptedContent: 'old-opaque-backend-payload',
    });
  });
});
