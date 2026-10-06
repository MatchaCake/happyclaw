// Ported from CLIProxyAPI a2976eb8; see docs/licenses/CLIProxyAPI-MIT.txt.
// Responses SSE -> Anthropic Messages SSE, shared by streaming and aggregation.
// Item/content identities remain separate while output blocks are serialized for
// Claude SDK. Tool arguments hydrate from deltas and authoritative snapshots;
// reasoning retains summary boundaries and a replayable final signature.
// Completion normalizes usage and stop metadata exactly once. Failures and
// premature EOF remain errors rather than successful partial answers.

import { encodeReasoningSignature } from './reasoning-signature.js';
import {
  buildCodexToolNameMap,
  shortenCodexCallId,
} from './convert-request.js';

type Json = Record<string, unknown>;

export interface ResponseConversionOptions {
  /** Original Anthropic tools, used to restore names shortened upstream. */
  tools?: Array<Json>;
}

type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded';

interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens: number };
}

interface OutputBlock {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'server_tool_use'
    | 'web_search_tool_result';
  index: number | null;
  text: string;
  emitted: string;
  done: boolean;
  closed: boolean;
  item: OutputItem;
  name?: string;
  callId?: string;
  initialEmptyDelta?: boolean;
  parts?: Map<number, string>;
  currentPart?: number;
  data?: Json;
}

