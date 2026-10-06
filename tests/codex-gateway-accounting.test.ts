import { describe, expect, test } from 'vitest';
import {
  aggregateResponsesStream,
  ResponsesToAnthropicConverter,
} from '../src/codex-gateway/convert-response.js';
import {
  AssistantUsageCollector,
  parseAssistantUsage,
} from '../container/agent-runner/src/assistant-usage.js';
import {
  estimateKabooModelCostUSD,
  priceKabooUsageByModel,
} from '../src/kaboo-pricing.js';

const completed = {
  type: 'response.completed',
  response: {
    id: 'usage-test',
    usage: {
      input_tokens: 100_000,
      input_tokens_details: { cached_tokens: 80_000 },
      output_tokens: 10_000,
      total_tokens: 110_000,
    },
  },
};

describe('Codex usage crosses the Anthropic/collector/pricing boundary', () => {
  test('SSE final usage counts cached input once in the collector and pricing', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    const delta = converter
      .handleEvent(completed)
      .find(({ event }) => event === 'message_delta');
    expect(delta?.data.usage).toEqual({
      input_tokens: 20_000,
      output_tokens: 10_000,
      cache_read_input_tokens: 80_000,
    });
    const sdk = {
      type: 'assistant',
      message: {
        id: 'codex-accounting',
        model: 'gpt-6-sol',
        usage: converter.getUsage(),
      },
    };
    expect(parseAssistantUsage(sdk)?.total).toBe(110_000);
    const collector = new AssistantUsageCollector();
    collector.ingest(sdk);
    const batch = collector.drain(undefined)!;
    const priced = priceKabooUsageByModel(
      batch.tokens,
      batch.tokens.modelUsage,
    );
    expect(
      priced.usage.inputTokens +
        priced.usage.cacheReadInputTokens +
        priced.usage.outputTokens,
    ).toBe(110_000);
    expect(priced.unroundedCostUSD).toBe(
      estimateKabooModelCostUSD('gpt-6-sol', {
        inputTokens: 20_000,
        cacheReadInputTokens: 80_000,
        outputTokens: 10_000,
      }),
    );
    expect(collector.drain(undefined)).toBeUndefined();
  });

  test('nonstream aggregation uses the same cache-exclusive usage', () => {
    expect(aggregateResponsesStream([completed], 'gpt-6-sol').usage).toEqual({
      input_tokens: 20_000,
      output_tokens: 10_000,
      cache_read_input_tokens: 80_000,
    });
  });

  test('transcript backfill of final gateway usage preserves the same token basis', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest({
      type: 'assistant',
      message: { id: 'transcript-id', model: 'gpt-6-sol', usage: {} },
    });
    const final = parseAssistantUsage({
      type: 'assistant',
      message: {
        id: 'transcript-id',
        model: 'gpt-6-sol',
        usage: aggregateResponsesStream([completed], 'gpt-6-sol').usage,
      },
    })!;
    const batch = collector.drain(
      undefined,
      () => new Map([[final.id, final]]),
    )!;
    expect(
      batch.tokens.inputTokens +
        batch.tokens.cacheReadInputTokens +
        batch.tokens.outputTokens,
    ).toBe(110_000);
  });

  test.each([
    {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 99 },
      output_tokens: -1,
    },
    {
      input_tokens: NaN,
      input_tokens_details: { cached_tokens: Infinity },
      output_tokens: Infinity,
    },
  ])(
    'invalid upstream counts never produce negative or non-finite counters',
    (usage) => {
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      converter.handleEvent({
        type: 'response.completed',
        response: { usage },
      });
      for (const value of Object.values(converter.getUsage())) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(
        converter.getUsage().input_tokens +
          converter.getUsage().cache_read_input_tokens,
      ).toBe(Number.isFinite(usage.input_tokens) ? 10 : 0);
    },
  );
});
