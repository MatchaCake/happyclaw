#!/usr/bin/env node
// npm run build && node tests/e2e/codex-gateway-sdk.mjs
// Real installed Agent SDK/CLI -> real Hono HTTP gateway -> local Responses SSE.
// No accounts are needed. All config, credentials and Bash output are temporary.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalLogLevel = process.env.LOG_LEVEL;
const scratch = await mkdtemp(path.join(os.tmpdir(), 'hc-codex-sdk-e2e-'));
const workspace = path.join(scratch, 'workspace');
const claudeConfig = path.join(scratch, 'claude-config');
const gatewayKey = 'e2e-gateway-not-a-real-secret';
const upstreamKey = 'e2e-upstream-not-a-real-secret';
const accountId = 'e2e-account';
const model = 'gpt-6-sol';
const callId = 'call_gateway_e2e';
const toolMarker = 'CODEX_GATEWAY_TOOL_EXECUTED';
const finalText = 'CODEX_GATEWAY_SDK_OK ✓';
const command = `printf '${toolMarker}\\n' > codex-gateway-probe.txt && cat codex-gateway-probe.txt`;
const servers = [];
const requests = [];
const upstreamRequests = [];
const gatewayStreams = [];
const sdkMessages = [];
const checks = {};
let blockedFetches = 0;
let blockedProxyRequests = 0;
let unexpectedHttpRequests = 0;
let sdkStderrBytes = 0;
let sdkFreshInputTokens = 0;
let sdkCachedInputTokens = 0;
let sdkOutputTokens = 0;
let phase = 'setup';
let querySession;
let abortController;
let timer;
let sdkVersion;
let cliVersion;

function check(name, condition) {
  checks[name] = Boolean(condition);
  assert.ok(condition, name);
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function jsonBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    assert.ok(bytes < 2 * 1024 * 1024, 'fixture body limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fixtureEvents(turn) {
  const id = `resp_gateway_e2e_${turn}`;
  const usage =
    turn === 1
      ? {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 10,
        }
      : {
          input_tokens: 150,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens: 12,
        };
  const output =
    turn === 1
      ? {
          id: 'fc_gateway_e2e',
          type: 'function_call',
          call_id: callId,
          name: 'Bash',
          arguments: JSON.stringify({
            command,
            description: 'Write the temporary gateway probe file',
          }),
        }
      : {
          id: 'msg_gateway_e2e',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: finalText, annotations: [] }],
        };
  return [
    {
      type: 'response.created',
      response: { id, model, status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item:
        turn === 1 ? { ...output, arguments: '' } : { ...output, content: [] },
    },
    ...(turn === 1
      ? []
      : [
          {
            type: 'response.output_text.delta',
            item_id: output.id,
            output_index: 0,
            content_index: 0,
            delta: finalText,
          },
        ]),
    { type: 'response.output_item.done', output_index: 0, item: output },
    {
      type: 'response.completed',
      response: { id, model, status: 'completed', output: [output], usage },
    },
  ];
}

