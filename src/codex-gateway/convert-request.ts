// Ported from CLIProxyAPI a2976eb8; see docs/licenses/CLIProxyAPI-MIT.txt.
// Anthropic Messages → Codex Responses request compatibility.
// Reference: CLIProxyAPI's Codex/Claude translator (MIT); keep tool identity,
// multimodal order, and tool-result adjacency consistent across both protocols.

import { createHash } from 'node:crypto';

import { decodeReasoningSignature } from './reasoning-signature.js';

type Json = Record<string, unknown>;

export interface AnthropicRequestSubset {
  model?: string;
  system?: string | Array<Json>;
  messages?: Array<Json>;
  tools?: Array<Json>;
  tool_choice?: Json;
  thinking?: Json;
  output_config?: Json;
  service_tier?: string;
  speed?: string;
}

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: Array<Json>;
  tools?: Array<Json>;
  tool_choice?: Json | 'auto' | 'none' | 'required';
  parallel_tool_calls?: boolean;
  reasoning?: { effort: string; summary: 'auto' };
  text?: { format: Json };
  service_tier?: 'priority';
  include?: string[];
  store: false;
  stream: true;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(content: unknown): Array<Json> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function systemTextParts(content: unknown): string[] {
  return contentBlocks(content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .filter(
      (text) =>
        text.length > 0 &&
        !text.trimStart().startsWith('x-anthropic-billing-header:'),
    );
}

function truncateUtf8(value: string, limit: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) break;
    result += char;
    bytes += size;
  }
  return result;
}

function shortenToolName(name: string): string {
  if (Buffer.byteLength(name) <= 64) return name;
  if (name.startsWith('mcp__')) {
    const separator = name.lastIndexOf('__');
    if (separator > 0)
      return truncateUtf8(`mcp__${name.slice(separator + 2)}`, 64);
  }
  return truncateUtf8(name, 64);
}

/** The response converter must invert this same request-local mapping. */
export function buildCodexToolNameMap(
  tools?: Array<Json>,
): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools ?? []) {
    if (typeof tool.name !== 'string' || !tool.name || names.has(tool.name))
      continue;
    const base = shortenToolName(tool.name);
    let candidate = base;
    for (let suffix = 1; used.has(candidate); suffix++) {
      const ending = `_${suffix}`;
      candidate = `${truncateUtf8(base, 64 - Buffer.byteLength(ending))}${ending}`;
    }
    names.set(tool.name, candidate);
    used.add(candidate);
  }
  return names;
}

