// ─── ChatGPT/Codex 订阅网关 — Hono 子应用 ──────────────────────────
//
// 挂载在主服务 CODEX_GATEWAY_ROUTE 下，只处理 Claude Agent SDK 会发出的
// POST {route}/v1/messages。鉴权用 provider 的 gateway token（SDK 把裸
// token 当 ANTHROPIC_API_KEY 发送，落在 x-api-key 头），不是真实 ChatGPT
// token —— 真实 token 只在网关进程内部持有，不会下发给 Runner/容器。

import { Hono } from 'hono';

import { logger } from '../logger.js';
import { getProviderById } from '../runtime-config.js';
import {
  anthropicToResponses,
  resolveCodexModel,
  type AnthropicRequestSubset,
} from './convert-request.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
  type AnthropicStreamEvent,
} from './convert-response.js';
import { CodexGatewayAuthError, resolveCodexAccess } from './token-manager.js';
import { CODEX_BACKEND_RESPONSES_URL } from './types.js';

export const codexGatewayApp = new Hono();

function sseEncode(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
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

interface UpstreamSseLine {
  event?: string;
  data?: string;
}

/** 逐行解析上游 SSE 文本为 (event, data) 对；data 以 JSON.parse 消费。 */
async function* iterateUpstreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: UpstreamSseLine = {};

  const flush = function* (): Generator<Record<string, unknown>> {
    if (current.data === undefined) return;
    try {
      yield JSON.parse(current.data) as Record<string, unknown>;
    } catch (err) {
      logger.warn(
        { err },
        'Codex gateway: failed to parse upstream SSE data line',
      );
    }
    current = {};
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed === '') {
          yield* flush();
          continue;
        }
        if (trimmed.startsWith('event:')) {
          current.event = trimmed.slice('event:'.length).trim();
        } else if (trimmed.startsWith('data:')) {
          const chunk = trimmed.slice('data:'.length).trim();
          current.data =
            current.data === undefined ? chunk : `${current.data}\n${chunk}`;
        }
      }
    }
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

codexGatewayApp.post('/v1/messages', async (c) => {
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
  const reasoningEffort = provider?.customEnv?.CODEX_REASONING_EFFORT;

  let anthropicRequest: AnthropicRequestSubset;
  let wantsStream = true;
  try {
    const raw = (await c.req.json()) as AnthropicRequestSubset & {
      stream?: boolean;
    };
    anthropicRequest = raw;
    wantsStream = raw.stream !== false;
  } catch {
    return c.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
      },
      400,
    );
  }

  const responsesRequest = anthropicToResponses(anthropicRequest, {
    targetModel: resolveCodexModel(anthropicRequest.model, targetModel),
    reasoningEffort,
    requestTools: !!anthropicRequest.tools?.length,
  });

  const controller = new AbortController();
  c.req.raw.signal?.addEventListener('abort', () => controller.abort());

  let upstream: Response;
  try {
    upstream = await fetch(CODEX_BACKEND_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(access.accountId ? { 'chatgpt-account-id': access.accountId } : {}),
        originator: 'codex_cli_rs',
      },
      body: JSON.stringify(responsesRequest),
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn({ err }, 'Codex gateway: upstream request failed');
    return c.json(
      {
        type: 'error',
        error: { type: 'api_error', message: 'Upstream Codex request failed' },
      },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    logger.warn(
      { status: upstream.status, detail },
      'Codex gateway: upstream rejected request',
    );
    return c.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream Codex backend returned ${upstream.status}`,
        },
      },
      upstream.status >= 400 && upstream.status < 600
        ? (upstream.status as any)
        : 502,
    );
  }

  const converter = new ResponsesToAnthropicConverter(responsesRequest.model);

  if (!wantsStream) {
    const events: Record<string, unknown>[] = [];
    for await (const event of iterateUpstreamEvents(upstream.body)) {
      events.push(event);
    }
    const aggregated = aggregateResponsesStream(events, responsesRequest.model);
    return c.json({
      id: aggregated.id,
      type: 'message',
      role: 'assistant',
      model: aggregated.model,
      content: aggregated.content,
      stop_reason: aggregated.stopReason,
      stop_sequence: null,
      usage: aggregated.usage,
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controllerStream) {
      const encoder = new TextEncoder();
      try {
        for await (const upstreamEvent of iterateUpstreamEvents(
          upstream.body!,
        )) {
          for (const outEvent of converter.handleEvent(upstreamEvent)) {
            controllerStream.enqueue(encoder.encode(sseEncode(outEvent)));
          }
        }
        for (const outEvent of converter.finish()) {
          controllerStream.enqueue(encoder.encode(sseEncode(outEvent)));
        }
      } catch (err) {
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
      } finally {
        controllerStream.close();
      }
    },
    cancel() {
      controller.abort();
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
});
