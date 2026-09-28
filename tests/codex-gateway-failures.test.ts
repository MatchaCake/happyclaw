import { describe, expect, test } from 'vitest';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
} from '../src/codex-gateway/convert-response.js';

const created = {
  type: 'response.created',
  response: { id: 'r1', model: 'gpt-6-sol' },
};

describe('Codex upstream failure semantics', () => {
  test('premature EOF emits error rather than a successful stop', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(created);
    const events = converter.finish();
    expect(events.map(({ event }) => event)).toEqual(['error']);
    expect(events[0].data).toMatchObject({ type: 'error' });
  });

  test.each([
    [created],
    [
      created,
      { type: 'response.failed', response: { error: { message: 'quota' } } },
    ],
    [created, { type: 'error', message: 'backend error' }],
  ])(
    'aggregation rejects missing success terminal or upstream failure',
    (...events) => {
      expect(() => aggregateResponsesStream(events, 'gpt-6-sol')).toThrow();
    },
  );

  test('completed response still succeeds', () => {
    expect(
      aggregateResponsesStream(
        [created, { type: 'response.completed', response: {} }],
        'gpt-6-sol',
      ).stopReason,
    ).toBe('end_turn');
  });
});
