import { describe, expect, test } from 'vitest';
import {
  aggregateResponsesStream,
  ResponsesToAnthropicConverter,
  type AnthropicStreamEvent,
} from '../src/codex-gateway/convert-response.js';
import {
  buildCodexToolNameMap,
  shortenCodexCallId,
} from '../src/codex-gateway/convert-request.js';
import { decodeReasoningSignature } from '../src/codex-gateway/reasoning-signature.js';

type Json = Record<string, any>;
const created = {
  type: 'response.created',
  response: { id: 'r', model: 'gpt-6-sol' },
};
const completed = {
  type: 'response.completed',
  response: { usage: { input_tokens: 20, output_tokens: 7 } },
};
const added = (item: Json, output_index = 0) => ({
  type: 'response.output_item.added',
  item,
  output_index,
});
const done = (item: Json, output_index = 0) => ({
  type: 'response.output_item.done',
  item,
  output_index,
});
const tool = (id: string, name = 'Read', args?: string) => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  ...(args === undefined ? {} : { arguments: args }),
});

function translate(events: Json[], tools?: Json[]) {
  const converter = new ResponsesToAnthropicConverter('gpt-6-sol', { tools });
  const wire = events.flatMap((event) => converter.handleEvent(event));
  wire.push(...converter.finish());
  return { wire, converter, message: consume(wire) };
}

/** Independent consumer validates the SDK contract: exactly one open block. */
function consume(wire: AnthropicStreamEvent[]) {
  const content: Json[] = [];
  let active: number | null = null;
  let messageStarted = false;
  let terminal = 0;
  let stopReason: string | null = null;
  let usage: Json = {};
  let argumentsJson = '';
  for (const { event, data } of wire) {
    expect(terminal).not.toBe(2);
    if (event === 'message_start') {
      expect(messageStarted).toBe(false);
      messageStarted = true;
    } else if (event === 'content_block_start') {
      expect(messageStarted).toBe(true);
      expect(terminal).toBe(0);
      expect(active).toBeNull();
      const index = data.index as number;
      expect(index).toBe(content.length);
      active = index;
      content.push(structuredClone(data.content_block));
      argumentsJson = '';
    } else if (event === 'content_block_delta') {
      expect(active).toBe(data.index);
      expect(active).not.toBeNull();
      const block = content[active!];
      const delta = data.delta as Json;
      if (delta.type === 'text_delta') block.text += delta.text;
      else if (delta.type === 'thinking_delta')
        block.thinking += delta.thinking;
      else if (delta.type === 'signature_delta')
        block.signature = delta.signature;
      else if (delta.type === 'input_json_delta')
        argumentsJson += delta.partial_json;
    } else if (event === 'content_block_stop') {
      expect(active).toBe(data.index);
      expect(active).not.toBeNull();
      if (argumentsJson) content[active!].input = JSON.parse(argumentsJson);
      active = null;
    } else if (event === 'message_delta') {
      expect(active).toBeNull();
      expect(terminal).toBe(0);
      terminal = 1;
      stopReason = (data.delta as Json).stop_reason;
      usage = data.usage as Json;
    } else if (event === 'message_stop') {
      expect(active).toBeNull();
      expect(terminal).toBe(1);
      terminal = 2;
    } else if (event === 'error') throw new Error((data.error as Json).message);
  }
  expect(terminal).toBe(2);
  return { content, stopReason, usage };
}