/** Both function_call and function_call_output must share this stable identity. */
export function shortenCodexCallId(id: string): string {
  if (Buffer.byteLength(id) <= 64) return id;
  const suffix = `_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
  return `${truncateUtf8(id, 64 - suffix.length)}${suffix}`;
}

const SCHEMA_MAP_KEYS = [
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
];
const SCHEMA_VALUE_KEYS = [
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'additionalItems',
  'contentSchema',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
];

function hasUnsupportedPattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '\\') continue;
    const next = pattern[++i];
    if (
      next === '0' ||
      ((next === 'p' || next === 'P') && pattern[i + 1] === '{')
    )
      return true;
  }
  return false;
}

/** Visit schema positions only: property names and default/enum literals are data. */
function visitSchemas(root: Json, visitor: (schema: Json) => void): void {
  const pending: unknown[] = [root];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!isRecord(current)) continue;
    visitor(current);
    for (const key of SCHEMA_MAP_KEYS) {
      const children = current[key];
      if (isRecord(children)) {
        for (const child of Object.values(children)) pending.push(child);
      }
    }
    for (const key of SCHEMA_VALUE_KEYS) pending.push(current[key]);
  }
}

function scalarConstKey(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  )
    return `number:${value}`;
  return undefined;
}

/** CPA executor compacts only direct function-parameter property schemas. */
function compactConstUnions(parameters: Json): void {
  if (!isRecord(parameters.properties)) return;
  for (const property of Object.values(parameters.properties)) {
    if (!isRecord(property)) continue;
    const hasOne = Object.hasOwn(property, 'oneOf');
    const hasAny = Object.hasOwn(property, 'anyOf');
    if (hasOne === hasAny) continue;
    const keyword = hasOne ? 'oneOf' : 'anyOf';
    const branches = property[keyword];
    if (!Array.isArray(branches) || branches.length < 8) continue;
    const values: unknown[] = [];
    const keys = new Set<string>();
    for (const branch of branches) {
      if (
        !isRecord(branch) ||
        !Object.hasOwn(branch, 'const') ||
        Object.keys(branch).some(
          (key) => !['const', 'description', 'title'].includes(key),
        )
      )
        break;
      const key = scalarConstKey(branch.const);
      if (key === undefined || keys.has(key)) break;
      keys.add(key);
      values.push(branch.const);
    }
    if (values.length !== branches.length) continue;
    if (Object.hasOwn(property, 'enum')) {
      if (
        !Array.isArray(property.enum) ||
        property.enum.length !== values.length
      )
        continue;
      const enumKeys = property.enum.map(scalarConstKey);
      if (
        enumKeys.some((key) => key === undefined || !keys.has(key)) ||
        new Set(enumKeys).size !== keys.size
      )
        continue;
      // Keep the existing equivalent enum's order and remove only redundancy.
    } else property.enum = values;
    delete property[keyword];
  }
}

function normalizeToolParameters(value: unknown): Json {
  const root: Json = isRecord(value)
    ? JSON.parse(JSON.stringify(value))
    : { type: 'object', properties: {} };
  visitSchemas(root, (schema) => {
    delete schema.$schema;
    delete schema.$id;
    if (
      typeof schema.pattern === 'string' &&
      hasUnsupportedPattern(schema.pattern)
    )
      delete schema.pattern;
    if (isRecord(schema.patternProperties)) {
      for (const pattern of Object.keys(schema.patternProperties)) {
        if (hasUnsupportedPattern(pattern))
          delete schema.patternProperties[pattern];
      }
    }
  });
  if (root.type === undefined || root.type === null || root.type === '')
    root.type = 'object';
  if (
    (root.type === 'object' ||
      (Array.isArray(root.type) && root.type.includes('object'))) &&
    root.properties == null
  )
    root.properties = {};
  compactConstUnions(root);
  return root;
}

function imageToInputImage(source: unknown): Json | null {
  if (
    !isRecord(source) ||
    source.type !== 'base64' ||
    typeof source.data !== 'string'
  )
    return null;
  return {
    type: 'input_image',
    image_url: `data:${source.media_type};base64,${source.data}`,
  };
}

function documentToInputFile(source: unknown): Json | null {
  if (
    !isRecord(source) ||
    source.type !== 'base64' ||
    source.media_type !== 'application/pdf' ||
    typeof source.data !== 'string'
  )
    return null;
  return {
    type: 'input_file',
    file_data: `data:application/pdf;base64,${source.data}`,
    filename: 'document.pdf',
  };
}

function alignToolResults(
  blocks: Array<Json>,
  pendingIds: string[],
): Array<Json> {
  const results = blocks.filter((block) => block.type === 'tool_result');
  if (!pendingIds.length || results.length !== pendingIds.length) return blocks;
  const byId = new Map<string, Json>();
  for (const result of results) {
    if (typeof result.tool_use_id !== 'string' || byId.has(result.tool_use_id))
      return blocks;
    byId.set(result.tool_use_id, result);
  }
  if (
    new Set(pendingIds).size !== pendingIds.length ||
    pendingIds.some((id) => !byId.has(id))
  )
    return blocks;
  let index = 0;
  return blocks.map((block) =>
    block.type === 'tool_result' ? byId.get(pendingIds[index++])! : block,
  );
}

function toolResultOutput(content: unknown): unknown {
  if (typeof content === 'string') return content;
  const converted: Json[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string')
      converted.push({ type: 'input_text', text: block.text });
    if (block.type === 'image') {
      const image = imageToInputImage(block.source);
      if (image) converted.push(image);
    }
  }
  return converted.length ? converted : '';
}

function messageToInputItems(
  message: Json,
  blocks: Array<Json>,
  names: Map<string, string>,
  reminders: Json[],
): Array<Json> {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const items: Json[] = [];
  let content: Json[] = [];
  const flush = (): void => {
    if (!content.length) return;
    items.push({ type: 'message', role, content });
    content = [];
  };
  const flushReminders = (): void => {
    if (!reminders.length) return;
    flush();
    items.push(...reminders.splice(0));
  };
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (Array.isArray(message.content)) flushReminders();
        if (typeof block.text === 'string')
          content.push({
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: block.text,
          });
        break;
      case 'image': {
        flushReminders();
        const image = imageToInputImage(block.source);
        if (image) content.push(image);
        break;
      }
      case 'document': {
        flushReminders();
        const document = documentToInputFile(block.source);
        if (document) content.push(document);
        break;
      }
      case 'thinking': {
        if (role !== 'assistant') break;
        const signature = decodeReasoningSignature(block.signature);
        if (!signature) break;
        flush();
        // Stateless encrypted reasoning is replayed without stale item IDs.
        items.push({
          type: 'reasoning',
          summary: [],
          content: null,
          encrypted_content: signature.encryptedContent,
        });
        break;
      }
      case 'tool_use':
        flush();
        if (typeof block.name !== 'string' || typeof block.id !== 'string')
          break;
        items.push({
          type: 'function_call',
          call_id: shortenCodexCallId(block.id),
          name: names.get(block.name) ?? shortenToolName(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        });
        break;
      case 'tool_result':
        flush();
        if (typeof block.tool_use_id !== 'string') break;
        items.push({
          type: 'function_call_output',
          call_id: shortenCodexCallId(block.tool_use_id),
          output: toolResultOutput(block.content),
        });
        break;
      // Server-executed search and foreign/redacted thinking are not client calls.
      case 'server_tool_use':
      case 'web_search_tool_result':
      case 'redacted_thinking':
        break;
    }
  }
  flush();
  flushReminders();
  return items;
}

function isWebSearchTool(tool: Json): boolean {
  return (
    tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209'
  );
}

function convertTools(
  tools: Array<Json>,
  names: Map<string, string>,
): Array<Json> {
  return tools.map((tool) => {
    if (isWebSearchTool(tool)) {
      const converted: Json = { type: 'web_search' };
      if (Array.isArray(tool.allowed_domains))
        converted.filters = { allowed_domains: tool.allowed_domains };
      if (isRecord(tool.user_location))
        converted.user_location = tool.user_location;
      return converted;
    }
    return {
      type: 'function',
      name:
        names.get(tool.name as string) ?? shortenToolName(tool.name as string),
      ...(typeof tool.description === 'string'
        ? { description: tool.description }
        : {}),
      parameters: normalizeToolParameters(tool.input_schema),
      strict: false,
    };
  });
}

function convertToolChoice(
  choice: Json | undefined,
  names: Map<string, string>,
  tools: Array<Json>,
): Json | 'auto' | 'none' | 'required' {
  switch (choice?.type) {
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool': {
      if (
        tools.some((tool) => isWebSearchTool(tool) && tool.name === choice.name)
      )
        return { type: 'web_search' };
      const name = typeof choice.name === 'string' ? choice.name : '';
      return name
        ? { type: 'function', name: names.get(name) ?? shortenToolName(name) }
        : 'auto';
    }
    default:
      return 'auto';
  }
}

export interface AnthropicToResponsesOptions {
  targetModel: string;
  /** Effective request effort, already clamped against the provider catalog. */
  reasoningEffort?: string;
  requestTools?: boolean;
}

export function normalizeCodexEffort(effort: string | undefined): string {
  if (!effort) return 'medium';
  return effort === 'minimal' ? 'low' : effort;
}

/** Explicit provider configuration wins; otherwise preserve the SDK's intent. */
export function resolveCodexRequestEffort(
  request: AnthropicRequestSubset,
  configuredOverride?: string,
): string {
  if (configuredOverride?.trim())
    return normalizeCodexEffort(configuredOverride.trim().toLowerCase());
  switch (request.thinking?.type) {
    case 'disabled':
      return 'none';
    case 'adaptive':
    case 'auto': {
      const effort = request.output_config?.effort;
      return typeof effort === 'string' && effort.trim()
        ? effort.trim().toLowerCase()
        : 'xhigh';
    }
    case 'enabled': {
      const budget = request.thinking.budget_tokens;
      if (typeof budget !== 'number') break;
      if (budget === -1) return 'auto';
      if (budget === 0) return 'none';
      if (budget <= 512) return 'minimal';
      if (budget <= 1024) return 'low';
      if (budget <= 8192) return 'medium';
      if (budget <= 24576) return 'high';
      return 'xhigh';
    }
  }
  return 'medium';
}

function convertOutputFormat(
  config: Json | undefined,
): { format: Json } | undefined {
  const format = config?.format;
  if (
    !isRecord(format) ||
    format.type !== 'json_schema' ||
    !isRecord(format.schema)
  )
    return undefined;
  let strict = format.strict !== false;
  visitSchemas(format.schema, (schema) => {
    if (!isRecord(schema.properties)) return;
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    if (Object.keys(schema.properties).some((key) => !required.has(key)))
      strict = false;
  });
  return {
    format: {
      type: 'json_schema',
      name:
        typeof format.name === 'string' && format.name
          ? format.name
          : 'cli_proxy_structured_output',
      strict,
      schema: JSON.parse(JSON.stringify(format.schema)),
    },
  };
}

export function anthropicToResponses(
  request: AnthropicRequestSubset,
  options: AnthropicToResponsesOptions,
): ResponsesRequest {
  const input: Json[] = [];
  const names = buildCodexToolNameMap(request.tools);
  const systemParts = systemTextParts(request.system);
  if (systemParts.length)
    input.push({
      type: 'message',
      role: 'developer',
      content: systemParts.map((text) => ({ type: 'input_text', text })),
    });
  const reminders: Json[] = [];
  let pendingToolUseIds: string[] = [];
  for (const message of request.messages ?? []) {
    if (message.role === 'system') {
      const text = systemTextParts(message.content).join('\n');
      if (!text.trim()) continue;
      const reminder = {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<system-reminder>\n${text}\n</system-reminder>`,
          },
        ],
      };
      if (pendingToolUseIds.length) reminders.push(reminder);
      else input.push(reminder);
      continue;
    }
    let blocks = contentBlocks(message.content);
    if (message.role === 'user')
      blocks = alignToolResults(blocks, pendingToolUseIds);
    pendingToolUseIds = blocks
      .filter(
        (block) => block.type === 'tool_use' && typeof block.id === 'string',
      )
      .map((block) => block.id as string);
    input.push(...messageToInputItems(message, blocks, names, reminders));
  }
  input.push(...reminders);
  const tools = request.tools?.length
    ? convertTools(request.tools, names)
    : undefined;
  const payload: ResponsesRequest = {
    model: options.targetModel,
    instructions: '',
    input,
    reasoning: {
      effort: resolveCodexRequestEffort(request, options.reasoningEffort),
      summary: 'auto',
    },
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
  };
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = convertToolChoice(
      request.tool_choice,
      names,
      request.tools!,
    );
    payload.parallel_tool_calls =
      request.tool_choice?.disable_parallel_tool_use !== true;
    if (request.tools!.some(isWebSearchTool))
      payload.include!.push('web_search_call.action.sources');
  }
  const format = convertOutputFormat(request.output_config);
  if (format) payload.text = format;
  if (
    request.speed === 'fast' ||
    ['fast', 'priority'].includes(
      request.service_tier?.trim().toLowerCase() ?? '',
    )
  )
    payload.service_tier = 'priority';
  return payload;
}

