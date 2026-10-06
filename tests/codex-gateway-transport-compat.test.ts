import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getProviderById: vi.fn(),
  getResolvedCodexCatalog: vi.fn(),
  fetch: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  getProviderById: mocks.getProviderById,
  updateProviderCodexOAuthCredentialsIfCurrent: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../src/codex-gateway/model-catalog-sync.js', () => ({
  getResolvedCodexCatalog: mocks.getResolvedCodexCatalog,
}));
const { codexGatewayApp } = await import('../src/codex-gateway/gateway.js');
const { codexRequestContext } =
  await import('../src/codex-gateway/request-context.js');
const encoder = new TextEncoder();
let providerNumber = 0;
const created = {
  type: 'response.created',
  response: { id: 'transport-response', model: 'gpt-6-sol' },
};
const delta = { type: 'response.output_text.delta', delta: '你好 🌍' };
const completed = {
  type: 'response.completed',
  response: {
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 10,
    },
  },
};
function frame(event: unknown, ending = '\n'): string {
  return `data: ${JSON.stringify(event)}${ending}${ending}`;
}
function upstream(
  text: string,
  options: { open?: boolean; byteChunks?: boolean; cancel?: () => void } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(text);
        if (options.byteChunks) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        } else controller.enqueue(bytes);
        if (!options.open) controller.close();
      },
      cancel: options.cancel,
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function request(
  stream = false,
  payload: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return codexGatewayApp.request('/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'transport-key',
      ...headers,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      stream,
      ...payload,
    }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  const provider = {
    id: `transport-provider-${++providerNumber}`,
    enabled: true,
    anthropicAuthToken: 'transport-key',
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: {
      accessToken: 'test-upstream-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'test-account',
    },
  };
  mocks.getProviders.mockReturnValue([provider]);
  mocks.getProviderById.mockReturnValue(provider);
  mocks.getResolvedCodexCatalog.mockReturnValue({ models: [] });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Codex executor transport compatibility', () => {
  test.each([false, true])(
    'an explicitly empty zero-token incomplete is a failure (stream=%s)',
    async (stream) => {
      const cancel = vi.fn();
      mocks.fetch.mockResolvedValue(
        upstream(
          frame(created) +
            frame({
              type: 'response.incomplete',
              response: { output: [], usage: { output_tokens: 0 } },
            }),
          { open: true, cancel },
        ),
      );
      const response = await request(stream);
      if (stream) {
        const text = await response.text();
        expect(text).toContain('event: error');
        expect(text).not.toContain('event: message_stop');
      } else {
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({
          error: { type: 'api_error' },
        });
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  test.each([
    [{}, false],
    [{ output_tokens: 1 }, false],
    [{ output_tokens: 0 }, true],
  ])(
    'incomplete with unknown/positive usage or real partial content remains legitimate',
    async (usage, hasDelta) => {
      mocks.fetch.mockResolvedValue(
        upstream(
          frame(created) +
            (hasDelta ? frame(delta) : '') +
            frame({ type: 'response.incomplete', response: { usage } }),
          { open: true },
        ),
      );
      const response = await request();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stop_reason).toBe('max_tokens');
      if (hasDelta)
        expect(body.content).toEqual([{ type: 'text', text: '你好 🌍' }]);
    },
  );

  test('response.done closes transport and retains native stop sequence with complete cache usage', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(
      upstream(
        frame({
          type: 'response.done',
          response: {
            stop_reason: 'stop',
            stop_sequence: 'END',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'final only' }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              input_tokens_details: {
                cached_tokens: 20,
                cache_write_tokens: 10,
              },
              output_tokens_details: { reasoning_tokens: 9 },
            },
          },
        }),
        { open: true, cancel },
      ),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: 'final only' }],
      stop_reason: 'stop_sequence',
      stop_sequence: 'END',
      usage: {
        input_tokens: 70,
        output_tokens: 40,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
        output_tokens_details: { thinking_tokens: 9 },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('terminal in-band rate limits preserve a safe upstream Retry-After', async () => {
    const response = upstream(
      frame({
        type: 'response.failed',
        response: {
          error: {
            code: 'rate_limit_exceeded',
            type: 'rate_limit_error',
            message: 'fixture rejection',
          },
        },
      }),
      { open: true },
    );
    response.headers.set('retry-after', 'Wed, 07 Oct 2026 01:00:00 GMT');
    mocks.fetch.mockResolvedValue(response);
    const result = await request();
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe(
      'Wed, 07 Oct 2026 01:00:00 GMT',
    );
  });

  test.each([
    [401, 'authentication_error', 'invalid_api_key'],
    [403, 'permission_error', 'permission_denied'],
    [404, 'not_found_error', 'model_not_found'],
    [529, 'overloaded_error', 'overloaded'],
  ])(
    'SSE %s rejection retains Anthropic error type %s and HTTP status',
    async (status, type, code) => {
      const cancel = vi.fn();
      mocks.fetch.mockResolvedValue(
        upstream(
          frame({
            type: 'response.failed',
            response: {
              error: {
                type: `  ${String(type).toUpperCase()} `,
                code,
                message: 'PRIVATE_ERROR_DETAIL',
              },
            },
          }) + frame(completed),
          { open: true, cancel },
        ),
      );
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { type } });
      expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
        'PRIVATE_ERROR_DETAIL',
      );
    },
  );

  test.each([
    [
      { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
      undefined,
      ['low', 'medium', 'high'],
      'medium',
      'high',
    ],
    [
      { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
      'low',
      ['low', 'medium', 'high'],
      'medium',
      'low',
    ],
    [
      { thinking: { type: 'enabled', budget_tokens: 256 } },
      undefined,
      ['low', 'medium', 'high'],
      'medium',
      'low',
    ],
    [
      { thinking: { type: 'enabled', budget_tokens: 32000 } },
      undefined,
      ['low', 'medium'],
      'low',
      'low',
    ],
  ])(
    'resolves request effort and provider overrides before the final catalog clamp',
    async (payload, override, efforts, defaultEffort, expected) => {
      mocks.getProviderById.mockReturnValue({
        ...mocks.getProviderById(),
        customEnv: { CODEX_REASONING_EFFORT: override },
      });
      mocks.getResolvedCodexCatalog.mockReturnValue({
        models: [{ value: 'gpt-6-sol', efforts, defaultEffort }],
      });
      mocks.fetch.mockResolvedValue(upstream(frame(completed)));
      expect((await request(false, payload)).status).toBe(200);
      const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
      expect(body.reasoning.effort).toBe(expected);
    },
  );

  test('uses the final model/tier in native OAuth headers, without forwarding client headers', async () => {
    mocks.fetch.mockResolvedValue(upstream(frame(completed)));
    expect(
      (
        await request(
          false,
          { model: 'gpt-6-astra', service_tier: 'priority' },
          {
            'user-agent': 'PRIVATE_CLIENT_USER_AGENT',
            originator: 'PRIVATE_CLIENT_ORIGINATOR',
            'x-codex-routing-hint': 'model=PRIVATE_WRONG_MODEL',
            'x-private-header': 'PRIVATE_CLIENT_HEADER',
          },
        )
      ).status,
    ).toBe(200);
    const headers = new Headers(mocks.fetch.mock.calls[0][1].headers);
    expect(headers.get('user-agent')).toBe(
      'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)',
    );
    expect(headers.get('originator')).toBe('codex-tui');
    expect(headers.get('x-codex-routing-hint')).toBe(
      'model=gpt-6-astra;tier=priority',
    );
    expect(headers.get('x-private-header')).toBeNull();
    expect(JSON.stringify(mocks.fetch.mock.calls[0][1].headers)).not.toContain(
      'PRIVATE_',
    );
  });

  test('preserves SDK session prompt-cache identity across turns without sending raw metadata', async () => {
    mocks.fetch.mockImplementation(async () => upstream(frame(completed)));
    const metadata = {
      user_id: JSON.stringify({
        session_id: 'own-test-session',
        device_id: 'PRIVATE_DEVICE',
      }),
    };
    expect((await request(false, { metadata })).status).toBe(200);
    expect(
      (
        await request(false, {
          metadata,
          messages: [{ role: 'user', content: 'second turn' }],
        })
      ).status,
    ).toBe(200);
    const [first, second] = mocks.fetch.mock.calls.map((call) => ({
      body: JSON.parse(call[1].body),
      headers: new Headers(call[1].headers),
    }));
    expect(first.body.prompt_cache_key).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(first.body.prompt_cache_key).toBe(second.body.prompt_cache_key);
    expect(first.headers.get('session-id')).toBe(first.body.prompt_cache_key);
    expect(first.body).not.toHaveProperty('metadata');
    expect(JSON.stringify(first)).not.toContain('PRIVATE_DEVICE');
  });

  test('cache scope separates providers, accounts, models, sessions, and agents', () => {
    const scope = {
      providerId: 'provider-a',
      accountId: 'account-a',
      model: 'gpt-6-sol',
    };
    const headers = new Headers({ 'x-claude-code-session-id': 'session-a' });
    const key = codexRequestContext(headers, {}, scope).promptCacheKey;
    expect(key).toBeTruthy();
    expect(codexRequestContext(headers, {}, scope).promptCacheKey).toBe(key);
    for (const other of [
      { ...scope, providerId: 'provider-b' },
      { ...scope, accountId: 'account-b' },
      { ...scope, model: 'gpt-6-astra' },
    ])
      expect(codexRequestContext(headers, {}, other).promptCacheKey).not.toBe(
        key,
      );
    expect(
      codexRequestContext(
        new Headers({ 'x-claude-code-session-id': 'session-b' }),
        {},
        scope,
      ).promptCacheKey,
    ).not.toBe(key);
    expect(
      codexRequestContext(
        new Headers({
          'x-claude-code-session-id': 'session-a',
          'x-claude-code-agent-id': 'agent-b',
        }),
        {},
        scope,
      ).promptCacheKey,
    ).not.toBe(key);
  });

  test('header session identity wins over both supported SDK metadata encodings', () => {
    const scope = { providerId: 'p', accountId: null, model: 'gpt-6-sol' };
    const fromHeader = codexRequestContext(
      new Headers({ 'x-claude-code-session-id': 'aabb-1234' }),
      {},
      scope,
    ).promptCacheKey;
    for (const userId of [
      'user_PRIVATE_session_aabb-1234',
      '{"session_id":"aabb-1234","device_id":"PRIVATE"}',
    ]) {
      expect(
        codexRequestContext(
          new Headers(),
          { metadata: { user_id: userId } },
          scope,
        ).promptCacheKey,
      ).toBe(fromHeader);
      expect(
        codexRequestContext(
          new Headers({ 'x-claude-code-session-id': 'other' }),
          { metadata: { user_id: userId } },
          scope,
        ).promptCacheKey,
      ).not.toBe(fromHeader);
    }
  });

  test.each([
    undefined,
    [],
    { user_id: '{broken' },
    { user_id: 'unrecognized-user' },
    { user_id: '{"session_id":42}' },
    { user_id: JSON.stringify({ session_id: 'x'.repeat(1025) }) },
    { user_id: 'x'.repeat(8193) },
  ])(
    'does not establish a shared cache scope for absent/invalid metadata',
    (metadata) => {
      const context = codexRequestContext(
        new Headers(),
        { metadata },
        { providerId: 'p', accountId: null, model: 'gpt-6-sol' },
      );
      expect(context.promptCacheKey).toBeUndefined();
      expect(context.headers).not.toHaveProperty('Session-Id');
    },
  );

  test('restores original tool names in both streaming and nonstreaming gateway responses', async () => {
    const name = `mcp__${'server-name-'.repeat(8)}__do_action`;
    const tools = [{ name, input_schema: { type: 'object', properties: {} } }];
    const toolCompletion = {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'function_call',
            id: 'tool-item',
            call_id: 'call-1',
            name: 'mcp__do_action',
            arguments: '{}',
          },
        ],
      },
    };
    mocks.fetch.mockImplementation(async () =>
      upstream(frame(toolCompletion), { open: true }),
    );
    const response = await request(false, { tools });
    expect(response.status).toBe(200);
    expect((await response.json()).content).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name,
      input: {},
    });
    const stream = await (await request(true, { tools })).text();
    expect(stream).toContain(JSON.stringify(name));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).tools[0].name).toBe(
      'mcp__do_action',
    );
  });

  test.each(['\n', '\r\n', '\r'])(
    'frames %j and split UTF-8/CRLF preserve content and cache-exclusive usage',
    async (ending) => {
      mocks.fetch.mockResolvedValue(
        upstream(
          [created, delta, completed]
            .map((event) => frame(event, ending))
            .join(''),
          { byteChunks: true },
        ),
      );
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        content: [{ type: 'text', text: '你好 🌍' }],
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 80,
          output_tokens: 10,
        },
      });
    },
  );

  test('joins multiline data, uses event name when type is absent, and resets empty frames', async () => {
    mocks.fetch.mockResolvedValue(
      upstream(
        ': heartbeat\nretry: 1000\nid: ignored\nevent: error\n\n' +
          frame(created) +
          'event: response.output_text.delta\ndata: {\ndata: "delta":"你好 🌍"}\n\n' +
          frame(completed),
      ),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).content).toEqual([
      { type: 'text', text: '你好 🌍' },
    ]);
  });

  test.each([false, true])(
    'empty and whitespace data heartbeats do not abort a valid response (stream=%s)',
    async (stream) => {
      mocks.fetch.mockResolvedValue(
        upstream(
          'event: error\ndata:\n\n' +
            frame(created) +
            'data:    \ndata: \n\n' +
            frame(delta) +
            'data:\r\n\r\n' +
            frame(completed),
          { byteChunks: true },
        ),
      );
      const response = await request(stream);
      expect(response.status).toBe(200);
      if (stream) {
        const text = await response.text();
        expect(text).toContain('你好 🌍');
        expect(text).toContain('event: message_stop');
        expect(text).not.toContain('event: error');
      } else {
        expect((await response.json()).content).toEqual([
          { type: 'text', text: '你好 🌍' },
        ]);
      }
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    'terminal success stops an open upstream body (stream=%s)',
    async (stream) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      mocks.fetch.mockResolvedValue(
        upstream(
          [created, delta, completed].map((event) => frame(event)).join(''),
          { open: true, cancel },
        ),
      );
      const pending = request(stream).then(async (response) => ({
        status: response.status,
        body: stream ? await response.text() : await response.json(),
      }));
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(result.status).toBe(200);
      if (stream) {
        expect(result.body).toContain('event: message_stop');
        expect(result.body).not.toContain('event: error');
        expect(String(result.body).match(/event: message_stop/g)).toHaveLength(
          1,
        );
      } else expect(result.body).toMatchObject({ stop_reason: 'end_turn' });
      expect(cancel).toHaveBeenCalledOnce();
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    },
  );

  test('terminal failure also cancels an open body without waiting for EOF', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(
      upstream(
        frame(created) +
          frame({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'rejected' },
          }),
        { open: true, cancel },
      ),
    );
    const pending = request();
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error' },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test.each(['{PRIVATE_INVALID_JSON', 'null', '[]', '"string"', '{"type":42}'])(
    'malformed data %j fails rather than losing a frame and reporting success',
    async (data) => {
      mocks.fetch.mockResolvedValue(
        upstream(frame(created) + `data: ${data}\n\n` + frame(completed)),
      );
      const response = await request();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: { type: 'api_error' },
      });
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
        'PRIVATE_INVALID_JSON',
      );
    },
  );

  test('a malformed streaming frame produces error with no successful terminal', async () => {
    mocks.fetch.mockResolvedValue(
      upstream(frame(created) + 'data: {broken\n\n' + frame(completed)),
    );
    const body = await (await request(true)).text();
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: message_stop');
  });

  test('[DONE] without a Responses terminal cannot fabricate a successful completion', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(
      upstream(frame(created) + 'data: [DONE]\n\n', { open: true, cancel }),
    );
    expect((await request()).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('a large network chunk containing many bounded comment frames is accepted', async () => {
    mocks.fetch.mockResolvedValue(
      upstream(
        (': ' + 'x'.repeat(4096) + '\n').repeat(2200) +
          frame(created) +
          frame(completed),
      ),
    );
    expect((await request()).status).toBe(200);
  });

  test('a single oversized SSE data line remains bounded', async () => {
    mocks.fetch.mockResolvedValue(
      upstream(
        frame({ type: 'codex.metadata', padding: 'x'.repeat(8 * 1024 * 1024) }),
      ),
    );
    expect((await request()).status).toBe(502);
  });

  test.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'invalid_request_error'],
    [422, 'invalid_request_error'],
    [429, 'rate_limit_error'],
    [503, 'api_error'],
    [529, 'overloaded_error'],
  ])(
    'HTTP %s maps to Anthropic %s without reading private error data',
    async (status, type) => {
      const cancel = vi.fn();
      mocks.fetch.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode('PRIVATE_UPSTREAM_ERROR_BODY'));
            },
            cancel,
          }),
          {
            status: Number(status),
            headers: {
              'retry-after': '3',
              'set-cookie': 'PRIVATE_UPSTREAM_COOKIE=1',
            },
          },
        ),
      );
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { type } });
      expect(response.headers.get('retry-after')).toBe('3');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
        'PRIVATE_UPSTREAM',
      );
    },
  );

  test('unexpected Retry-After data is not forwarded', async () => {
    mocks.fetch.mockResolvedValue(
      new Response('untrusted', {
        status: 429,
        headers: { 'retry-after': 'PRIVATE_INVALID_RETRY' },
      }),
    );
    const response = await request();
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
