import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getProviderById: vi.fn(),
  fetch: vi.fn(),
  limiters: [] as Array<{ size: number }>,
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  getProviderById: mocks.getProviderById,
  updateProviderCodexOAuthCredentialsIfCurrent: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../src/codex-gateway/model-catalog-sync.js', () => ({
  getResolvedCodexCatalog: () => ({ models: [] }),
}));
vi.mock(
  '../src/codex-gateway/provider-rate-limit.js',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../src/codex-gateway/provider-rate-limit.js')
      >();
    return {
      CodexProviderRateLimiter: class extends real.CodexProviderRateLimiter {
        constructor() {
          super();
          mocks.limiters.push(this);
        }
      },
    };
  },
);
const { codexGatewayApp } = await import('../src/codex-gateway/gateway.js');
let fixtureNumber = 0;
let provider: Record<string, unknown>;
const encoder = new TextEncoder();
const created = {
  type: 'response.created',
  response: { id: 'resp-http', model: 'gpt-6-sol' },
};
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
function frame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}
function upstreamEvents(events = [created, completed]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        events.forEach((event) => c.enqueue(frame(event)));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function request(
  payload: unknown = {
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  },
  key = 'valid-gateway',
  init: RequestInit = {},
): Promise<Response> {
  return codexGatewayApp.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(payload),
    ...init,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  provider = {
    id: `provider-${++fixtureNumber}`,
    enabled: true,
    anthropicAuthToken: 'valid-gateway',
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: {
      accessToken: 'fake-upstream',
      refreshToken: 'fake-refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'business-workspace',
    },
  };
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.getProviderById.mockImplementation(() => structuredClone(provider));
  mocks.fetch.mockImplementation(async () => upstreamEvents());
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Codex gateway HTTP boundary', () => {
  test('random unauthenticated keys allocate no rate counters and never call upstream', async () => {
    const before = mocks.limiters[0].size;
    for (let i = 0; i < 1200; i++)
      expect((await request(undefined, `invalid-${i}`)).status).toBe(401);
    expect(mocks.limiters[0].size).toBe(before);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await request()).status).toBe(200);
  });

  test('rate budget follows authenticated provider ID across gateway key rotation', async () => {
    for (let i = 0; i < 120; i++) {
      // Malformed requests consume budget without spending upstream subscription.
      expect((await request(null)).status).toBe(400);
    }
    provider.anthropicAuthToken = 'rotated-key';
    expect((await request(undefined, 'rotated-key')).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test.each([
    null,
    [],
    {},
    { messages: null },
    { messages: 'bad' },
    { messages: [{ role: 'unknown', content: 'bad' }] },
    {
      messages: [
        {
          role: 'system',
          content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: {} }],
        },
      ],
    },
    { messages: [{ role: 'user', content: [null] }] },
    { messages: [{ role: 'user', content: 'hi' }], tools: 'bad' },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'missing call id' }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.invalid/image.png' },
            },
          ],
        },
      ],
    },
  ])(
    'malformed consumed input returns 400 before upstream (%#)',
    async (payload) => {
      const response = await request(payload);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'invalid_request_error' },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  test('authenticated oversized request bodies receive 413 before JSON buffering', async () => {
    const response = await request(undefined, 'valid-gateway', {
      headers: {
        'x-api-key': 'valid-gateway',
        'content-type': 'application/json',
        'content-length': String(40 * 1024 * 1024),
      },
    });
    expect(response.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('sends the account header and cache-exclusive nonstream usage', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 80,
        output_tokens: 10,
      },
    });
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer fake-upstream',
      'chatgpt-account-id': 'business-workspace',
    });
  });

  test('preserves SDK system reminders at their conversation position', async () => {
    const response = await request({
      model: 'claude-sonnet-4-6',
      system: [
        {
          type: 'text',
          text: 'You are an assistant with Bash.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read README.' }] },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '<system-reminder>Use Bash.</system-reminder>',
            },
          ],
        },
      ],
      tools: [
        { name: 'Bash', input_schema: { type: 'object', properties: {} } },
      ],
      stream: true,
      max_tokens: 32_000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      context_management: { edits: [] },
      metadata: { user_id: 'sdk-test' },
    });
    expect(response.status).toBe(200);
    await response.text();
    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(body.instructions).toBe('');
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'You are an assistant with Bash.' },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read README.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<system-reminder>\n<system-reminder>Use Bash.</system-reminder>\n</system-reminder>',
          },
        ],
      },
    ]);
    expect(body.tools[0].name).toBe('Bash');
    expect(body.thinking).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  test('SSE publishes cache-exclusive usage and a single successful terminal', async () => {
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const text = await response.text();
    expect(text).toContain('"input_tokens":20');
    expect(text).toContain('"cache_read_input_tokens":80');
    expect(text.match(/event: message_stop/g)).toHaveLength(1);
    expect(text).not.toContain('event: error');
  });

  test('tool screenshot reaches upstream with its call identity', async () => {
    const response = await request({
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'screen', name: 'screenshot', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'screen',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'c2NyZWVu',
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    const translated = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(translated.input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'screen',
    });
    expect(translated.input[1].output).toContainEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,c2NyZWVu',
    });
  });

  test('downstream cancellation cancels a pending upstream without enqueue/close errors', async () => {
    const cancel = vi.fn();
    let signal!: AbortSignal;
    mocks.fetch.mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(frame(created));
          },
          cancel,
        }),
      );
    });
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  test('client request abort also terminates a pending nonstream upstream reader', async () => {
    const cancel = vi.fn();
    let opened!: () => void;
    const bodyOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
              opened();
            },
            cancel,
          }),
        ),
    );
    const client = new AbortController();
    const pending = request(undefined, 'valid-gateway', {
      signal: client.signal,
    });
    await bodyOpened;
    // Let the response attach its upstream reader's abort handler.
    await Promise.resolve();
    client.abort();
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalled();
  });

  test('a slow consumer does not drain an entire upstream into an unbounded queue', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulls++;
              c.enqueue(
                frame(
                  pulls === 1
                    ? created
                    : { type: 'response.output_text.delta', delta: 'more' },
                ),
              );
            },
            cancel,
          }),
        ),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBeLessThanOrEqual(3);
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  test('a success terminal without a trailing SSE separator is preserved', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
              c.enqueue(encoder.encode(`data: ${JSON.stringify(completed)}`));
              c.close();
            },
          }),
        ),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 80,
      },
    });
  });

  test('stalled SSE cancels upstream and emits an error without a success terminal', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
            },
            cancel,
          }),
        ),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read(); // message_start
    await reader.read(); // ping
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(60_000);
    const chunk = await pending;
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: message_stop');
    expect((await reader.read()).done).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  test('an upstream error body is cancelled without reading or logging its contents', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode('SECRET echo'));
            },
            cancel,
          }),
          { status: 401 },
        ),
    );
    expect((await request()).status).toBe(401);
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'SECRET',
    );
  });
});