describe('Responses to Anthropic compatibility and ownership', () => {
  test('a missing created frame still starts the message before text', () => {
    const { wire, message } = translate([
      { type: 'response.output_text.delta', delta: 'hello' },
      completed,
    ]);
    expect(wire[0].event).toBe('message_start');
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('a terminal-only output hydrates all blocks in response order for both response modes', () => {
    const terminal = {
      type: 'response.completed',
      response: {
        id: 'terminal',
        model: 'gpt-6-sol',
        output: [
          {
            type: 'reasoning',
            id: 'rs',
            summary: [
              { type: 'summary_text', text: 'first' },
              { type: 'summary_text', text: 'second' },
            ],
            encrypted_content: 'opaque-final',
          },
          {
            type: 'message',
            id: 'm',
            content: [
              { type: 'output_text', text: 'before' },
              { type: 'output_text', text: 'after' },
            ],
          },
          tool('a', 'Read', '{"path":"a"}'),
        ],
        usage: { input_tokens: 20, output_tokens: 7 },
      },
    };
    const { message } = translate([terminal]);
    expect(message.content.map((block) => block.type)).toEqual([
      'thinking',
      'text',
      'text',
      'tool_use',
    ]);
    expect(message.content[0].thinking).toBe('first\n\nsecond');
    expect(message.content[3].input).toEqual({ path: 'a' });
    expect(aggregateResponsesStream([terminal], 'gpt-6-sol').content).toEqual(
      message.content,
    );
  });

  test('initial arguments are emitted once, without requiring any argument delta', () => {
    const { message } = translate([
      created,
      added(tool('a', 'Read', '{"path":"a"}')),
      done(tool('a', 'Read', '{"path":"a"}')),
      completed,
    ]);
    expect(message.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'Read', input: { path: 'a' } },
    ]);
  });

  test('arguments done supplies only the missing suffix and repeated snapshots do not append JSON', () => {
    const events = [
      created,
      added(tool('a')),
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_a',
        delta: '{"path":',
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_a',
        arguments: '{"path":"a"}',
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_a',
        arguments: '{"path":"a"}',
      },
      done(tool('a', 'Read', '{"path":"a"}')),
      completed,
    ];
    const { wire, message } = translate(events);
    expect(message.content[0].input).toEqual({ path: 'a' });
    expect(
      wire
        .filter(
          (e) =>
            e.event === 'content_block_delta' &&
            (e.data.delta as Json).type === 'input_json_delta',
        )
        .map((e) => (e.data.delta as Json).partial_json)
        .join(''),
    ).toBe('{"path":"a"}');
  });

  test('parallel tool B can finish before A without overlapping SDK blocks or mixing text', () => {
    const { message } = translate([
      created,
      added(tool('a'), 0),
      added(tool('b'), 1),
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: '{"path":"b"}',
      },
      done(tool('b', 'Read', '{"path":"b"}'), 1),
      {
        type: 'response.output_text.delta',
        output_index: 2,
        content_index: 0,
        delta: 'after tools',
      },
      {
        type: 'response.content_part.done',
        output_index: 2,
        content_index: 0,
        part: { type: 'output_text' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"path":"a"}',
      },
      done(tool('a', 'Read', '{"path":"a"}'), 0),
      completed,
    ]);
    expect(message.content.map((block) => block.type)).toEqual([
      'tool_use',
      'tool_use',
      'text',
    ]);
    expect(
      message.content.map((block) => block.input?.path || block.text),
    ).toEqual(['a', 'b', 'after tools']);
  });

  test('argument events arriving before the tool identity are buffered until its name is known', () => {
    const { message } = translate([
      created,
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"path":"a"}',
      },
      added({ type: 'function_call', call_id: 'call_a' }, 0),
      { type: 'response.output_text.delta', output_index: 1, delta: 'answer' },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'message' },
      },
      done(
        {
          type: 'function_call',
          call_id: 'call_a',
          name: 'Read',
          arguments: '{"path":"a"}',
        },
        0,
      ),
      completed,
    ]);
    expect(message.content.map((block) => block.type)).toEqual([
      'text',
      'tool_use',
    ]);
    expect(message.content[1].input).toEqual({ path: 'a' });
  });

  test('a terminal snapshot completes interleaved arguments using stable call IDs despite shifted array positions', () => {
    const events = [
      created,
      added(tool('a'), 4),
      added(tool('b'), 5),
      {
        type: 'response.function_call_arguments.delta',
        output_index: 4,
        delta: '{"path":',
      },
      {
        type: 'response.completed',
        response: {
          output: [
            tool('a', 'Read', '{"path":"a"}'),
            tool('b', 'Read', '{"path":"b"}'),
          ],
          usage: {},
        },
      },
    ];
    expect(
      translate(events).message.content.map((block) => block.input),
    ).toEqual([{ path: 'a' }, { path: 'b' }]);
  });

  test('unresolved unnamed calls do not occupy a block index or claim tool_use', () => {
    const { message } = translate([
      created,
      added({ type: 'function_call', call_id: 'unresolved' }),
      { type: 'response.output_text.delta', output_index: 1, delta: 'ok' },
      completed,
    ]);
    expect(message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(message.stopReason).toBe('end_turn');
  });

  test('terminal name hydration can still recover an earlier unnamed item done', () => {
    const item = { type: 'function_call', id: 'fc_late', call_id: 'call_late' };
    const events = [
      created,
      added(item),
      done({ ...item, arguments: '{"path":"late"}' }),
      {
        type: 'response.completed',
        response: {
          output: [{ ...item, name: 'Read', arguments: '{"path":"late"}' }],
          usage: {},
        },
      },
    ];
    expect(translate(events).message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_late',
        name: 'Read',
        input: { path: 'late' },
      },
    ]);
  });

  test('item and content indices keep interleaved text parts distinct and serial', () => {
    const events = [
      created,
      {
        type: 'response.output_text.delta',
        item_id: 'm',
        output_index: 0,
        content_index: 0,
        delta: 'A',
      },
      {
        type: 'response.output_text.delta',
        item_id: 'm',
        output_index: 0,
        content_index: 1,
        delta: 'B',
      },
      {
        type: 'response.content_part.done',
        item_id: 'm',
        output_index: 0,
        content_index: 1,
        part: { type: 'output_text' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'm',
        output_index: 0,
        content_index: 0,
        delta: '1',
      },
      {
        type: 'response.content_part.done',
        item_id: 'm',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text' },
      },
      done({
        type: 'message',
        id: 'm',
        content: [
          { type: 'output_text', text: 'A1' },
          { type: 'output_text', text: 'B' },
        ],
      }),
      {
        type: 'response.output_text.delta',
        item_id: 'm2',
        output_index: 1,
        content_index: 0,
        delta: 'C',
      },
      completed,
    ];
    expect(translate(events).message.content).toEqual([
      { type: 'text', text: 'A1' },
      { type: 'text', text: 'B' },
      { type: 'text', text: 'C' },
    ]);
  });

  test('done-only message content is retained per item even after another item streamed text', () => {
    expect(
      translate([
        created,
        {
          type: 'response.output_text.delta',
          item_id: 'm1',
          output_index: 0,
          delta: 'first',
        },
        done({ type: 'message', id: 'm1' }, 0),
        done(
          {
            type: 'message',
            id: 'm2',
            content: [{ type: 'output_text', text: 'second' }],
          },
          1,
        ),
        completed,
      ]).message.content,
    ).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  test('multipart reasoning keeps one block and signs only the final encrypted item', () => {
    const { wire, message } = translate([
      created,
      added({ type: 'reasoning', id: 'rs', encrypted_content: 'early' }),
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs',
        summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs',
        summary_index: 0,
        delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs',
        summary_index: 0,
        part: { text: 'first' },
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs',
        summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs',
        summary_index: 1,
        delta: 'second',
      },
      done({ type: 'reasoning', id: 'rs', encrypted_content: 'final' }),
      completed,
    ]);
    expect(message.content[0].thinking).toBe('first\n\nsecond');
    expect(decodeReasoningSignature(message.content[0].signature)).toEqual({
      id: 'rs',
      encryptedContent: 'final',
    });
    expect(
      wire.filter(
        (e) => (e.data.delta as Json | undefined)?.type === 'signature_delta',
      ),
    ).toHaveLength(1);
  });

  test('a tool arriving before reasoning done waits for its final signature', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    const wire = [
      created,
      added({ type: 'reasoning', id: 'rs', encrypted_content: 'pre-content' }),
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs',
        delta: 'thought',
      },
      added(tool('a'), 1),
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_a',
        delta: '{"path":"a"}',
      },
      done(tool('a', 'Read', '{"path":"a"}'), 1),
    ].flatMap((event) => converter.handleEvent(event));
    expect(
      wire.filter(
        (event) =>
          (event.data.delta as Json | undefined)?.type === 'signature_delta',
      ),
    ).toEqual([]);
    expect(
      wire.filter((event) => event.event === 'content_block_start'),
    ).toHaveLength(1);
    wire.push(
      ...converter.handleEvent(
        done({
          type: 'reasoning',
          id: 'rs',
          encrypted_content: 'final-content',
        }),
      ),
      ...converter.handleEvent(completed),
    );
    const message = consume(wire);
    expect(message.content.map((block) => block.type)).toEqual([
      'thinking',
      'tool_use',
    ]);
    expect(decodeReasoningSignature(message.content[0].signature)).toEqual({
      id: 'rs',
      encryptedContent: 'final-content',
    });
    expect(message.content[1].input).toEqual({ path: 'a' });
  });

  test('terminal reasoning hydrate supplies the final signature before releasing a queued tool', () => {
    const events = [
      created,
      added({ type: 'reasoning', id: 'rs', encrypted_content: 'pre-content' }),
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs',
        delta: 'thought',
      },
      added(tool('a'), 1),
      {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'reasoning',
              id: 'rs',
              summary: [{ type: 'summary_text', text: 'thought' }],
              encrypted_content: 'terminal-final',
            },
            tool('a', 'Read', '{"path":"a"}'),
          ],
          usage: {},
        },
      },
    ];
    const { message } = translate(events);
    expect(decodeReasoningSignature(message.content[0].signature)).toEqual({
      id: 'rs',
      encryptedContent: 'terminal-final',
    });
    expect(message.content[1].input).toEqual({ path: 'a' });
  });

  test('interleaved reasoning items retain their own late deltas and final signatures', () => {
    const events = [
      created,
      added({ type: 'reasoning', id: 'rs_a' }, 0),
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_a',
        delta: 'A',
      },
      added({ type: 'reasoning', id: 'rs_b' }, 1),
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_b',
        delta: 'B',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_a',
        delta: '1',
      },
      done({ type: 'reasoning', id: 'rs_b', encrypted_content: 'b' }, 1),
      done({ type: 'reasoning', id: 'rs_a', encrypted_content: 'a' }, 0),
      completed,
    ];
    const { message } = translate(events);
    expect(message.content.map((block) => block.thinking)).toEqual(['A1', 'B']);
    expect(
      message.content.map(
        (block) => decodeReasoningSignature(block.signature)?.encryptedContent,
      ),
    ).toEqual(['a', 'b']);
  });

  test.each([undefined, 'pre-content'])(
    'summary-only reasoning done waits for terminal cipher instead of signing added %j',
    (earlyCipher) => {
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      const events = [
        created,
        added({ type: 'reasoning', id: 'rs', encrypted_content: earlyCipher }),
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs',
          delta: 'thought',
        },
        done({
          type: 'reasoning',
          id: 'rs',
          summary: [{ type: 'summary_text', text: 'thought' }],
        }),
        added(tool('a'), 1),
      ];
      const wire = events.flatMap((event) => converter.handleEvent(event));
      expect(
        wire.filter((event) => event.event === 'content_block_stop'),
      ).toEqual([]);
      expect(
        wire.filter(
          (event) =>
            (event.data.delta as Json | undefined)?.type === 'signature_delta',
        ),
      ).toEqual([]);
      const terminal = {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'reasoning',
              id: 'rs',
              summary: [{ type: 'summary_text', text: 'thought' }],
              encrypted_content: 'terminal-final',
            },
            tool('a', 'Read', '{}'),
          ],
          usage: {},
        },
      };
      wire.push(...converter.handleEvent(terminal));
      const message = consume(wire);
      expect(message.content.map((block) => block.type)).toEqual([
        'thinking',
        'tool_use',
      ]);
      expect(decodeReasoningSignature(message.content[0].signature)).toEqual({
        id: 'rs',
        encryptedContent: 'terminal-final',
      });
      expect(
        aggregateResponsesStream([...events, terminal], 'gpt-6-sol').content,
      ).toEqual(message.content);
    },
  );

  test('an added cipher falls back only after terminal confirms no final cipher, once and before its queued tool', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    const events = [
      added({ type: 'reasoning', id: 'rs', encrypted_content: 'pre-content' }),
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs',
        delta: 'thought',
      },
      done({ type: 'reasoning', id: 'rs', summary: [{ text: 'thought' }] }),
      added(tool('a'), 1),
      done(tool('a', 'Read', '{}'), 1),
    ];
    const wire = events.flatMap((event) => converter.handleEvent(event));
    expect(
      wire.filter(
        (event) =>
          (event.data.delta as Json | undefined)?.type === 'signature_delta',
      ),
    ).toEqual([]);
    expect(
      wire.filter((event) => event.event === 'content_block_stop'),
    ).toEqual([]);
    wire.push(...converter.handleEvent(completed));
    const message = consume(wire);
    expect(message.content[0].thinking).toBe('thought');
    expect(message.content.map((block) => block.type)).toEqual([
      'thinking',
      'tool_use',
    ]);
    expect(decodeReasoningSignature(message.content[0].signature)).toEqual({
      id: 'rs',
      encryptedContent: 'pre-content',
    });
    expect(
      wire.filter(
        (event) =>
          (event.data.delta as Json | undefined)?.type === 'signature_delta',
      ),
    ).toHaveLength(1);
    expect(converter.handleEvent(completed)).toEqual([]);
    expect(
      aggregateResponsesStream([...events, completed], 'gpt-6-sol').content,
    ).toEqual(message.content);
  });

  test('terminal identity hydration claims anonymous summary-only done reasoning before its queued tool', () => {
    const events = [
      { type: 'response.output_item.added', item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'thought' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thought' }],
        },
      },
      added(tool('a'), 1),
      {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'reasoning',
              id: 'rs_terminal',
              summary: [{ type: 'summary_text', text: 'thought' }],
              encrypted_content: 'terminal-final',
            },
            tool('a', 'Read', '{}'),
          ],
          usage: {},
        },
      },
    ];
    const { message } = translate(events);
    expect(message.content.map((block) => block.type)).toEqual([
      'thinking',
      'tool_use',
    ]);
    expect(message.content[0].thinking).toBe('thought');
    expect(decodeReasoningSignature(message.content[0].signature)).toEqual({
      id: 'rs_terminal',
      encryptedContent: 'terminal-final',
    });
    expect(aggregateResponsesStream(events, 'gpt-6-sol').content).toEqual(
      message.content,
    );
  });

  test('signature-only reasoning survives aggregation and consecutive anonymous items remain separate', () => {
    const events = [
      created,
      { type: 'response.output_item.added', item: { type: 'reasoning' } },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', encrypted_content: 'one' },
      },
      { type: 'response.output_item.added', item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'two' },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', encrypted_content: 'two' },
      },
      completed,
    ];
    const { message } = translate(events);
    expect(message.content).toHaveLength(2);
    expect(message.content[0].thinking).toBe('');
    expect(message.content[1].thinking).toBe('two');
    expect(aggregateResponsesStream(events, 'gpt-6-sol').content).toEqual(
      message.content,
    );
  });

  test.each(['response.completed', 'response.incomplete', 'response.done'])(
    'duplicate %s and late content emit nothing after the first terminal',
    (type) => {
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      const terminal = {
        type,
        response: {
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'done' }],
            },
          ],
          usage: {},
        },
      };
      consume(converter.handleEvent(terminal));
      expect(converter.handleEvent(terminal)).toEqual([]);
      expect(
        converter.handleEvent({
          type: 'response.output_text.delta',
          delta: 'late',
        }),
      ).toEqual([]);
      expect(
        converter.handleEvent({
          type: 'response.failed',
          response: { error: { message: 'late failure' } },
        }),
      ).toEqual([]);
      expect(converter.finish()).toEqual([]);
    },
  );

  test.each(['response.failed', 'error'])(
    '%s preserves the error and prevents a later completion from becoming success',
    (type) => {
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      const raw =
        type === 'error'
          ? { type, error: { code: 'cyber_policy', message: 'rejected' } }
          : {
              type,
              response: {
                error: { type: 'invalid_request', message: 'rejected' },
              },
            };
      const events = converter.handleEvent(raw);
      expect(events).toHaveLength(1);
      expect(events[0].data.error).toMatchObject({
        type: 'invalid_request_error',
      });
      expect(converter.handleEvent(completed)).toEqual([]);
      expect(converter.finish()).toEqual([]);
      expect(() =>
        aggregateResponsesStream([raw, completed], 'gpt-6-sol'),
      ).toThrow(expect.objectContaining({ status: 400 }));
    },
  );

  test('premature EOF prevents all later content and terminal frames', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(created);
    expect(converter.finish()[0].event).toBe('error');
    expect(converter.handleEvent(added(tool('late')))).toEqual([]);
    expect(converter.handleEvent(completed)).toEqual([]);
  });

  test.each([
    [
      {
        type: ' Authentication_Error ',
        code: ' INVALID_API_KEY ',
        message: 'fixture',
      },
      'authentication_error',
      401,
    ],
    [{ type: 'permission_error', message: 'fixture' }, 'permission_error', 403],
    [{ code: 'model_not_found', message: 'fixture' }, 'not_found_error', 404],
    [{ type: 'overloaded_error', message: 'fixture' }, 'overloaded_error', 529],
    [
      { code: 'context_length_exceeded', message: 'fixture' },
      'invalid_request_error',
      400,
    ],
    [
      { code: 'context_too_large', message: 'fixture' },
      'invalid_request_error',
      400,
    ],
    [
      { type: 'bad_request_error', message: 'fixture' },
      'invalid_request_error',
      400,
    ],
    [{ status_code: 401, message: 'fixture' }, 'authentication_error', 401],
    [{ status: 503, message: 'fixture' }, 'api_error', 503],
  ])(
    'typed terminal failure %j maps to %s and nonstream status %s',
    (error, expectedType, status) => {
      const event = { type: 'response.failed', response: { error } };
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      expect(converter.handleEvent(event)[0].data.error).toMatchObject({
        type: expectedType,
      });
      expect(() => aggregateResponsesStream([event], 'gpt-6-sol')).toThrow(
        expect.objectContaining({ errorType: expectedType, status }),
      );
    },
  );

  test('bare string terminal errors preserve their message and top-level typed errors preserve classification', () => {
    const stringError = {
      type: 'response.failed',
      response: { error: 'fixture bare error' },
    };
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    expect(converter.handleEvent(stringError)[0].data.error).toEqual({
      type: 'api_error',
      message: 'fixture bare error',
    });
    expect(() =>
      aggregateResponsesStream(
        [
          {
            type: 'error',
            error_type: 'authentication_error',
            message: 'fixture',
          },
        ],
        'gpt-6-sol',
      ),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  test.each(['response.done', 'response.completed', 'response.incomplete'])(
    '%s rejects explicit cancelled/queued/in_progress statuses instead of reporting successful completion',
    (type) => {
      for (const status of ['cancelled', 'queued', 'in_progress']) {
        const terminal = {
          type,
          response: { status, output: [], usage: { output_tokens: 0 } },
        };
        const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
        expect(
          converter.handleEvent(terminal).map((event) => event.event),
        ).toEqual(['error']);
        expect(converter.handleEvent(completed)).toEqual([]);
        expect(() => aggregateResponsesStream([terminal], 'gpt-6-sol')).toThrow(
          expect.objectContaining({
            code: 'invalid_terminal_status',
            status: 502,
          }),
        );
      }
    },
  );

  test.each([undefined, []])(
    'explicit-zero empty incomplete with output %j fails instead of reporting empty success',
    (output) => {
      const terminal = {
        type: 'response.incomplete',
        response: { output, usage: { output_tokens: 0 } },
      };
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      const wire = converter.handleEvent(terminal);
      expect(wire.map((event) => event.event)).toEqual(['error']);
      expect(converter.handleEvent(completed)).toEqual([]);
      expect(() => aggregateResponsesStream([terminal], 'gpt-6-sol')).toThrow(
        expect.objectContaining({ errorType: 'api_error', status: 502 }),
      );
    },
  );

  test.each([{}, { output_tokens: 1 }, { output_tokens: '0' }])(
    'incomplete usage %j is not guessed to be an empty abort',
    (usage) => {
      expect(
        translate([{ type: 'response.incomplete', response: { usage } }])
          .message.stopReason,
      ).toBe('max_tokens');
    },
  );

  test.each([
    [{ type: 'response.output_text.delta', delta: 'text' }],
    [{ type: 'response.reasoning_summary_text.delta', delta: 'thought' }],
    [
      added(tool('a')),
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_a',
        delta: '{}',
      },
    ],
    [done({ type: 'message', id: 'm', content: [] })],
  ])(
    'incomplete after meaningful output %j preserves partial success',
    (...prior) => {
      const terminal = {
        type: 'response.incomplete',
        response: { output: [], usage: { output_tokens: 0 } },
      };
      expect(translate([...prior, terminal]).converter.getFailure()).toBeNull();
    },
  );

  test.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['model_context_window_exceeded', 'model_context_window_exceeded'],
    ['unknown', 'end_turn'],
  ])('incomplete %s uses its actual stop reason', (reason, expected) => {
    const terminal = {
      type: 'response.incomplete',
      response: { incomplete_details: { reason }, usage: {} },
    };
    expect(translate([terminal]).message.stopReason).toBe(expected);
    expect(aggregateResponsesStream([terminal], 'gpt-6-sol').stopReason).toBe(
      expected,
    );
  });

  test('stop sequence and complete cache/reasoning usage are identical across response modes', () => {
    const terminal = {
      type: 'response.completed',
      response: {
        stop_reason: 'stop',
        stop_sequence: 'END',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 9 },
        },
      },
    };
    const { message, converter } = translate([terminal]);
    expect(message.stopReason).toBe('stop_sequence');
    expect(message.usage).toEqual({
      input_tokens: 70,
      output_tokens: 40,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
      output_tokens_details: { thinking_tokens: 9 },
    });
    const aggregated = aggregateResponsesStream([terminal], 'gpt-6-sol');
    expect(aggregated.usage).toEqual(converter.getUsage());
    expect(aggregated.stopSequence).toBe('END');
  });

  test('web search produces server tool blocks and source results once without client tool_use stop', () => {
    const search = {
      type: 'web_search_call',
      id: 'ws_1',
      action: {
        query: 'query',
        sources: [
          { url: 'https://example.org', title: 'Example' },
          { title: 'missing URL' },
        ],
      },
    };
    const events = [
      created,
      added(search),
      done(search),
      done(search),
      { type: 'response.completed', response: { output: [search], usage: {} } },
    ];
    const { message } = translate(events);
    expect(message.content).toEqual([
      {
        type: 'server_tool_use',
        id: 'ws_1',
        name: 'web_search',
        input: { query: 'query' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'ws_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://example.org',
            title: 'Example',
            page_age: null,
          },
        ],
      },
    ]);
    expect(message.stopReason).toBe('end_turn');
    expect(aggregateResponsesStream(events, 'gpt-6-sol').content).toEqual(
      message.content,
    );
  });

  test('long original tool names and call IDs restore consistently with request translation', () => {
    const original = `mcp__server__${'operation_'.repeat(10)}`;
    const tools = [{ name: original }];
    const short = buildCodexToolNameMap(tools).get(original)!;
    const callId = `call_${'identity'.repeat(20)}`;
    const item = {
      type: 'function_call',
      id: 'fc',
      call_id: callId,
      name: short,
      arguments: '{}',
    };
    const events = [created, added(item), done(item), completed];
    const { message } = translate(events, tools);
    expect(message.content[0]).toMatchObject({
      name: original,
      id: shortenCodexCallId(callId),
      input: {},
    });
    expect(
      aggregateResponsesStream(events, 'gpt-6-sol', { tools }).content,
    ).toEqual(message.content);
  });

  test.each(['id', 'output_item_id', 'call_id'])(
    'native search root %s aliases and query fallbacks survive terminal hydration without duplicate blocks',
    (key) => {
      const events = [
        {
          type: 'response.output_item.done',
          [key]: 'ws_root',
          action: { query: '  query  ' },
          results: [{ url: ' https://example.org ', title: ' Example ' }],
          item: { type: 'web_search_call' },
        },
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'web_search_call',
                id: 'ws_root',
                action: {
                  query: 'query',
                  sources: [{ url: 'https://example.org', title: 'Example' }],
                },
              },
            ],
            usage: {},
          },
        },
      ];
      const { message } = translate(events);
      expect(message.content).toEqual([
        {
          type: 'server_tool_use',
          id: 'ws_root',
          name: 'web_search',
          input: { query: 'query' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'ws_root',
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.org',
              title: 'Example',
              page_age: null,
            },
          ],
        },
      ]);
      expect(aggregateResponsesStream(events, 'gpt-6-sol').content).toEqual(
        message.content,
      );
    },
  );

  test.each(['{"private_argument":', '[]', 'null', '42', '"scalar"'])(
    'invalid final arguments fail in both response modes without an empty tool fallback: %s',
    (argumentsJson) => {
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      converter.handleEvent(added(tool('a')));
      expect(() =>
        converter.handleEvent(done(tool('a', 'Read', argumentsJson))),
      ).toThrow(
        expect.objectContaining({
          code: 'invalid_tool_arguments',
          status: 502,
        }),
      );
      expect(converter.getFailure()?.message).not.toContain(argumentsJson);
      expect(converter.handleEvent(completed)).toEqual([]);
      expect(converter.finish()).toEqual([]);
      expect(() =>
        aggregateResponsesStream(
          [
            {
              type: 'response.completed',
              response: {
                output: [tool('a', 'Read', argumentsJson)],
                usage: {},
              },
            },
          ],
          'gpt-6-sol',
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid_tool_arguments' }));
    },
  );

  test('invalid arguments done cannot close a usable SDK tool block', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(added(tool('a')));
    converter.handleEvent({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_a',
      delta: '{"path":',
    });
    expect(() =>
      converter.handleEvent({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_a',
        arguments: '{"path":',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_tool_arguments' }));
    expect(converter.handleEvent(completed)).toEqual([]);
  });

  test.each(['', '   '])(
    'empty arguments remain a valid empty object (%j)',
    (argumentsJson) => {
      const events = [
        created,
        added(tool('a', 'Read', argumentsJson)),
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_a',
          arguments: argumentsJson,
        },
        done(tool('a', 'Read', argumentsJson)),
        completed,
      ];
      expect(translate(events).message.content[0].input).toEqual({});
      expect(
        aggregateResponsesStream(events, 'gpt-6-sol').content[0].input,
      ).toEqual({});
    },
  );

  test('changed arguments after an emitted prefix fail instead of executing corrupted concatenated JSON', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(added(tool('a')));
    converter.handleEvent({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_a',
      delta: '{"path":',
    });
    expect(() =>
      converter.handleEvent({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_a',
        arguments: '{"different":1}',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_stream' }));
  });
});
