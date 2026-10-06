import { z } from 'zod';

const text = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();
const image = z
  .object({
    type: z.literal('image'),
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
const block = z.discriminatedUnion('type', [
  text,
  image,
  z
    .object({
      type: z.literal('tool_use'),
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
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
]);

// Unknown top-level SDK options are intentionally accepted then discarded by
// the converter. Validate consumed shapes before they can throw or lose input.
export const CodexMessagesRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    system: z.union([z.string(), z.array(text)]).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.array(block)]),
          })
          .passthrough(),
      )
      .min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            input_schema: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .optional(),
    tool_choice: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('auto') }).passthrough(),
        z.object({ type: z.literal('any') }).passthrough(),
        z.object({ type: z.literal('none') }).passthrough(),
        z
          .object({ type: z.literal('tool'), name: z.string().min(1) })
          .passthrough(),
      ])
      .optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();
