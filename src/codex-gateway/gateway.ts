// ─── ChatGPT/Codex 订阅网关 — Hono 子应用 ──────────────────────────
//
// 挂载在主服务 CODEX_GATEWAY_ROUTE 下，只处理 Claude Agent SDK 会发出的
// POST {route}/v1/messages。鉴权用 provider 的 gateway token（SDK 把裸
// token 当 ANTHROPIC_API_KEY 发送，落在 x-api-key 头），不是真实 ChatGPT
// token —— 真实 token 只在网关进程内部持有，不会下发给 Runner/容器。

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { logger } from '../logger.js';
import { getProviderById } from '../runtime-config.js';
import type { ReadableStreamReadResult } from 'node:stream/web';
import {
  anthropicToResponses,
  normalizeCodexEffort,
  resolveCodexModel,
  resolveCodexRequestEffort,
  type AnthropicRequestSubset,
} from './convert-request.js';
import { clampCodexEffortWithCatalog } from './model-catalog.js';
import { getResolvedCodexCatalog } from './model-catalog-sync.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
  CodexUpstreamError,
  type AnthropicStreamEvent,
} from './convert-response.js';
import {
  CodexGatewayAuthError,
  resolveCodexAccess,
  resolveCodexProvider,
} from './token-manager.js';
import { CodexProviderRateLimiter } from './provider-rate-limit.js';
import { CodexMessagesRequestSchema } from './request-validation.js';
import { CODEX_BACKEND_RESPONSES_URL } from './types.js';
import { codexRequestContext } from './request-context.js';

export const codexGatewayApp = new Hono<{
  Variables: { codexGatewayToken: string };
}>();

function sseEncode(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

// Authenticate before allocating counters or reading a request body. Keying
// by provider ID also preserves its budget across gateway-key rotations.
const providerRateLimiter = new CodexProviderRateLimiter();
const requestBodyLimit = bodyLimit({
  maxSize: 32 * 1024 * 1024,
  onError: (c) =>
    c.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Payload too large' },
      },
      413,
    ),
});

/** 成功代理请求的轻量审计日志：只记模型与 token 用量，不记消息内容。 */
function logGatewaySuccess(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  },
): void {
  logger.info(
    {
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    },
    'Codex gateway: request proxied',
  );
}

function extractGatewayToken(headers: Headers): string | null {
  const apiKey = headers.get('x-api-key');
  if (apiKey) return apiKey.trim();
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return null;
}

function upstreamHttpErrorType(status: number): string {
  switch (status) {
    case 400:
    case 413:
    case 422:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

function upstreamRetryHeaders(headers: Headers): Record<string, string> {
  const retryAfter = headers.get('retry-after')?.trim();
  if (
    retryAfter &&
    retryAfter.length <= 128 &&
    (/^\d+(?:\.\d+)?$/.test(retryAfter) ||
      (/GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))))
  ) {
    return { 'Retry-After': retryAfter };
  }
  return {};
}

const UPSTREAM_EVENT_LIMIT = 8 * 1024 * 1024;
const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
  'error',
]);

