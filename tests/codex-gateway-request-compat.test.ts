import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  anthropicToResponses,
  buildCodexToolNameMap,
  resolveCodexRequestEffort,
  shortenCodexCallId,
  type AnthropicRequestSubset,
} from '../src/codex-gateway/convert-request.js';
import { encodeReasoningSignature } from '../src/codex-gateway/reasoning-signature.js';
import { CodexMessagesRequestSchema } from '../src/codex-gateway/request-validation.js';

type Json = Record<string, unknown>;
const options = { targetModel: 'gpt-6-sol' };
const user = (content: unknown): Json => ({ role: 'user', content });
const image = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'c2NyZWVu' },
};
const tool = (
  name: string,
  input_schema: Json = { type: 'object', properties: {} },
): Json => ({ name, input_schema });
const call = (id: string, name: string): Json => ({
  type: 'tool_use',
  id,
  name,
  input: { q: id },
});
const result = (id: string, content: unknown): Json => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});
const convert = (request: AnthropicRequestSubset) =>
  anthropicToResponses(request, options);

function rawReasoningSignature(): string {
  const bytes = Buffer.alloc(73);
  bytes[0] = 0x80;
  bytes[8] = 1;
  return bytes.toString('base64url');
}

describe('request-local tool identity compatibility', () => {
  test('maps colliding MCP suffixes identically in declarations, calls, and forced choice', () => {
    const one = `mcp__${'first_server_'.repeat(8)}__search`;
    const two = `mcp__${'other_server_'.repeat(8)}__search`;
    const tools = [tool(one), tool(two), tool('mcp__search')];
    const names = buildCodexToolNameMap(tools);
    expect([...names.values()]).toEqual([
      'mcp__search',
      'mcp__search_1',
      'mcp__search_2',
    ]);
    const converted = convert({
      tools,
      tool_choice: { type: 'tool', name: two },
      messages: [
        { role: 'assistant', content: [call('one', one), call('two', two)] },
      ],
    });
    expect(converted.tools!.map((definition) => definition.name)).toEqual([
      ...names.values(),
    ]);
    expect(converted.input.map((item) => item.name)).toEqual([
      'mcp__search',
      'mcp__search_1',
    ]);
    expect(converted.tool_choice).toEqual({
      type: 'function',
      name: 'mcp__search_1',
    });
    const reverse = new Map(
      [...names].map(([original, shortened]) => [shortened, original]),
    );
    expect(reverse.get('mcp__search_1')).toBe(two);
  });

  test('retains short names and does not split UTF-8 characters at the upstream byte limit', () => {
    const long = '界'.repeat(40);
    const names = buildCodexToolNameMap([
      tool('Bash'),
      tool(long),
      tool(`${long}other`),
    ]);
    expect(names.get('Bash')).toBe('Bash');
    for (const value of names.values()) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
      expect(Buffer.from(value).toString('utf8')).toBe(value);
    }
    expect(new Set(names.values()).size).toBe(3);
  });

  test('uses the reference hash shortening for both long call and result IDs', () => {
    const id = `toolu_${'x'.repeat(80)}`;
    const expected = `${id.slice(0, 47)}_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
    expect(shortenCodexCallId(id)).toBe(expected);
    expect(shortenCodexCallId('short')).toBe('short');
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call(id, 'Bash')] },
        user([result(id, 'ok')]),
      ],
    });
    expect(converted.input.map((item) => item.call_id)).toEqual([
      expected,
      expected,
    ]);
    expect(shortenCodexCallId(`${id}different`)).not.toBe(expected);
  });

  test('rejects duplicate tools and selecting a tool that was not declared', () => {
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [user('hi')],
        tools: [tool('same'), tool('same')],
      }).success,
    ).toBe(false);
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [user('hi')],
        tools: [tool('Bash')],
        tool_choice: { type: 'tool', name: 'missing' },
      }).success,
    ).toBe(false);
  });

  test.each([
    [{ type: 'auto' }, 'auto', true],
    [{ type: 'any', disable_parallel_tool_use: true }, 'required', false],
    [{ type: 'none', disable_parallel_tool_use: false }, 'none', true],
    [{ disable_parallel_tool_use: true }, 'auto', false],
  ])(
    'preserves choice and parallel intent: %j',
    (choice, expectedChoice, parallel) => {
      const request = CodexMessagesRequestSchema.parse({
        messages: [user('hi')],
        tools: [tool('Bash')],
        tool_choice: choice,
      });
      const converted = convert(request);
      expect(converted.tool_choice).toBe(expectedChoice);
      expect(converted.parallel_tool_calls).toBe(parallel);
    },
  );

  test('defaults declared tools to auto, removes all tool controls for missing/empty tools', () => {
    expect(
      convert({ messages: [user('hi')], tools: [tool('Bash')] }).tool_choice,
    ).toBe('auto');
    for (const tools of [undefined, []]) {
      const converted = convert({
        messages: [user('hi')],
        tools,
        tool_choice: { type: 'any', disable_parallel_tool_use: true },
      });
      expect(converted).not.toHaveProperty('tools');
      expect(converted).not.toHaveProperty('tool_choice');
      expect(converted).not.toHaveProperty('parallel_tool_calls');
    }
  });
});

describe('schema normalization at schema positions', () => {
  test('removes dialect metadata and unsupported regex without changing property names or literals', () => {
    const schema = {
      $schema: 'draft',
      $id: 'schema-id',
      type: ['object', 'null'],
      properties: {
        $schema: { type: 'string', $schema: 'nested-draft' },
        $id: { type: 'string' },
        value: {
          type: 'string',
          $id: 'annotation',
          pattern: String.raw`\p{L}+`,
          default: { $id: 'literal', pattern: String.raw`\p{L}` },
        },
        config: {
          type: 'object',
          properties: {
            path: { type: 'string', pattern: String.raw`^[^\0]*$` },
          },
        },
      },
      patternProperties: {
        [String.raw`\P{L}`]: { type: 'string' },
        '^ok': { type: 'string', $schema: 'draft' },
      },
      $defs: { id: { type: 'string', $id: 'definition' } },
      anyOf: [{ type: 'string', pattern: String.raw`\\p{L}` }],
    };
    const original = structuredClone(schema);
    const converted = convert({
      messages: [user('hi')],
      tools: [tool('schema', schema)],
    });
    const parameters = converted.tools![0].parameters as typeof schema;
    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters).not.toHaveProperty('$id');
    expect(parameters.properties.$schema).toEqual({ type: 'string' });
    expect(parameters.properties.$id).toEqual({ type: 'string' });
    expect(parameters.properties.value).toEqual({
      type: 'string',
      default: { $id: 'literal', pattern: String.raw`\p{L}` },
    });
    expect(parameters.properties.config.properties.path).toEqual({
      type: 'string',
    });
    expect(parameters.patternProperties).toEqual({ '^ok': { type: 'string' } });
    expect(parameters.$defs).toEqual({ id: { type: 'string' } });
    expect(parameters.anyOf).toEqual([
      { type: 'string', pattern: String.raw`\\p{L}` },
    ]);
    expect(schema).toEqual(original);
  });

  test('normalizes deeply nested valid JSON without structuredClone stack overflow', () => {
    let schema: Json = { type: 'string', $schema: 'draft' };
    for (let depth = 0; depth < 2000; depth++) schema = { items: schema };
    const converted = convert({
      messages: [user('hi')],
      tools: [tool('deep', schema)],
    });
    let leaf = converted.tools![0].parameters as Json;
    for (let depth = 0; depth < 2000; depth++) leaf = leaf.items as Json;
    expect(leaf).toEqual({ type: 'string' });
    expect(JSON.stringify(converted)).toContain('"name":"deep"');
  });

  test('supplies missing object properties and preserves optional tool arguments', () => {
    const converted = convert({
      messages: [user('hi')],
      tools: [
        tool('default', {}),
        tool('union', { type: ['object', 'null'] }),
        tool('optional', {
          type: 'object',
          properties: { value: { type: 'string' } },
        }),
      ],
    });
    expect(converted.tools![0].parameters).toEqual({
      type: 'object',
      properties: {},
    });
    expect(converted.tools![1].parameters).toEqual({
      type: ['object', 'null'],
      properties: {},
    });
    expect(converted.tools![2]).toMatchObject({
      strict: false,
      parameters: { properties: { value: { type: 'string' } } },
    });
    expect(converted.tools![2].parameters).not.toHaveProperty('required');
  });
});

describe('CPA executor pure const-union compaction', () => {
  const branches = (values: unknown[]): Json[] =>
    values.map((value, index) => ({
      const: value,
      title: `Case ${index}`,
      description: `Description ${index}`,
    }));
  const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const parametersFor = (property: Json): Json =>
    convert({
      messages: [user('hi')],
      tools: [
        tool('union', {
          type: 'object',
          properties: { 'mode.:selector': property },
        }),
      ],
    }).tools![0].parameters as Json;
  const propertyFor = (property: Json): Json =>
    (parametersFor(property).properties as Json)['mode.:selector'] as Json;

  test.each(['oneOf', 'anyOf'])(
    'compacts >=8 unique scalar %s constants and preserves sibling constraints',
    (keyword) => {
      const original = {
        type: 'string',
        description: 'Mode',
        default: 'a',
        [keyword]: branches(values),
      };
      expect(propertyFor(original)).toEqual({
        type: 'string',
        description: 'Mode',
        default: 'a',
        enum: values,
      });
      expect(original).toHaveProperty(keyword);
    },
  );

  test('keeps existing equivalent enum order while removing the redundant union', () => {
    const existing = [...values].reverse();
    expect(
      propertyFor({ type: 'string', enum: existing, oneOf: branches(values) }),
    ).toEqual({ type: 'string', enum: existing });
  });

  test('handles null, booleans, numbers, and numeric strings as distinct scalar values', () => {
    const scalars = [null, true, false, 0, 1, 0.5, '0', '1'];
    expect(propertyFor({ anyOf: branches(scalars) })).toEqual({
      enum: scalars,
    });
  });

  test.each([
    { oneOf: branches(values.slice(0, 7)) },
    { oneOf: branches(values), anyOf: [{ type: 'string' }] },
    { oneOf: branches([...values.slice(0, 7), 'a']) },
    { anyOf: branches([...values.slice(0, 7), 'a']) },
    { oneOf: branches([1, 1.0, 2, 3, 4, 5, 6, 7]) },
    { oneOf: branches([-0, 0, 2, 3, 4, 5, 6, 7]) },
    { oneOf: [...branches(values.slice(0, 7)), { const: 'h', minLength: 1 }] },
    {
      oneOf: [...branches(values.slice(0, 7)), { const: 'h', type: 'string' }],
    },
    { oneOf: branches([...values.slice(0, 7), {}]) },
    { oneOf: branches([...values.slice(0, 7), []]) },
    { oneOf: branches(values), enum: [...values, 'extra'] },
    { oneOf: branches(values), enum: [...values.slice(0, 7), 'a'] },
    {
      oneOf: branches([1, 2, 3, 4, 5, 6, 7, 8]),
      enum: ['1', '2', '3', '4', '5', '6', '7', '8'],
    },
    { oneOf: branches(values), enum: null },
    { oneOf: branches([Number.MAX_SAFE_INTEGER + 1, 1, 2, 3, 4, 5, 6, 7]) },
    { anyOf: branches([-Number.MAX_SAFE_INTEGER - 1, 1, 2, 3, 4, 5, 6, 7]) },
  ])(
    'retains unions when semantic equivalence is not proven: %#',
    (property) => {
      expect(propertyFor(property)).toEqual(
        JSON.parse(JSON.stringify(property)),
      );
    },
  );

  test('preserves nested property unions and structured-output schemas outside the reference scope', () => {
    const nested = {
      type: 'object',
      properties: { mode: { oneOf: branches(values) } },
    };
    const converted = convert({
      messages: [user('hi')],
      tools: [tool('nested', { type: 'object', properties: { nested } })],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { mode: { oneOf: branches(values) } },
          },
        },
      },
    });
    expect(
      ((converted.tools![0].parameters as Json).properties as Json).nested,
    ).toEqual(nested);
    expect(
      ((converted.text!.format.schema as Json).properties as Json).mode,
    ).toHaveProperty('oneOf');
  });
});

describe('ordered messages and multimodal tool results', () => {
  test('preserves alternating text, image, and PDF blocks in place', () => {
    const converted = convert({
      messages: [
        user([
          { type: 'text', text: 'before' },
          image,
          { type: 'text', text: 'between' },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'cGRm',
            },
          },
          { type: 'text', text: 'after' },
        ]),
      ],
    });
    expect(converted.input[0].content).toEqual([
      { type: 'input_text', text: 'before' },
      { type: 'input_image', image_url: 'data:image/png;base64,c2NyZWVu' },
      { type: 'input_text', text: 'between' },
      {
        type: 'input_file',
        file_data: 'data:application/pdf;base64,cGRm',
        filename: 'document.pdf',
      },
      { type: 'input_text', text: 'after' },
    ]);
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [
          user([
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'cGRm',
              },
            },
          ]),
        ],
      }).success,
    ).toBe(true);
  });

  test('keeps result images within the originating function output in their original order', () => {
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call('screen', 'screenshot')] },
        user([
          result('screen', [
            { type: 'text', text: 'before' },
            image,
            { type: 'text', text: 'after' },
          ]),
        ]),
      ],
    });
    expect(converted.input).toHaveLength(2);
    expect(converted.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'screen',
      output: [
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: 'data:image/png;base64,c2NyZWVu' },
        { type: 'input_text', text: 'after' },
      ],
    });
  });

  test('aligns complete parallel results while preserving the indexes of non-result text', () => {
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [call('one', 'Bash'), call('two', 'Read')],
        },
        user([
          result('two', '2'),
          { type: 'text', text: 'between' },
          result('one', '1'),
        ]),
      ],
    });
    expect(converted.input.slice(2)).toEqual([
      { type: 'function_call_output', call_id: 'one', output: '1' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'between' }],
      },
      { type: 'function_call_output', call_id: 'two', output: '2' },
    ]);
  });

  test('leaves partial or unmatched result sets in their original order', () => {
    for (const feedback of [
      [result('two', '2')],
      [result('two', '2'), result('unknown', '?')],
    ]) {
      const converted = convert({
        messages: [
          {
            role: 'assistant',
            content: [call('one', 'Bash'), call('two', 'Read')],
          },
          user(feedback),
        ],
      });
      expect(converted.input.slice(2).map((item) => item.call_id)).toEqual(
        feedback.map((item) => item.tool_use_id),
      );
    }
  });

  test('places top-level system instructions before conversation and omits billing attribution', () => {
    const converted = convert({
      system: [
        { type: 'text', text: ' \nx-anthropic-billing-header: fingerprint' },
        { type: 'text', text: 'Rules' },
        { type: 'text', text: 'More rules' },
      ],
      messages: [user('hello')],
    });
    expect(converted.instructions).toBe('');
    expect(converted.input[0]).toEqual({
      type: 'message',
      role: 'developer',
      content: [
        { type: 'input_text', text: 'Rules' },
        { type: 'input_text', text: 'More rules' },
      ],
    });
    expect(converted.input[1].role).toBe('user');
  });

  test('defers between-call system reminders until matching parallel results are emitted', () => {
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [call('one', 'Bash'), call('two', 'Read')],
        },
        { role: 'system', content: 'Use this repo' },
        {
          role: 'system',
          content: [{ type: 'text', text: 'Latest instructions' }],
        },
        user([
          result('two', '2'),
          result('one', '1'),
          { type: 'text', text: 'Summarize' },
        ]),
      ],
    });
    expect(converted.input.map((item) => item.type)).toEqual([
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
      'message',
      'message',
      'message',
    ]);
    expect(converted.input.slice(2, 4).map((item) => item.call_id)).toEqual([
      'one',
      'two',
    ]);
    expect((converted.input[4].content as Json[])[0].text).toBe(
      '<system-reminder>\nUse this repo\n</system-reminder>',
    );
    expect((converted.input[5].content as Json[])[0].text).toBe(
      '<system-reminder>\nLatest instructions\n</system-reminder>',
    );
    expect((converted.input[6].content as Json[])[0].text).toBe('Summarize');
  });

  test('matches reference string-message ordering and retains empty text blocks', () => {
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call('one', 'Bash')] },
        { role: 'system', content: 'Current directive' },
        user('follow-up'),
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
    });
    expect((converted.input[1].content as Json[])[0].text).toBe('follow-up');
    expect((converted.input[2].content as Json[])[0].text).toBe(
      '<system-reminder>\nCurrent directive\n</system-reminder>',
    );
    expect(converted.input[3]).toMatchObject({
      content: [{ type: 'output_text', text: '' }],
    });
  });

  test('retains a trailing reminder even when no tool results follow', () => {
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call('one', 'Bash')] },
        { role: 'system', content: 'Trailing directive' },
      ],
    });
    expect(converted.input[1]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '<system-reminder>\nTrailing directive\n</system-reminder>',
        },
      ],
    });
  });
});

describe('reasoning replay and request intent', () => {
  test.each([
    rawReasoningSignature(),
    `gpt#${rawReasoningSignature()}`,
    encodeReasoningSignature({
      id: 'rs_legacy',
      encryptedContent: 'legacy-cipher',
    })!,
  ])('replays compatible reasoning without stale item ID: %s', (signature) => {
    const cipher = signature.startsWith('codexrs1_')
      ? 'legacy-cipher'
      : rawReasoningSignature();
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before' },
            { type: 'thinking', thinking: 'summary', signature },
            call('next', 'Bash'),
          ],
        },
      ],
    });
    expect(converted.input[1]).toEqual({
      type: 'reasoning',
      summary: [],
      content: null,
      encrypted_content: cipher,
    });
    expect(converted.input[2].type).toBe('function_call');
    expect(converted.input[1]).not.toHaveProperty('id');
  });

  test('does not replay user-side, foreign, missing, or redacted thinking', () => {
    const converted = convert({
      messages: [
        user([
          {
            type: 'thinking',
            thinking: 'user supplied',
            signature: rawReasoningSignature(),
          },
        ]),
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'foreign',
              signature: 'claude#foreign',
            },
            { type: 'thinking', thinking: 'unsigned' },
            { type: 'redacted_thinking', data: 'foreign' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    });
    expect(converted.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    ]);
  });

  test.each([
    [-1, 'auto'],
    [0, 'none'],
    [512, 'minimal'],
    [513, 'low'],
    [1024, 'low'],
    [1025, 'medium'],
    [8192, 'medium'],
    [8193, 'high'],
    [24576, 'high'],
    [24577, 'xhigh'],
  ])(
    'maps SDK budget %i to reference effort %s before catalog clamping',
    (budget_tokens, effort) => {
      expect(
        resolveCodexRequestEffort({
          thinking: { type: 'enabled', budget_tokens },
        }),
      ).toBe(effort);
    },
  );

  test('uses explicit provider effort over adaptive SDK defaults', () => {
    const request = {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    };
    expect(resolveCodexRequestEffort(request)).toBe('high');
    expect(resolveCodexRequestEffort(request, 'low')).toBe('low');
    expect(resolveCodexRequestEffort({ thinking: { type: 'adaptive' } })).toBe(
      'xhigh',
    );
    expect(resolveCodexRequestEffort({ thinking: { type: 'disabled' } })).toBe(
      'none',
    );
    expect(resolveCodexRequestEffort({}, 'minimal')).toBe('low');
  });

  test('translates speed/service-tier priority without forwarding unsupported tier names', () => {
    expect(
      convert({ messages: [user('hi')], speed: 'fast' }).service_tier,
    ).toBe('priority');
    expect(
      convert({ messages: [user('hi')], service_tier: ' PRIORITY ' })
        .service_tier,
    ).toBe('priority');
    expect(
      convert({ messages: [user('hi')], service_tier: 'standard' }),
    ).not.toHaveProperty('service_tier');
  });
});

