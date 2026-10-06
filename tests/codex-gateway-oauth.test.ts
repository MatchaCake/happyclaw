import { describe, expect, test } from 'vitest';
import {
  buildCodexCredentials,
  parseCodexIdToken,
} from '../src/codex-gateway/oauth.js';

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`;
}

describe('Codex OAuth identity', () => {
  test('reads official namespaced ID token claims and forwards the account identity', () => {
    const idToken = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-business',
        chatgpt_plan_type: 'business',
      },
      'https://api.openai.com/profile': { email: 'fake@example.invalid' },
      auth: { chatgpt_account_id: 'legacy-wrong', chatgpt_plan_type: 'free' },
    });
    const identity = {
      accountId: 'workspace-business',
      planType: 'business',
      email: 'fake@example.invalid',
    };
    expect(parseCodexIdToken(idToken)).toEqual(identity);
    expect(
      buildCodexCredentials({
        accessToken: 'synthetic-access',
        refreshToken: 'synthetic-refresh',
        expiresAt: 1234,
        idToken,
      }),
    ).toMatchObject(identity);
  });

  test('keeps legacy claims and top-level email compatibility', () => {
    expect(
      parseCodexIdToken(
        jwt({
          auth: { chatgpt_account_id: 'personal', chatgpt_plan_type: 'plus' },
          profile: { email: 'old@example.invalid' },
          email: 'top@example.invalid',
        }),
      ),
    ).toEqual({
      accountId: 'personal',
      planType: 'plus',
      email: 'top@example.invalid',
    });
  });

  test.each([null, 'garbage', jwt(null), jwt([]), jwt(42)])(
    'rejects malformed claim payload %s without throwing',
    (token) => {
      expect(parseCodexIdToken(token)).toEqual({
        accountId: null,
        planType: null,
        email: null,
      });
    },
  );

  test('refresh responses without ID token preserve the existing identity', () => {
    const previous = {
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: 1,
      accountId: 'workspace',
      planType: 'pro',
      email: 'fake@example.invalid',
      updatedAt: 'old',
    };
    expect(
      buildCodexCredentials(
        {
          accessToken: 'new',
          refreshToken: null,
          expiresAt: 9999,
          idToken: null,
        },
        previous,
      ),
    ).toMatchObject({
      accessToken: 'new',
      refreshToken: 'refresh',
      accountId: 'workspace',
      planType: 'pro',
      email: 'fake@example.invalid',
    });
  });
});
