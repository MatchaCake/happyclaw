// Ported from CLIProxyAPI a2976eb8; see docs/licenses/CLIProxyAPI-MIT.txt.
import { z } from 'zod';

const text = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();
const image = z
  .object({
    type: z.literal('image'),
    // URL sources remain an explicit unsupported-input error rather than losing
    // the image silently, as the reference translator currently does.
    source: z
      .object({
        type: z.literal('base64'),
        media_type: z.enum([
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
        ]),
        data: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
const document = z
  .object({
    type: z.literal('document'),
    source: z
      .object({
        type: z.literal('base64'),
        media_type: z.literal('application/pdf'),
        data: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
const toolUseShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
};
const searchResult = z
  .object({
    type: z.literal('web_search_result'),
    title: z.string(),
    url: z.string(),
    page_age: z.string().nullable().optional(),
  })
  .passthrough();
const block = z.discriminatedUnion('type', [
  text,
  image,
  document,
  z.object({ type: z.literal('tool_use'), ...toolUseShape }).passthrough(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string().min(1),
      content: z
        .union([z.string(), z.array(z.union([text, image]))])
        .optional(),
      is_error: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('thinking'),
      thinking: z.string(),
      signature: z.string().optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('redacted_thinking'), data: z.string() })
    .passthrough(),
  // Native search is already executed by the upstream server. Accept its
  // response history without replaying it as a client-side function call.
  z
    .object({ type: z.literal('server_tool_use'), ...toolUseShape })
    .passthrough(),
  z
    .object({
      type: z.literal('web_search_tool_result'),
      tool_use_id: z.string().min(1),
      content: z.union([
        z.array(searchResult),
        z
          .object({
            type: z.literal('web_search_tool_result_error'),
            error_code: z.string(),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
]);
const parallelChoice = { disable_parallel_tool_use: z.boolean().optional() };
const toolChoice = z.union([
  z
    .object({ type: z.literal('auto').optional(), ...parallelChoice })
    .passthrough(),
  z.object({ type: z.literal('any'), ...parallelChoice }).passthrough(),
  z.object({ type: z.literal('none'), ...parallelChoice }).passthrough(),
  z
    .object({
      type: z.literal('tool'),
      name: z.string().min(1),
      ...parallelChoice,
    })
    .passthrough(),
]);
const functionTool = z
  .object({
    type: z.enum(['function', 'custom']).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const webSearchTool = z
  .object({
    type: z.enum(['web_search_20250305', 'web_search_20260209']),
    name: z.string().min(1).optional(),
    allowed_domains: z.array(z.string().min(1)).optional(),
    user_location: z
      .object({
        type: z.literal('approximate'),
        city: z.string().optional(),
        region: z.string().optional(),
        country: z.string().optional(),
        timezone: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Validate every consumed shape; unrelated SDK options remain passthrough and
// are deliberately omitted from the Codex payload.
export const CodexMessagesRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    system: z.union([z.string(), z.array(text)]).optional(),
    messages: z
      .array(
        z.discriminatedUnion('role', [
          z
            .object({
              role: z.enum(['user', 'assistant']),
              content: z.union([z.string(), z.array(block)]),
            })
            .passthrough(),
          z
            .object({
              role: z.literal('system'),
              content: z.union([z.string(), z.array(text)]),
            })
            .passthrough(),
        ]),
      )
      .min(1),
    tools: z.array(z.union([webSearchTool, functionTool])).optional(),
    tool_choice: toolChoice.optional(),
    thinking: z
      .discriminatedUnion('type', [
        z
          .object({
            type: z.literal('enabled'),
            budget_tokens: z.number().int().min(-1).optional(),
          })
          .passthrough(),
        z.object({ type: z.literal('adaptive') }).passthrough(),
        z.object({ type: z.literal('auto') }).passthrough(),
        z.object({ type: z.literal('disabled') }).passthrough(),
      ])
      .optional(),
    output_config: z
      .object({
        effort: z.string().min(1).optional(),
        format: z
          .object({
            type: z.literal('json_schema'),
            schema: z.record(z.string(), z.unknown()),
            name: z.string().min(1).optional(),
            strict: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    service_tier: z.string().optional(),
    speed: z.string().optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine((request, context) => {
    const names = new Set<string>();
    for (const [index, tool] of (request.tools ?? []).entries()) {
      if (!tool.name) continue;
      if (names.has(tool.name))
        context.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: 'Tool names must be unique within a request',
        });
      names.add(tool.name);
    }
    if (
      request.tool_choice?.type === 'tool' &&
      !names.has(request.tool_choice.name)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tool_choice', 'name'],
        message: 'The selected tool must be declared in tools',
      });
    }
  });