/** Parse bounded SSE frames across arbitrary UTF-8 chunks and line endings. */
async function* iterateUpstreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let lineParts: string[] = [];
  let lineBytes = 0;
  let skipLf = false;
  let eventName = '';
  let dataParts: string[] = [];
  let eventBytes = 0;
  let terminalSeen = false;
  let reachedEof = false;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const flush = function* (): Generator<Record<string, unknown>> {
    const data = dataParts.join('\n');
    const name = eventName;
    const hasData = dataParts.length > 0;
    // Even a comment-only/event-only frame resets its event name.
    eventName = '';
    dataParts = [];
    eventBytes = 0;
    // Empty data frames are valid keepalives, not malformed JSON events.
    if (!hasData || !data.trim()) return;
    if (data.trim() === '[DONE]') {
      // The sentinel ends framing, but never replaces a Responses terminal.
      terminalSeen = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // SyntaxError messages can quote private upstream data. Keep the error
      // generic and fail the request instead of silently dropping output.
      throw new Error('Upstream Codex SSE contains invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Upstream Codex SSE event is not an object');
    }
    const event = parsed as Record<string, unknown>;
    if (event.type === undefined && name) event.type = name;
    if (event.type !== undefined && typeof event.type !== 'string') {
      throw new Error('Upstream Codex SSE event has an invalid type');
    }
    terminalSeen = TERMINAL_EVENT_TYPES.has(String(event.type));
    yield event;
  };

  const consumeLine = function* (
    line: string,
  ): Generator<Record<string, unknown>> {
    if (line === '') {
      yield* flush();
      return;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      eventBytes += Buffer.byteLength(value) + (dataParts.length ? 1 : 0);
      if (eventBytes > UPSTREAM_EVENT_LIMIT) {
        throw new Error('Upstream Codex SSE event exceeds size limit');
      }
      dataParts.push(value);
    }
  };

  const consumeText = function* (
    text: string,
  ): Generator<Record<string, unknown>> {
    let start = 0;
    const endings = /[\r\n]/g;
    for (let match; (match = endings.exec(text)); ) {
      if (skipLf && match.index === start && match[0] === '\n') {
        skipLf = false;
        start = match.index + 1;
        continue;
      }
      skipLf = false;
      const part = text.slice(start, match.index);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > UPSTREAM_EVENT_LIMIT) {
        throw new Error('Upstream Codex SSE line exceeds size limit');
      }
      lineParts.push(part);
      const line = lineParts.join('');
      lineParts = [];
      lineBytes = 0;
      start = match.index + 1;
      skipLf = match[0] === '\r';
      yield* consumeLine(line);
      if (terminalSeen) return;
    }
    if (start < text.length) {
      skipLf = false;
      const part = text.slice(start);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > UPSTREAM_EVENT_LIMIT) {
        throw new Error('Upstream Codex SSE line exceeds size limit');
      }
      lineParts.push(part);
    }
  };

  try {
    for (;;) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new Error('Upstream Codex stream stalled'));
        }, 60_000);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      signal.throwIfAborted();
      const { value, done } = result;
      if (done) {
        reachedEof = true;
        break;
      }
      yield* consumeText(decoder.decode(value, { stream: true }));
      // A semantic terminal is authoritative even if the peer keeps the HTTP
      // body open. Do not wait for EOF or append a timeout after message_stop.
      if (terminalSeen) return;
    }
    // 上游兼容性：EOF 时保留未被空行终止的最后一行。上游可能不发结尾
    // 空行——丢掉它会把成功的 response.completed 误判成断流失败。
    yield* consumeText(decoder.decode());
    if (lineParts.length) yield* consumeLine(lineParts.join(''));
    yield* flush();
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