function parseAnthropicStream(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeConfig, { recursive: true });
  const sdkPath = path.join(
    repository,
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  );
  const cliPackagePath = path.join(
    repository,
    'container/agent-runner/node_modules/@anthropic-ai/claude-code/package.json',
  );
  const sdkPackage = JSON.parse(
    await readFile(path.join(path.dirname(sdkPath), 'package.json'), 'utf8'),
  );
  const cliPackage = JSON.parse(await readFile(cliPackagePath, 'utf8'));
  sdkVersion = sdkPackage.version;
  cliVersion = cliPackage.version;
  const cli = path.resolve(path.dirname(cliPackagePath), cliPackage.bin.claude);
  // Crucial: config.ts captures PROJECT_ROOT at import time. No project runtime
  // config can be read before switching into the newly created empty scratch.
  process.chdir(scratch);
  process.env.LOG_LEVEL = 'silent';
  const { Hono } = await import(
    pathToFileURL(path.join(repository, 'node_modules/hono/dist/index.js')).href
  );
  const { serve } = await import(
    pathToFileURL(
      path.join(repository, 'node_modules/@hono/node-server/dist/index.mjs'),
    ).href
  );
  const { query } = await import(pathToFileURL(sdkPath).href);
  const { createProvider, getProviders } = await import(
    pathToFileURL(path.join(repository, 'dist/runtime-config.js')).href
  );
  const { codexGatewayApp } = await import(
    pathToFileURL(path.join(repository, 'dist/codex-gateway/gateway.js')).href
  );
  const { CodexMessagesRequestSchema } = await import(
    pathToFileURL(
      path.join(repository, 'dist/codex-gateway/request-validation.js'),
    ).href
  );
  const {
    CODEX_BACKEND_RESPONSES_URL,
    CODEX_GATEWAY_ROUTE,
    CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  } = await import(
    pathToFileURL(path.join(repository, 'dist/codex-gateway/types.js')).href
  );
  check('emptyTemporaryProviderConfig', getProviders().length === 0);
  createProvider({
    name: 'E2E controlled Codex gateway',
    type: 'third_party',
    enabled: true,
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: gatewayKey,
    anthropicModel: model,
    codexOAuthCredentials: {
      accessToken: upstreamKey,
      refreshToken: 'e2e-refresh-not-a-real-secret',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId,
      planType: null,
      email: null,
      updatedAt: new Date().toISOString(),
    },
  });

  const upstream = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/responses');
      assert.equal(request.headers.authorization, `Bearer ${upstreamKey}`);
      assert.equal(request.headers['chatgpt-account-id'], accountId);
      const body = await jsonBody(request);
      upstreamRequests.push(body);
      assert.ok(upstreamRequests.length <= 2, 'exactly two model turns');
      if (upstreamRequests.length === 2) {
        const result = body.input.find(
          (item) =>
            item.type === 'function_call_output' && item.call_id === callId,
        );
        check(
          'upstreamReceivedBashFeedback',
          result?.output?.includes(toolMarker),
        );
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      const wire = Buffer.from(
        fixtureEvents(upstreamRequests.length)
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
      );
      // Split bytes across event/JSON/UTF-8 boundaries rather than returning a
      // synthesized Response to the converter or testing its pure functions.
      for (let offset = 0; offset < wire.length; offset += 73) {
        response.write(wire.subarray(offset, offset + 73));
      }
      response.end();
    } catch {
      checks.upstreamFixture = false;
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: 'Controlled fixture rejected request' }),
      );
    }
  });
  const upstreamUrl = await listen(upstream);
  // The gateway still requests the official constant. Only this precise URL
  // can be redirected. OAuth, catalog, telemetry or any other fetch fails shut.
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== CODEX_BACKEND_RESPONSES_URL) {
      blockedFetches++;
      throw new Error('Unexpected network request blocked by E2E fixture');
    }
    return originalFetch(`${upstreamUrl}/responses`, {
      ...init,
      redirect: 'error',
    });
  };

  // The native CLI is a subprocess, so a parent fetch wrapper cannot constrain
  // it. Disable nonessential traffic and give it a rejecting HTTP(S) proxy;
  // only the explicitly configured loopback gateway bypasses that proxy.
  const denyProxy = createServer((_request, response) => {
    blockedProxyRequests++;
    response.writeHead(403);
    response.end();
  });
  denyProxy.on('connect', (_request, socket) => {
    blockedProxyRequests++;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  const proxyUrl = await listen(denyProxy);
  const app = new Hono();
  app.use(`${CODEX_GATEWAY_ROUTE}/v1/messages`, async (context, next) => {
    const body = await context.req.raw.clone().json();
    const validation = CodexMessagesRequestSchema.safeParse(body);
    requests.push({
      body,
      apiKeyCorrect: context.req.header('x-api-key') === gatewayKey,
      validationIssues: validation.success
        ? []
        : validation.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
          })),
    });
    await next();
    const record = { status: context.res.status, events: [] };
    gatewayStreams.push(record);
    if (context.res.ok)
      record.events = parseAnthropicStream(await context.res.clone().text());
    else record.errorType = (await context.res.clone().json())?.error?.type;
  });
  app.route(CODEX_GATEWAY_ROUTE, codexGatewayApp);
  app.notFound((context) => {
    unexpectedHttpRequests++;
    return context.json({ error: 'Unexpected gateway path' }, 404);
  });
  const gateway = await new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      () => resolve(server),
    );
    server.once('error', reject);
  });
  servers.push(gateway);
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}${CODEX_GATEWAY_ROUTE}`;
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: claudeConfig,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_API_KEY: gatewayKey,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  phase = 'sdkExecution';
  abortController = new AbortController();
  timer = setTimeout(() => abortController.abort(), 60000);
  querySession = query({
    prompt: `Run Bash exactly once to create codex-gateway-probe.txt containing ${toolMarker}, then reply with the confirmation.`,
    options: {
      cwd: workspace,
      env,
      pathToClaudeCodeExecutable: cli,
      model,
      systemPrompt:
        'You are a controlled gateway compatibility test. Use the provided Bash tool and return the final response.',
      tools: ['Bash'],
      allowedTools: ['Bash'],
      permissionMode: 'dontAsk',
      settingSources: [],
      skills: [],
      plugins: [],
      mcpServers: {},
      persistSession: false,
      maxTurns: 4,
      includePartialMessages: true,
      abortController,
      stderr: (text) => {
        sdkStderrBytes += Buffer.byteLength(text);
      },
    },
  });
  for await (const message of querySession) sdkMessages.push(message);
  clearTimeout(timer);
  phase = 'assertions';
  check(
    'twoRealSdkRequests',
    requests.length === 2 && upstreamRequests.length === 2,
  );
  check(
    'realAnthropicAuthAndStream',
    requests.every(
      ({ body, apiKeyCorrect }) =>
        apiKeyCorrect &&
        body.stream === true &&
        Array.isArray(body.system) &&
        Array.isArray(body.messages),
    ),
  );
  check(
    'realBashToolSchema',
    requests[0].body.tools.some(
      (tool) => tool.name === 'Bash' && tool.input_schema?.type === 'object',
    ),
  );
  const anthropicFeedback = requests[1].body.messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (block) => block.type === 'tool_result' && block.tool_use_id === callId,
    );
  check(
    'realAnthropicToolResult',
    Boolean(anthropicFeedback && !anthropicFeedback.is_error),
  );
  check(
    'responsesToolIdentity',
    upstreamRequests[1].input.some(
      (item) =>
        item.type === 'function_call' &&
        item.call_id === callId &&
        item.name === 'Bash',
    ),
  );
  check(
    'responsesForcedFlags',
    upstreamRequests.every(
      (body) =>
        body.stream === true &&
        body.store === false &&
        body.model === model &&
        !('max_tokens' in body) &&
        !('metadata' in body),
    ),
  );
  check(
    'sdkSystemInstructionsPreserved',
    requests.every(({ body }, turn) => {
      const systemMessages = body.messages.filter(
        (message) => message.role === 'system',
      );
      const translatedSystemText = [
        upstreamRequests[turn].instructions,
        ...upstreamRequests[turn].input
          .filter((item) => ['system', 'developer'].includes(item.role))
          .flatMap((item) => item.content?.map((block) => block.text) ?? []),
      ].join('\n');
      return (
        systemMessages.length > 0 &&
        systemMessages.every((message) =>
          (Array.isArray(message.content)
            ? message.content.map((block) => block.text)
            : [message.content]
          ).every((text) => translatedSystemText.includes(text)),
        )
      );
    }),
  );
  check(
    'bashWroteActualFile',
    (await readFile(
      path.join(workspace, 'codex-gateway-probe.txt'),
      'utf8',
    )) === `${toolMarker}\n`,
  );
  const toolUses = sdkMessages
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.message.content)
    .filter((block) => block.type === 'tool_use');
  check(
    'sdkExecutedOneBash',
    toolUses.length === 1 &&
      toolUses[0].name === 'Bash' &&
      toolUses[0].id === callId,
  );
  const result = sdkMessages.find((message) => message.type === 'result');
  check(
    'sdkFinalText',
    result?.subtype === 'success' &&
      result.result === finalText &&
      !result.is_error,
  );
  sdkFreshInputTokens = result.usage.input_tokens;
  sdkCachedInputTokens = result.usage.cache_read_input_tokens;
  sdkOutputTokens = result.usage.output_tokens;
  const usages = gatewayStreams.flatMap(({ events }) =>
    events
      .filter((event) => event.type === 'message_delta')
      .map((event) => event.usage),
  );
  check(
    'wireCacheExclusiveUsage',
    usages.length === 2 &&
      usages[0].input_tokens === 20 &&
      usages[0].cache_read_input_tokens === 80 &&
      usages[1].input_tokens === 50 &&
      usages[1].cache_read_input_tokens === 100,
  );
  check(
    'sdkCacheExclusiveUsage',
    result.usage.input_tokens === 70 &&
      result.usage.cache_read_input_tokens === 180 &&
      result.usage.output_tokens === 22 &&
      !result.usage.cache_creation_input_tokens,
  );
  check(
    'sdkCachedInputCountedOnce',
    result.usage.input_tokens +
      result.usage.cache_read_input_tokens +
      result.usage.output_tokens ===
      272,
  );
  check(
    'singleTerminalPerRequest',
    gatewayStreams.every(
      ({ status, events }) =>
        status === 200 &&
        events.filter((event) => event.type === 'message_stop').length === 1 &&
        !events.some((event) => event.type === 'error'),
    ),
  );
  check(
    'noUnexpectedNetwork',
    blockedFetches === 0 &&
      blockedProxyRequests === 0 &&
      unexpectedHttpRequests === 0,
  );
  phase = 'complete';
} catch {
  // No SDK stderr, request bodies, provider credentials or user data are logged.
  checks.completed = false;
} finally {
  clearTimeout(timer);
  abortController?.abort();
  querySession?.close();
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  await Promise.allSettled(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections?.();
        }),
    ),
  );
  await rm(scratch, { recursive: true, force: true });
}

const passed = phase === 'complete' && Object.values(checks).every(Boolean);
console.log(
  JSON.stringify({
    passed,
    phase,
    sdkVersion,
    cliVersion,
    checks,
    counts: {
      sdkRequests: requests.length,
      responsesRequests: upstreamRequests.length,
      sdkMessages: sdkMessages.length,
      sdkStderrBytes,
      sdkFreshInputTokens,
      sdkCachedInputTokens,
      sdkOutputTokens,
      blockedFetches,
      blockedProxyRequests,
      unexpectedHttpRequests,
    },
    statuses: gatewayStreams.map(({ status, errorType }) => ({
      status,
      errorType,
    })),
    requestShapes: requests.map(
      ({ body, apiKeyCorrect, validationIssues }) => ({
        apiKeyCorrect,
        validationIssues,
        keys: Object.keys(body).sort(),
        roles: body.messages.map((message) => message.role),
        contentTypes: [
          ...new Set(
            body.messages.flatMap((message) =>
              Array.isArray(message.content)
                ? message.content.map((block) => block.type)
                : ['string'],
            ),
          ),
        ],
      }),
    ),
  }),
);
process.exitCode = passed ? 0 : 1;
