import { describe, expect, test } from 'vitest';
import corpus from './fixtures/codex-cliproxy-a2976.json';
import { anthropicToResponses } from '../src/codex-gateway/convert-request.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
} from '../src/codex-gateway/convert-response.js';

type Json = Record<string, any>;

// Normalize only documented runtime differences from the pure Go translator:
// summaries are explicitly enabled by HappyClaw, and the Codex executor removes
// unused tool fields after translation. All message/tool/schema values compare.
function requestBusinessPayload(request: Json): Json {
  const payload = structuredClone(request);
  delete payload.reasoning.summary;
  if (!payload.tools?.length) {
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
  }
  // HappyClaw's current model catalog normalizes removed minimal to low.
  if (payload.reasoning.effort === 'minimal') payload.reasoning.effort = 'low';
  return payload;
}

function streamMessage(events: Json[]): Json {
  const blocks = new Map<number, Json>();
  const argumentsByIndex = new Map<number, string>();
  let result: Json = {};
  for (const event of events) {
    if (event.type === 'content_block_start') {
      blocks.set(event.index, structuredClone(event.content_block));
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block) throw new Error('Delta precedes block start');
      const delta = event.delta;
      if (delta.type === 'text_delta') block.text += delta.text;
      if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      if (delta.type === 'signature_delta')
        block.signature = (block.signature ?? '') + delta.signature;
      if (delta.type === 'input_json_delta')
        argumentsByIndex.set(
          event.index,
          (argumentsByIndex.get(event.index) ?? '') + delta.partial_json,
        );
    } else if (event.type === 'message_delta') {
      const usage = { ...event.usage };
      if (!usage.cache_read_input_tokens) delete usage.cache_read_input_tokens;
      if (!usage.cache_creation_input_tokens)
        delete usage.cache_creation_input_tokens;
      result = {
        stop_reason: event.delta.stop_reason,
        stop_sequence: event.delta.stop_sequence ?? null,
        usage,
      };
    } else if (event.type === 'error') {
      throw new Error(
        'Unexpected error in reference-compatible success stream',
      );
    }
  }
  result.content = [...blocks]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => {
      if (argumentsByIndex.has(index))
        block.input = JSON.parse(argumentsByIndex.get(index)!);
      return block;
    });
  return result;
}

describe('pinned CLIProxyAPI Go implementation differential corpus', () => {
  test('pins the independently executed reference commit', () => {
    expect(corpus.commit).toBe('a2976eb8a303f11b4ea5177bce9f9ff752634dfc');
    expect(corpus.fixtures).toHaveLength(34);
  });

  for (const fixture of corpus.fixtures) {
    test(`request: ${fixture.name}`, () => {
      const actual = anthropicToResponses(fixture.request, {
        targetModel: 'gpt-6-sol',
      });
      expect(requestBusinessPayload(actual)).toEqual(
        requestBusinessPayload(fixture.expectedRequest),
      );
    });
    if (fixture.events) {
      test(`stream: ${fixture.name}`, () => {
        const expectedEvents = fixture.expectedStream!.flatMap((chunk) =>
          chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => JSON.parse(line.slice(5))),
        );
        const converter = new ResponsesToAnthropicConverter('gpt-6-sol', {
          tools: fixture.request.tools,
        });
        const actual = fixture
          .events!.flatMap((event) => converter.handleEvent(event))
          .map((event) => event.data);
        expect(
          actual.filter((event) => event.type === 'message_stop'),
        ).toHaveLength(1);
        expect(streamMessage(actual)).toEqual(streamMessage(expectedEvents));
      });
      test(`nonstream: ${fixture.name}`, () => {
        const actual = aggregateResponsesStream(fixture.events!, 'gpt-6-sol', {
          tools: fixture.request.tools,
        });
        const expected = structuredClone(fixture.expectedResponse!) as Json;
        const usage: Json = { ...actual.usage };
        if (!usage.cache_read_input_tokens)
          delete usage.cache_read_input_tokens;
        // Both output paths deliberately share multipart thinking separators.
        if (fixture.name === 'stream-reasoning-multipart') {
          expected.content[0].thinking = 'first\n\nsecond';
        }
        expect({
          content: actual.content,
          stop_reason: actual.stopReason,
          stop_sequence: actual.stopSequence,
          usage,
        }).toEqual({
          content: expected.content,
          stop_reason: expected.stop_reason,
          stop_sequence: expected.stop_sequence,
          usage: expected.usage,
        });
      });
    }
  }
});