interface OutputItem {
  type: string;
  id: string | null;
  anonymous: boolean;
  done: boolean;
  blocks: Map<number, OutputBlock>;
  tool?: OutputBlock;
  thinking?: OutputBlock;
  signature?: string;
  fallbackSignature?: string;
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function indexValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function responseUsage(response: Json): ResponseUsage {
  const usage = object(response.usage);
  const details = object(usage.input_tokens_details);
  const total = tokens(usage.input_tokens);
  const cached = Math.min(total, tokens(details.cached_tokens));
  const created = Math.min(
    total - cached,
    tokens(details.cache_write_tokens) || tokens(details.cache_creation_tokens),
  );
  const output = tokens(usage.output_tokens);
  const thinking = object(usage.output_tokens_details).reasoning_tokens;
  return {
    input_tokens: Math.max(0, total - cached - created),
    output_tokens: output,
    cache_read_input_tokens: cached,
    ...(created ? { cache_creation_input_tokens: created } : {}),
    ...(typeof thinking === 'number' &&
    Number.isFinite(thinking) &&
    thinking >= 0
      ? {
          output_tokens_details: {
            thinking_tokens: Math.min(output, tokens(thinking)),
          },
        }
      : {}),
  };
}

function stopReason(
  response: Json,
  incomplete: boolean,
  hasToolUse: boolean,
): StopReason {
  if (hasToolUse) return 'tool_use';
  const sequence = asString(response.stop_sequence);
  const reason =
    asString(response.stop_reason) ||
    asString(object(response.incomplete_details).reason);
  if (sequence && (!reason || reason === 'stop')) return 'stop_sequence';
  switch (reason) {
    case 'max_tokens':
    case 'max_output_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
    case 'model_context_window_exceeded':
      return reason;
    default:
      return incomplete && !reason ? 'max_tokens' : 'end_turn';
  }
}

export interface AnthropicStreamEvent {
  event: string;
  data: Json;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'rate_limit_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'overloaded_error'
  | 'api_error';

export interface CodexUpstreamFailure {
  type: AnthropicErrorType;
  code: string | null;
  message: string;
  status?: number;
}

const RATE_LIMIT_CODES = new Set([
  'rate_limit_exceeded',
  'usage_limit_reached',
  'insufficient_quota',
]);

const HTTP_STATUS_BY_ERROR_TYPE: Readonly<Record<AnthropicErrorType, number>> =
  {
    invalid_request_error: 400,
    rate_limit_error: 429,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404,
    overloaded_error: 529,
    api_error: 502,
  };

/**
 * 把上游失败翻译成 Anthropic 错误类型。类型决定客户端是否重试：SDK 对
 * api_error 会反复重试，而 invalid_prompt（上游安全策略拒绝）重试同一请求
 * 并不会改变判定，必须以 invalid_request_error 暴露真实原因。
 */
export function describeUpstreamFailure(raw: Json): CodexUpstreamFailure {
  // response.failed 的详情在 response.error 下；裸 error 事件在 error 下，
  // 少数旧形态直接放在顶层 code/message。
  const response = object(raw.response);
  const error = response.error ?? raw.error;
  const nested = object(error);
  const code = asString(nested.code) ?? asString(raw.code);
  const normalizedCode = code?.trim().toLowerCase() ?? '';
  const upstreamType = (asString(nested.type) ?? asString(raw.error_type) ?? '')
    .trim()
    .toLowerCase();
  const declaredStatus = [nested.status_code, nested.status].find(
    (value) =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 400 &&
      value <= 599,
  ) as number | undefined;
  const detail =
    asString(nested.message) ??
    asString(error) ??
    asString(raw.message) ??
    'Upstream Codex request failed';

  let type: AnthropicErrorType = 'api_error';
  if (
    RATE_LIMIT_CODES.has(normalizedCode) ||
    upstreamType.includes('rate_limit') ||
    declaredStatus === 429
  ) {
    type = 'rate_limit_error';
  } else if (
    upstreamType === 'invalid_request_error' ||
    upstreamType === 'invalid_request' ||
    upstreamType === 'bad_request_error' ||
    normalizedCode === 'cyber_policy' ||
    normalizedCode === 'invalid_prompt' ||
    normalizedCode === 'context_length_exceeded' ||
    normalizedCode === 'context_too_large' ||
    declaredStatus === 400 ||
    declaredStatus === 413 ||
    declaredStatus === 422
  ) {
    type = 'invalid_request_error';
  } else if (
    upstreamType === 'authentication_error' ||
    normalizedCode === 'invalid_api_key' ||
    normalizedCode === 'unauthorized' ||
    declaredStatus === 401
  ) {
    type = 'authentication_error';
  } else if (
    upstreamType === 'permission_error' ||
    normalizedCode === 'forbidden' ||
    normalizedCode === 'permission_denied' ||
    declaredStatus === 403
  ) {
    type = 'permission_error';
  } else if (
    upstreamType === 'not_found_error' ||
    normalizedCode === 'not_found' ||
    normalizedCode === 'model_not_found' ||
    declaredStatus === 404
  ) {
    type = 'not_found_error';
  } else if (
    upstreamType === 'overloaded_error' ||
    normalizedCode === 'server_overloaded' ||
    normalizedCode === 'overloaded' ||
    declaredStatus === 529
  ) {
    type = 'overloaded_error';
  }

  const message =
    normalizedCode === 'invalid_prompt'
      ? `Codex 上游安全策略拒绝了本次请求（invalid_prompt）：${detail}`
      : code
        ? `Codex upstream error (${code}): ${detail}`
        : detail;
  return {
    type,
    code,
    message,
    ...(declaredStatus ? { status: declaredStatus } : {}),
  };
}

export class CodexUpstreamError extends Error {
  readonly errorType: AnthropicErrorType;
  readonly code: string | null;
  readonly status: number;

  constructor(failure: CodexUpstreamFailure) {
    super(failure.message);
    this.name = 'CodexUpstreamError';
    this.errorType = failure.type;
    this.code = failure.code;
    this.status = failure.status ?? HTTP_STATUS_BY_ERROR_TYPE[failure.type];
  }
}

export class ResponsesToAnthropicConverter {
  private blockIndex = 0;
  private readonly aliases = new Map<string, OutputItem>();
  private readonly lastItems = new Map<string, OutputItem>();
  private readonly items = new Set<OutputItem>();
  private readonly toolQueue: OutputBlock[] = [];
  private readonly contentQueue: OutputBlock[] = [];
  private active: OutputBlock | null = null;
  private hasToolUse = false;
  private sawMeaningfulOutput = false;
  private completedOutputItems = 0;
  private usage: ResponseUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
  };
  private messageStarted = false;
  private finished = false;
  private failure: CodexUpstreamFailure | null = null;
  private readonly originalToolNames: Map<string, string>;