describe('structured output and native web search', () => {
  test('preserves fully required JSON output schemas and downgrades incomplete nested strict schemas', () => {
    const valid = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    expect(
      convert({
        messages: [user('hi')],
        output_config: { format: { type: 'json_schema', schema: valid } },
      }).text,
    ).toEqual({
      format: {
        type: 'json_schema',
        name: 'cli_proxy_structured_output',
        strict: true,
        schema: valid,
      },
    });
    const optional = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { value: { type: 'string' } } },
      },
      required: ['nested'],
    };
    expect(
      convert({
        messages: [user('hi')],
        output_config: {
          format: { type: 'json_schema', name: 'custom', schema: optional },
        },
      }).text!.format,
    ).toMatchObject({ name: 'custom', strict: false, schema: optional });
    expect(
      convert({
        messages: [user('hi')],
        output_config: {
          format: { type: 'json_schema', strict: false, schema: valid },
        },
      }).text!.format.strict,
    ).toBe(false);
  });

  test.each(['web_search_20250305', 'web_search_20260209'])(
    'translates typed search %s without treating local tools with the same name as native',
    (type) => {
      const converted = convert({
        messages: [user('hi')],
        tools: [
          {
            type,
            name: 'browser_search',
            allowed_domains: ['example.com'],
            user_location: { type: 'approximate', city: 'Paris' },
          },
          tool('web_search'),
        ],
        tool_choice: { type: 'tool', name: 'browser_search' },
      });
      expect(converted.tools![0]).toEqual({
        type: 'web_search',
        filters: { allowed_domains: ['example.com'] },
        user_location: { type: 'approximate', city: 'Paris' },
      });
      expect(converted.tools![1]).toMatchObject({
        type: 'function',
        name: 'web_search',
      });
      expect(converted.tool_choice).toEqual({ type: 'web_search' });
      expect(converted.include).toContain('web_search_call.action.sources');
      expect(
        convert({ messages: [user('hi')], tools: [tool('web_search')] })
          .include,
      ).not.toContain('web_search_call.action.sources');
    },
  );

  test('accepts server-search response history and does not invent client function calls', () => {
    const request = CodexMessagesRequestSchema.parse({
      messages: [
        user('search'),
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'ws_1',
              name: 'web_search',
              input: { query: 'research' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'ws_1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://example.com',
                  title: 'Example',
                  page_age: null,
                },
              ],
            },
            { type: 'text', text: 'Answer with sources' },
          ],
        },
      ],
    });
    const converted = convert(request);
    expect(converted.input.map((item) => item.type)).toEqual([
      'message',
      'message',
    ]);
    expect((converted.input[1].content as Json[])[0].text).toBe(
      'Answer with sources',
    );
  });
});