codexGatewayApp.post(
  '/v1/messages',
  async (c, next) => {
    const gatewayToken = extractGatewayToken(c.req.raw.headers);
    if (!gatewayToken) {
      return c.json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'Missing API key' },
        },
        401,
      );
    }

    let provider;
    try {
      provider = resolveCodexProvider(gatewayToken);
    } catch (err) {
      const message =
        err instanceof CodexGatewayAuthError
          ? err.message
          : 'Codex authentication failed';
      return c.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message,
          },
        },
        401,
      );
    }
    if (providerRateLimiter.isLimited(provider.id)) {
      logger.warn(
        { providerId: provider.id },
        'Codex gateway: provider rate limit exceeded',
      );
      return c.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Codex gateway rate limit exceeded, retry later',
          },
        },
        429,
      );
    }

    c.set('codexGatewayToken', gatewayToken);
    await next();
  },
  requestBodyLimit,
  async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Invalid JSON body',
          },
        },
        400,
      );
    }
    const validation = CodexMessagesRequestSchema.safeParse(raw);
    if (!validation.success) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Invalid messages request',
          },
        },
        400,
      );
    }
    const anthropicRequest: AnthropicRequestSubset = validation.data;
    const wantsStream = validation.data.stream !== false;
    const gatewayToken = c.get('codexGatewayToken');
    let access;
    try {
      access = await resolveCodexAccess(gatewayToken);
    } catch (err) {
      const message =
        err instanceof CodexGatewayAuthError
          ? err.message
          : 'Codex authentication failed';
      logger.warn({ err }, 'Codex gateway: auth failed');
      return c.json(
        { type: 'error', error: { type: 'authentication_error', message } },
        401,
      );
    }

    const provider = getProviderById(access.providerId);
    const targetModel = resolveCodexModel(
      undefined,
      provider?.anthropicModel || '',
    );
    const configuredEffort = provider?.customEnv?.CODEX_REASONING_EFFORT;

    const requestModel = resolveCodexModel(anthropicRequest.model, targetModel);
    const responsesRequest = anthropicToResponses(anthropicRequest, {
      targetModel: requestModel,
      // 目录钳制：存量配置里被上游移除的 effort 档（如 minimal）或模型不支持
      // 的档位在请求侧归位，避免上游 400；与前端切模型归位逻辑语义一致。
      // 目录用解析后的实时目录（上游同步结果优先，baked-in 兜底）。
      reasoningEffort: clampCodexEffortWithCatalog(
        getResolvedCodexCatalog().models,
        requestModel,
        normalizeCodexEffort(
          resolveCodexRequestEffort(anthropicRequest, configuredEffort),
        ),
      ),
      requestTools: !!anthropicRequest.tools?.length,
    });
    const requestContext = codexRequestContext(
      c.req.raw.headers,
      validation.data,
      {
        providerId: access.providerId,
        accountId: access.accountId,
        model: responsesRequest.model,
        serviceTier: responsesRequest.service_tier,
      },
    );
    const upstreamRequest = {
      ...responsesRequest,
      ...(requestContext.promptCacheKey
        ? { prompt_cache_key: requestContext.promptCacheKey }
        : {}),
    };

    const controller = new AbortController();
    const FETCH_TIMEOUT_MS = 30_000;
    const fetchTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let clientCancelled = false;
    const onClientAbort = () => {
      clientCancelled = true;
      controller.abort();
    };
    c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });
    if (c.req.raw.signal.aborted) onClientAbort();
    const cleanup = () =>
      c.req.raw.signal.removeEventListener('abort', onClientAbort);

    let upstream: Response;
    try {
      upstream = await fetch(CODEX_BACKEND_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(access.accountId
            ? { 'chatgpt-account-id': access.accountId }
            : {}),
          ...requestContext.headers,
        },
        body: JSON.stringify(upstreamRequest),
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);
    } catch (err) {
      clearTimeout(fetchTimeout);
      cleanup();
      logger.warn({ err }, 'Codex gateway: upstream request failed');
      return c.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Upstream Codex request failed',
          },
        },
        502,
      );
    }

    if (!upstream.ok || !upstream.body) {
      // Do not buffer or log an untrusted error body: it can be arbitrarily
      // large, stall indefinitely, or echo user input and upstream secrets.
      controller.abort();
      await upstream.body?.cancel().catch(() => {});
      cleanup();
      logger.warn(
        { status: upstream.status },
        'Codex gateway: upstream rejected request',
      );
      return c.json(
        {
          type: 'error',
          error: {
            type: upstreamHttpErrorType(upstream.status),
            message: `Upstream Codex backend returned ${upstream.status}`,
          },
        },
        upstream.status >= 400 && upstream.status < 600
          ? (upstream.status as ContentfulStatusCode)
          : 502,
        upstreamRetryHeaders(upstream.headers),
      );
    }

    const conversionOptions = { tools: anthropicRequest.tools };
    const converter = new ResponsesToAnthropicConverter(
      responsesRequest.model,
      conversionOptions,
    );

    if (!wantsStream) {
      const events: Record<string, unknown>[] = [];
      let eventBytes = 0;
      // 非流式聚合需要一个整体上限：60s 只是块间超时，慢滴上游可以无限
      // 拖住请求和 events 数组。上限对齐 Anthropic SDK 客户端默认 10 分钟。
      const AGGREGATE_DEADLINE_MS = 600_000;
      const deadline = setTimeout(
        () => controller.abort(),
        AGGREGATE_DEADLINE_MS,
      );
      try {
        for await (const event of iterateUpstreamEvents(
          upstream.body,
          controller.signal,
        )) {
          eventBytes += Buffer.byteLength(JSON.stringify(event));
          if (eventBytes > 32 * 1024 * 1024) {
            throw new Error(
              'Upstream Codex response exceeds aggregation limit',
            );
          }
          events.push(event);
        }
        const aggregated = aggregateResponsesStream(
          events,
          responsesRequest.model,
          conversionOptions,
        );
        logGatewaySuccess(responsesRequest.model, aggregated.usage);
        return c.json({
          id: aggregated.id,
          type: 'message',
          role: 'assistant',
          model: aggregated.model,
          content: aggregated.content,
          stop_reason: aggregated.stopReason,
          stop_sequence: aggregated.stopSequence ?? null,
          usage: aggregated.usage,
        });
      } catch (err) {
        controller.abort();
        if (err instanceof CodexUpstreamError) {
          logger.warn(
            { code: err.code, errorType: err.errorType },
            'Codex gateway: upstream reported failure',
          );
          return c.json(
            {
              type: 'error',
              error: { type: err.errorType, message: err.message },
            },
            err.status as ContentfulStatusCode,
            upstreamRetryHeaders(upstream.headers),
          );
        }
        const timedOut = err instanceof Error && err.name === 'AbortError';
        logger.warn({ err }, 'Codex gateway: upstream stream failed');
        return c.json(
          {
            type: 'error',
            error: {
              type: 'api_error',
              message: timedOut
                ? 'Upstream Codex stream timed out'
                : 'Upstream Codex stream failed',
            },
          },
          timedOut ? 504 : 502,
        );
      } finally {
        clearTimeout(deadline);
        cleanup();
      }
    }

    let streamCancelled = false;
    let upstreamFinished = false;
    const upstreamEvents = iterateUpstreamEvents(
      upstream.body,
      controller.signal,
    );
    const pendingEvents: AnthropicStreamEvent[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controllerStream) {
        try {
          // Consume upstream only when downstream has room; a slow/disconnected
          // client cannot leave an unbounded queue of translated SSE chunks.
          while (!pendingEvents.length && !upstreamFinished) {
            const next = await upstreamEvents.next();
            if (next.done) {
              upstreamFinished = true;
              pendingEvents.push(...converter.finish());
              const failure = converter.getFailure();
              if (failure) {
                logger.warn(
                  { code: failure.code, errorType: failure.type },
                  'Codex gateway: upstream reported failure',
                );
              } else {
                logGatewaySuccess(responsesRequest.model, converter.getUsage());
              }
            } else {
              pendingEvents.push(...converter.handleEvent(next.value));
            }
          }
          if (streamCancelled) return;
          if (clientCancelled) {
            cleanup();
            controllerStream.close();
            return;
          }
          const event = pendingEvents.shift();
          if (event) {
            controllerStream.enqueue(encoder.encode(sseEncode(event)));
          } else {
            cleanup();
            controllerStream.close();
          }
        } catch (err) {
          controller.abort();
          await upstreamEvents.return(undefined).catch(() => {});
          if (!streamCancelled) {
            if (!clientCancelled) {
              logger.warn({ err }, 'Codex gateway: stream translation failed');
              controllerStream.enqueue(
                encoder.encode(
                  sseEncode({
                    event: 'error',
                    data: {
                      type: 'error',
                      error: {
                        type: 'api_error',
                        message: 'Codex gateway stream failed',
                      },
                    },
                  }),
                ),
              );
            }
            controllerStream.close();
          }
          cleanup();
        }
      },
      async cancel() {
        streamCancelled = true;
        clientCancelled = true;
        controller.abort();
        cleanup();
        await upstreamEvents.return(undefined).catch(() => {});
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  },
);