  constructor(
    private model: string,
    options: ResponseConversionOptions = {},
  ) {
    this.originalToolNames = new Map(
      [...buildCodexToolNameMap(options.tools)].map(([original, short]) => [
        short,
        original,
      ]),
    );
  }

  handleEvent(raw: Json): AnthropicStreamEvent[] {
    if (this.finished) return [];
    const type = asString(raw.type) ?? '';
    if (type === 'error' || type === 'response.failed')
      return this.handleFailure(raw);
    if (
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.done'
    ) {
      const response = object(raw.response);
      if (response.status === 'failed' || response.error)
        return this.handleFailure(raw);
      if (
        response.status != null &&
        response.status !== 'completed' &&
        response.status !== 'incomplete'
      )
        return this.handleFailure({
          code: 'invalid_terminal_status',
          message: 'Upstream Codex terminated before completing the response',
        });
      return this.handleCompleted(
        raw,
        type === 'response.incomplete' || response.status === 'incomplete',
      );
    }
    if (type === 'response.created' || type === 'response.in_progress')
      return this.ensureMessageStarted(raw);
    const supported = new Set([
      'response.output_item.added',
      'response.output_item.done',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.content_part.added',
      'response.content_part.done',
      'response.output_text.delta',
      'response.output_text.done',
      'response.refusal.delta',
      'response.refusal.done',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_text.delta',
      'response.reasoning_text.done',
    ]);
    if (!supported.has(type)) return [];
    if (
      type === 'response.output_item.done' &&
      raw.item &&
      typeof raw.item === 'object' &&
      !Array.isArray(raw.item)
    )
      this.completedOutputItems++;
    if (
      [
        'response.output_text.delta',
        'response.reasoning_text.delta',
        'response.reasoning_summary_text.delta',
        'response.function_call_arguments.delta',
      ].includes(type) &&
      asString(raw.delta)?.trim()
    )
      this.sawMeaningfulOutput = true;
    const events = this.ensureMessageStarted(raw);
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      this.updateItem(raw, object(raw.item), type.endsWith('.done'), events);
    } else if (type.startsWith('response.function_call_arguments.')) {
      const item = this.itemFor(raw, {}, 'function_call');
      const block = this.toolFor(item);
      if (!block.closed) {
        if (type.endsWith('.delta')) block.text += asString(raw.delta) ?? '';
        else {
          this.setSnapshot(block, asString(raw.arguments) ?? '');
          this.validateToolArguments(block);
        }
      }
    } else if (type.startsWith('response.reasoning_')) {
      this.updateThinking(raw, type, events);
    } else {
      const item = this.itemFor(raw, {}, 'message');
      const part = object(raw.part);
      if (
        type.includes('content_part') &&
        part.type !== 'output_text' &&
        part.type !== 'refusal'
      )
        return events;
      const block = this.textFor(item, indexValue(raw.content_index) ?? 0);
      if (!block.closed) {
        if (type.endsWith('.delta')) block.text += asString(raw.delta) ?? '';
        else
          this.setSnapshot(
            block,
            asString(raw.text) ??
              asString(raw.refusal) ??
              asString(part.text) ??
              asString(part.refusal) ??
              '',
          );
        if (type.endsWith('.done')) block.done = true;
      }
    }
    events.push(...this.flush());
    return events;
  }

  finish(): AnthropicStreamEvent[] {
    if (this.finished) return [];
    return this.handleFailure({
      message: 'Upstream Codex stream ended before completion',
    });
  }