describe('consumed-shape validation', () => {
  test.each([
    { tool_choice: { type: 'auto', disable_parallel_tool_use: 'yes' } },
    { thinking: { type: 'enabled', budget_tokens: -2 } },
    { thinking: { type: 'enabled', budget_tokens: '8192' } },
    { output_config: { format: { type: 'json_schema', schema: [] } } },
    {
      output_config: {
        format: { type: 'json_schema', schema: {}, strict: 'yes' },
      },
    },
    {
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: 'example.com',
        },
      ],
    },
    {
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          user_location: { type: 'precise' },
        },
      ],
    },
  ])('rejects malformed consumed configuration: %j', (configuration) => {
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [user('hi')],
        ...configuration,
      }).success,
    ).toBe(false);
  });

  test('rejects unsupported image URLs/PDF sources instead of silently omitting user content', () => {
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [
          user([
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/image.png' },
            },
          ]),
        ],
      }).success,
    ).toBe(false);
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [
          user([
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'text/plain',
                data: 'text',
              },
            },
          ]),
        ],
      }).success,
    ).toBe(false);
  });

  test('preserves unrelated SDK fields through validation but omits them upstream', () => {
    const request = CodexMessagesRequestSchema.parse({
      messages: [user('hi')],
      metadata: { user_id: 'session' },
      context_management: { edits: [] },
      temperature: 1,
      max_tokens: 100,
    });
    const converted = convert(request);
    for (const field of [
      'metadata',
      'context_management',
      'temperature',
      'max_tokens',
    ])
      expect(converted).not.toHaveProperty(field);
  });
});