/**
 * 旧目录模型归一：gpt-5.1 系列已从上游目录移除（请求直接 400），
 * 存量 provider 配置里的旧值在请求时映射到 GPT-6 对应档
 * （映射语义对齐官方 gpt-5.4→sol / gpt-5.4-mini→luna 迁移）。
 */
const LEGACY_CODEX_MODELS: Readonly<Record<string, string>> = {
  'gpt-5.1': 'gpt-6-sol',
  'gpt-5.1-codex': 'gpt-6-sol',
  'gpt-5.1-codex-max': 'gpt-6-sol',
  'gpt-5.1-codex-mini': 'gpt-6-luna',
};

export function normalizeLegacyCodexModel(model: string): string {
  return LEGACY_CODEX_MODELS[model] ?? model;
}

/**
 * 模型名重写：SDK 可能硬编码请求 claude-* 系列（haiku 后台任务等），
 * 一律映射到 provider 配置的 Codex 模型，避免上游 404；
 * 旧目录模型（gpt-5.1-*）归一到现役 GPT-6 目录，存量配置无需手动迁移。
 */
export function resolveCodexModel(
  requestModel: string | undefined,
  configuredModel: string,
): string {
  const configured = normalizeLegacyCodexModel(configuredModel || 'gpt-6-sol');
  if (!requestModel) return configured;
  if (/^claude/i.test(requestModel)) {
    return configured;
  }
  return normalizeLegacyCodexModel(requestModel);
}