  private ensureMessageStarted(raw: Json): AnthropicStreamEvent[] {
    if (this.messageStarted) return [];
    this.messageStarted = true;
    const response = object(raw.response);
    this.model = asString(response.model) ?? this.model;
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: asString(response.id) ?? `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
      { event: 'ping', data: { type: 'ping' } },
    ];
  }

  private itemFor(raw: Json, item: Json, type: string): OutputItem {
    const keys: string[] = [];
    for (const id of [asString(item.id), asString(raw.item_id)])
      if (id) keys.push(`item:${id}`);
    if (type === 'web_search_call') {
      for (const id of [
        asString(raw.id),
        asString(item.output_item_id),
        asString(raw.output_item_id),
        asString(item.call_id),
        asString(raw.call_id),
        asString(item.item_id),
      ])
        if (id) keys.push(`item:${id}`);
    }
    if (type === 'function_call') {
      for (const id of [asString(item.call_id), asString(raw.call_id)])
        if (id) keys.push(`call:${id}`);
    }
    const outputIndex =
      indexValue(raw.output_index) ?? indexValue(item.output_index);
    if (outputIndex !== null) keys.push(`output:${outputIndex}`);
    let found = keys
      .map((key) => this.aliases.get(key))
      .find((value) => value?.type === type);
    const previous = this.lastItems.get(type);
    if (
      !found &&
      previous &&
      ((!keys.length &&
        (!previous.done || raw.type !== 'response.output_item.added')) ||
        (previous.anonymous &&
          (!previous.done ||
            (raw.type === undefined &&
              type === 'reasoning' &&
              previous.thinking &&
              !previous.thinking.closed))))
    )
      found = previous;
    if (!found) {
      found = {
        type,
        id: null,
        anonymous: !keys.length,
        done: false,
        blocks: new Map(),
      };
      this.items.add(found);
    }
    found.id = asString(item.id) || asString(raw.item_id) || found.id;
    for (const key of keys) this.aliases.set(key, found);
    if (keys.length) found.anonymous = false;
    this.lastItems.set(type, found);
    return found;
  }

  private blockFor(item: OutputItem, type: OutputBlock['type']): OutputBlock {
    return {
      item,
      type,
      index: null,
      text: '',
      emitted: '',
      done: false,
      closed: false,
    };
  }

  private toolFor(item: OutputItem): OutputBlock {
    if (!item.tool) {
      item.tool = this.blockFor(item, 'tool_use');
      this.toolQueue.push(item.tool);
    }
    return item.tool;
  }

  private textFor(item: OutputItem, partIndex: number): OutputBlock {
    let block = item.blocks.get(partIndex);
    if (!block) {
      block = this.blockFor(item, 'text');
      item.blocks.set(partIndex, block);
      this.contentQueue.push(block);
    }
    return block;
  }

  private thinkingFor(item: OutputItem): OutputBlock {
    if (!item.thinking) {
      item.thinking = {
        ...this.blockFor(item, 'thinking'),
        parts: new Map(),
        currentPart: 0,
      };
      this.contentQueue.push(item.thinking);
    }
    return item.thinking;
  }

  private setSnapshot(block: OutputBlock, snapshot: string): void {
    if (!snapshot || block.closed) return;
    if (
      !snapshot.trim() &&
      block.type === 'tool_use' &&
      block.text.trim() === '{}'
    )
      return;
    if (snapshot.startsWith(block.text)) block.text = snapshot;
    else if (!block.emitted) block.text = snapshot;
    // A complete snapshot may not retract bytes already delivered to the SDK.
    else if (snapshot !== block.text)
      this.failConversion(
        'invalid_stream',
        'Upstream Codex changed content after streaming it',
      );
  }

  private failConversion(code: string, message: string): never {
    this.finished = true;
    this.failure = { type: 'api_error', code, message };
    throw new CodexUpstreamError(this.failure);
  }

  private validateToolArguments(block: OutputBlock): void {
    if (!block.text.trim()) {
      // Preserve an already streamed whitespace prefix while completing it
      // as an empty object. An absent arguments field uses the initial {}.
      if (block.text) block.text += '{}';
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(block.text);
    } catch {
      this.failConversion(
        'invalid_tool_arguments',
        'Upstream Codex tool arguments must be a JSON object',
      );
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      this.failConversion(
        'invalid_tool_arguments',
        'Upstream Codex tool arguments must be a JSON object',
      );
    }
  }

  private updateItem(
    raw: Json,
    data: Json,
    done: boolean,
    events: AnthropicStreamEvent[],
  ): void {
    const type = asString(data.type) ?? '';
    if (
      !['message', 'reasoning', 'function_call', 'web_search_call'].includes(
        type,
      )
    )
      return;
    const item = this.itemFor(raw, data, type);
    if (
      item.done &&
      type !== 'function_call' &&
      !(type === 'reasoning' && !item.thinking?.closed)
    )
      return;
    if (type === 'function_call') {
      const block = this.toolFor(item);
      if (block.closed) return;
      const name = asString(data.name);
      if (name) {
        block.name = this.originalToolNames.get(name) ?? name;
        block.initialEmptyDelta = !done;
      }
      block.callId = asString(data.call_id) || block.callId || item.id || '';
      this.setSnapshot(block, asString(data.arguments) ?? '');
      block.done = done;
      // A pending tool must not close reasoning before its final signature.
      // Its buffered arguments are released after the preceding block's done.
    } else if (type === 'reasoning') {
      const signature = asString(data.encrypted_content);
      // Added cipher snapshots cannot close a block. Keep the reference
      // fallback only until terminal confirms no authoritative cipher exists.
      if (signature && done) item.signature = signature;
      else if (signature) item.fallbackSignature = signature;
      const block = this.thinkingFor(item);
      if (!block.closed && done) {
        const parts = Array.isArray(data.summary)
          ? data.summary
          : Array.isArray(data.content)
            ? data.content
            : [];
        parts.forEach((part, index) => {
          const value = object(part);
          const text =
            asString(value.text) ?? (typeof part === 'string' ? part : '');
          if (text) this.setThinkingPart(block, index, text, false);
        });
        // Only the done frame's cipher is authoritative. With a summary-only
        // done, retain the open block for terminal output to hydrate its cipher.
        block.done = !!signature;
      }
    } else if (type === 'message' && done) {
      const parts = Array.isArray(data.content) ? data.content : [];
      parts.forEach((part, index) => {
        const value = object(part);
        if (value.type !== 'output_text' && value.type !== 'refusal') return;
        const block = this.textFor(item, index);
        this.setSnapshot(
          block,
          asString(value.text) ?? asString(value.refusal) ?? '',
        );
        block.done = true;
      });
      for (const block of item.blocks.values()) block.done = true;
      // Legacy streams may omit the message item identity on text deltas.
      if (
        !parts.length &&
        this.active?.type === 'text' &&
        this.active.item.anonymous
      )
        this.active.done = true;
    } else if (type === 'web_search_call' && done) {
      this.webSearch(item, raw, data);
    }
    item.done = done;
    events.push(...this.flush());
  }

  private setThinkingPart(
    block: OutputBlock,
    index: number,
    text: string,
    delta: boolean,
  ): void {
    if (block.closed) return;
    const parts = block.parts!;
    const previous = parts.get(index) ?? '';
    parts.set(index, delta ? previous + text : text || previous);
    this.setSnapshot(
      block,
      [...parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value)
        .join('\n\n'),
    );
  }

  private updateThinking(
    raw: Json,
    type: string,
    _events: AnthropicStreamEvent[],
  ): void {
    const item = this.itemFor(raw, {}, 'reasoning');
    const block = this.thinkingFor(item);
    if (block.closed) return;
    let part = indexValue(raw.summary_index) ?? indexValue(raw.content_index);
    if (type === 'response.reasoning_summary_part.added') {
      part ??= block.parts!.size ? (block.currentPart ?? 0) + 1 : 0;
      block.currentPart = part;
      if (!block.parts!.has(part)) this.setThinkingPart(block, part, '', false);
    } else {
      part ??= block.currentPart ?? 0;
      block.currentPart = part;
      const value =
        asString(raw.delta) ??
        asString(raw.text) ??
        asString(object(raw.part).text) ??
        '';
      this.setThinkingPart(block, part, value, type.endsWith('.delta'));
    }
  }

  private webSearch(item: OutputItem, raw: Json, data: Json): void {
    const action = object(data.action);
    const query =
      [
        action.query,
        object(raw.action).query,
        data.query,
        raw.query,
        object(data.input).query,
        object(raw.input).query,
      ]
        .map((value) => asString(value)?.trim())
        .find(Boolean) || '';
    const source = [
      data.results,
      raw.results,
      action.sources,
      object(raw.action).sources,
    ].find(Array.isArray);
    const content = Array.isArray(source)
      ? source.flatMap((result) => {
          const value = object(result);
          const url = asString(value.url)?.trim();
          return url
            ? [
                {
                  type: 'web_search_result',
                  url,
                  title: asString(value.title)?.trim() || url,
                  page_age: null,
                },
              ]
            : [];
        })
      : [];
    if (!query && !content.length && !data.action) return;
    const id =
      [
        data.id,
        raw.id,
        data.output_item_id,
        raw.output_item_id,
        data.call_id,
        raw.call_id,
        item.id,
        data.item_id,
        raw.item_id,
      ]
        .map((value) => asString(value)?.trim())
        .find(Boolean) ||
      `web_search_${this.blockIndex + this.contentQueue.length}`;
    const use = this.blockFor(item, 'server_tool_use');
    use.data = { type: 'server_tool_use', id, name: 'web_search', input: {} };
    use.text = query ? JSON.stringify({ query }) : '';
    use.done = true;
    const result = this.blockFor(item, 'web_search_tool_result');
    result.data = { type: 'web_search_tool_result', tool_use_id: id, content };
    result.done = true;
    this.contentQueue.push(use, result);
  }

  private flush(): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    for (;;) {
      if (this.active) {
        const block = this.active;
        if (block.type === 'tool_use' && block.done)
          this.validateToolArguments(block);
        if (block.text.length > block.emitted.length) {
          const value = block.text.slice(block.emitted.length);
          block.emitted = block.text;
          const delta =
            block.type === 'thinking'
              ? { type: 'thinking_delta', thinking: value }
              : block.type === 'text'
                ? { type: 'text_delta', text: value }
                : { type: 'input_json_delta', partial_json: value };
          events.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: block.index, delta },
          });
        }
        if (!block.done) return events;
        if (block.type === 'thinking' && block.item.signature) {
          const signature = encodeReasoningSignature({
            id: block.item.id,
            encryptedContent: block.item.signature,
          });
          if (signature)
            events.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: block.index,
                delta: { type: 'signature_delta', signature },
              },
            });
        }
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: block.index },
        });
        block.closed = true;
        this.active = null;
      }
      while (this.toolQueue[0]?.closed) this.toolQueue.shift();
      while (this.contentQueue[0]?.closed) this.contentQueue.shift();
      const tool = this.toolQueue[0];
      const block = tool?.name ? tool : this.contentQueue[0];
      if (!block) return events;
      block.index = this.blockIndex++;
      this.active = block;
      if (block.type === 'tool_use') this.hasToolUse = true;
      const content =
        block.type === 'tool_use'
          ? {
              type: 'tool_use',
              id: shortenCodexCallId(block.callId || ''),
              name: block.name,
              input: {},
            }
          : block.type === 'thinking'
            ? { type: 'thinking', thinking: '' }
            : block.type === 'text'
              ? { type: 'text', text: '' }
              : block.data;
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: block.index,
          content_block: content,
        },
      });
      if (block.type === 'tool_use' && block.initialEmptyDelta)
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: '' },
          },
        });
    }
  }

  private handleCompleted(
    raw: Json,
    incomplete: boolean,
  ): AnthropicStreamEvent[] {
    const response = object(raw.response);
    const output = Array.isArray(response.output) ? response.output : [];
    if (
      incomplete &&
      raw.type === 'response.incomplete' &&
      !output.length &&
      !this.completedOutputItems &&
      !this.sawMeaningfulOutput &&
      object(response.usage).output_tokens === 0
    )
      return this.handleFailure({
        message:
          'Upstream Codex terminated with an empty incomplete response (0 output tokens)',
      });
    const events = this.ensureMessageStarted(raw);
    // Hydrate every pending call before draining. Its existing aliases take
    // precedence over a terminal-array position that may omit earlier items.
    output.forEach((value, index) => {
      const item = object(value);
      if (item.type === 'function_call') {
        const existingKeys = [
          asString(item.id) ? `item:${item.id}` : '',
          asString(item.call_id) ? `call:${item.call_id}` : '',
          `output:${indexValue(item.output_index) ?? index}`,
        ];
        const existing = existingKeys
          .map((key) => this.aliases.get(key))
          .find((target) => target?.type === 'function_call');
        if (!existing) return;
        const target = this.itemFor(
          { output_index: indexValue(item.output_index) ?? index },
          item,
          'function_call',
        );
        const block = this.toolFor(target);
        if (block.closed) return;
        const name = asString(item.name);
        if (name) block.name = this.originalToolNames.get(name) ?? name;
        block.callId =
          asString(item.call_id) || block.callId || target.id || '';
        this.setSnapshot(block, asString(item.arguments) ?? '');
        block.done = true;
      }
    });
    for (const block of this.toolQueue) block.done = true;
    // Complete content snapshots fill only bytes not already emitted.
    output.forEach((value, index) => {
      const item = object(value);
      this.updateItem(
        { output_index: indexValue(item.output_index) ?? index },
        item,
        true,
        events,
      );
    });
    for (const item of this.items) {
      for (const block of item.blocks.values()) block.done = true;
      if (item.thinking) {
        item.signature ||= item.fallbackSignature;
        item.thinking.done = true;
      }
    }
    if (this.active) this.active.done = true;
    for (const block of this.toolQueue) if (!block.name) block.closed = true;
    events.push(...this.flush());
    this.finished = true;
    this.usage = responseUsage(response);
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason(response, incomplete, this.hasToolUse),
          stop_sequence: asString(response.stop_sequence) || null,
        },
        usage: { ...this.usage },
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }

  private handleFailure(raw: Json): AnthropicStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    this.failure = describeUpstreamFailure(raw);
    return [
      {
        event: 'error',
        data: {
          type: 'error',
          error: { type: this.failure.type, message: this.failure.message },
        },
      },
    ];
  }

  getFailure(): CodexUpstreamFailure | null {
    return this.failure ? { ...this.failure } : null;
  }
  getUsage(): ResponseUsage {
    return structuredClone(this.usage);
  }
}

// ─── 非流式聚合：Codex backend 强制 stream=true，客户端若要非流式
// ─── 响应，由网关聚合完整事件后组装 Anthropic Messages JSON。 ──────

export interface AggregatedAnthropicMessage {
  id: string;
  model: string;
  content: Array<Json>;
  stopReason: StopReason;
  stopSequence?: string | null;
  usage: ResponseUsage;
}

/**
 * 用与流式完全相同的翻译逻辑（converter → Anthropic SSE 事件）聚合出
 * 完整消息：逐块拼装 text/thinking/tool_use 内容与 stop_reason。
 * 上游失败或断流未到 response.completed 时抛错（事件流含 error），
 * 由网关转换为 502，绝不返回截断的部分内容冒充成功。
 */
export function aggregateResponsesStream(
  events: Array<Json>,
  fallbackModel: string,
  options: ResponseConversionOptions = {},
): AggregatedAnthropicMessage {
  const converter = new ResponsesToAnthropicConverter(fallbackModel, options);
  const anthropicEvents: AnthropicStreamEvent[] = [];
  for (const event of events) {
    anthropicEvents.push(...converter.handleEvent(event));
  }
  anthropicEvents.push(...converter.finish());
  if (anthropicEvents.some(({ event }) => event === 'error')) {
    throw new CodexUpstreamError(
      converter.getFailure() ?? {
        type: 'api_error',
        code: null,
        message: 'Upstream Codex stream ended before completion',
      },
    );
  }

  let id = `msg_${Date.now().toString(36)}`;
  let model = fallbackModel;
  let stopReason: AggregatedAnthropicMessage['stopReason'] = 'end_turn';
  let stopSequence: string | null = null;
  const blocks = new Map<number, { block: Json; jsonParts: string[] }>();

  for (const { event, data } of anthropicEvents) {
    switch (event) {
      case 'message_start': {
        const message = (data.message ?? {}) as Json;
        if (typeof message.id === 'string' && message.id) id = message.id;
        if (typeof message.model === 'string' && message.model) {
          model = message.model;
        }
        break;
      }
      case 'content_block_start': {
        const index = typeof data.index === 'number' ? data.index : blocks.size;
        const contentBlock = (data.content_block ?? {}) as Json;
        const type = asString(contentBlock.type);
        const block: Json = { ...contentBlock, type };
        if (type === 'text') block.text = '';
        if (type === 'thinking') {
          block.thinking = '';
          block.signature = '';
        }
        if (type === 'tool_use' || type === 'server_tool_use') {
          if (typeof contentBlock.id === 'string') block.id = contentBlock.id;
          if (typeof contentBlock.name === 'string') {
            block.name = contentBlock.name;
          }
          block.input = {};
        }
        blocks.set(index, { block, jsonParts: [] });
        break;
      }
      case 'content_block_delta': {
        const acc =
          typeof data.index === 'number' ? blocks.get(data.index) : undefined;
        if (!acc) break;
        const delta = (data.delta ?? {}) as Json;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          acc.block.text = `${asString(acc.block.text) ?? ''}${delta.text}`;
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          acc.block.thinking = `${asString(acc.block.thinking) ?? ''}${delta.thinking}`;
        } else if (
          delta.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        ) {
          acc.block.signature = delta.signature;
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          acc.jsonParts.push(delta.partial_json);
        }
        break;
      }
      case 'message_delta': {
        const delta = (data.delta ?? {}) as Json;
        if (
          delta.stop_reason === 'tool_use' ||
          delta.stop_reason === 'max_tokens' ||
          delta.stop_reason === 'end_turn' ||
          delta.stop_reason === 'stop_sequence' ||
          delta.stop_reason === 'pause_turn' ||
          delta.stop_reason === 'refusal' ||
          delta.stop_reason === 'model_context_window_exceeded'
        ) {
          stopReason = delta.stop_reason;
        }
        stopSequence = asString(delta.stop_sequence);
        break;
      }
      default:
        break;
    }
  }

  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => {
      if (
        (acc.block.type === 'tool_use' ||
          acc.block.type === 'server_tool_use') &&
        acc.jsonParts.length > 0
      ) {
        try {
          const argumentsJson = acc.jsonParts.join('');
          const input: unknown = argumentsJson.trim()
            ? JSON.parse(argumentsJson)
            : {};
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error();
          acc.block.input = input as Json;
        } catch {
          throw new CodexUpstreamError({
            type: 'api_error',
            code: 'invalid_tool_arguments',
            message: 'Upstream Codex tool arguments must be a JSON object',
          });
        }
      }
      return acc.block;
    })
    .filter((block) => {
      // 丢弃上游断流留下的空块；空 thinking 但有签名的保留（回放仍需签名）。
      if (block.type === 'text') return asString(block.text) !== '';
      if (block.type === 'thinking') {
        return asString(block.thinking) !== '' || asString(block.signature);
      }
      return true;
    });

  return {
    id,
    model,
    content,
    stopReason,
    stopSequence,
    usage: converter.getUsage(),
  };
}
