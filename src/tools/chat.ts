import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MODEL_KEY_HEADER } from '../api.js';
import { APIError } from '../errors.js';
import { failed, refused, said } from '../format.js';
import * as P from '../paths.js';
import { heartbeat } from '../poll.js';
import { count, label } from './directory.js';
import { computerSchema } from './results.js';
import type { Registrar } from './types.js';

const content = z.union([
  z.string(),
  z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
]);
const message = z.object({ role: z.enum(['system', 'user', 'assistant']), content }).strict();
const usage = z.object({ prompt_tokens: count, completion_tokens: count, total_tokens: count });
const choice = z.object({
  index: count,
  message: z.object({ role: z.literal('assistant'), content: z.string() }),
  finish_reason: label,
});
const agent = z.object({ computer_id: label, steps: count, stop: label });
const completion = z.object({
  id: label,
  object: z.literal('chat.completion'),
  created: count,
  model: label,
  choices: z.array(choice).length(1),
  usage,
  agent,
});
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Retain valid fields even when other terminal metadata is missing or malformed. */
function partial(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(completion.shape)) {
    const parsed = schema.safeParse(value[key]);
    if (parsed.success) result[key] = parsed.data;
  }
  for (const [name, schema] of Object.entries({ agent, usage })) {
    const source = value[name];
    if (!isRecord(source)) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      const parsed = field.safeParse(source[key]);
      if (parsed.success) fields[key] = parsed.data;
    }
    if (Object.keys(fields).length) result[name] = fields;
  }
  // A valid assistant answer is still useful when finish_reason is absent.
  if (Array.isArray(value.choices)) {
    result.choices = value.choices
      .slice(0, 8)
      .filter(isRecord)
      .map((item) => {
        const fields: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(choice.shape)) {
          const parsed = schema.safeParse(item[key]);
          if (parsed.success) fields[key] = parsed.data;
        }
        return fields;
      });
  }
  return result;
}

const steps = z.array(
  z.object({
    n: count,
    tool: z.string().optional(),
    action: z.string().optional(),
    detail: z.string().optional(),
    error: z.string().optional(),
  }),
);
function chatFailure(error: unknown): CallToolResult {
  if (!(error instanceof APIError)) return failed(error);
  const nested = isRecord(error.body) && isRecord(error.body.error) ? error.body.error : undefined;
  const source = nested ?? (isRecord(error.body) ? error.body : {});
  const projected: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries({ reason: label, usage, steps })) {
    const parsed = schema.safeParse(source[key]);
    if (parsed.success) projected[key] = parsed.data;
  }
  const detail = nested && typeof nested.message === 'string' ? nested.message : error.message;
  const result = failed(new APIError(detail, error.status, projected, error.retryAfterMs));
  if (nested && error.status === 401) {
    // Generic account advice is too specific for a nested model-provider refusal.
    const text = result.content[0];
    if (text.type === 'text')
      text.text = text.text.replace(
        / — the credential this server is using[^\n]*/,
        ' — a credential was refused; the nested response alone does not establish whether the account key or model key caused it. Do not replay this run unchanged.',
      );
  }
  result.content.push(
    ...said(
      'Chat refusal metadata; recorded work may already be billed. Inspect what took effect before another run.',
      {
        status: error.status,
        ...(typeof projected.reason === 'string' ? { reason: projected.reason } : {}),
        ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
      },
    ).content,
  );
  return result;
}

/** Do not let a provider echo session secrets into output, even in a known text field. */
function safeResult(result: CallToolResult, modelKey: string): CallToolResult {
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === 'text'
        ? {
            ...item,
            text: item.text
              .split(modelKey)
              .join('[redacted]')
              .replace(/\b(?:com_|sk-)[A-Za-z0-9_-]+/g, '[redacted]'),
          }
        : item,
    ),
  };
}

export const registerChat: Registrar = (server, session) => {
  if (!session.modelKey) return;
  const modelKey = session.modelKey;
  server.registerTool(
    'run_agent_chat',
    {
      title: 'Drive the computer with BYOK textual chat',
      description:
        "Run the same Anthropic computer agent using OpenAI-shaped textual messages and JSON-only results (stream:false). The last user message is the task; system messages provide standing instructions. Previous user/assistant conversation is not replayed. This is BYOK computer control, not hosted inference or a chat UI. The computer must already be running. Bills the caller's Anthropic key. A supplied model must be an Anthropic model name. Progress counts waiting heartbeats, not completed actions. For long runs the client needs progressToken plus resetTimeoutOnProgress; otherwise choose a smaller max_steps, which is not a time or spend cap. Never automatically replay a failed run.",
      inputSchema: {
        computer_id: computerSchema,
        messages: z
          .array(message)
          .min(1)
          .refine((messages) => {
            const last = messages.filter((m) => m.role === 'user').at(-1);
            return (
              last !== undefined &&
              (typeof last.content === 'string'
                ? last.content
                : last.content.map((p) => p.text).join('')
              ).trim().length > 0
            );
          }, 'The last user message must contain text.'),
        model: z
          .string()
          .refine((v) => v.trim().length > 0, 'model must not be blank')
          .optional(),
        max_steps: z.number().int().min(1).max(100).default(20),
      },
      annotations: { openWorldHint: true },
    },
    async ({ computer_id, messages, model, max_steps }, extra) => {
      let beat: ReturnType<typeof heartbeat> | undefined;
      try {
        const id = session.resolve(computer_id);
        extra.signal.throwIfAborted();
        const body = P.chatBody({ computer_id: id, messages, model, max_steps });
        beat = heartbeat(extra, server.server);
        await beat(
          'Waiting for the chat agent result; progress counts heartbeats, not completed actions.',
        );
        const value = await session.api.json('POST', P.CHAT_COMPLETIONS, {
          body,
          headers: { [MODEL_KEY_HEADER]: modelKey },
          signal: extra.signal,
        });
        extra.signal.throwIfAborted();
        const parsed = completion.safeParse(value);
        if (!parsed.success)
          return safeResult(
            refused(
              'Malformed or missing chat terminal metadata; task completion is unconfirmed. Valid partial result:',
              partial(value),
            ),
            modelKey,
          );
        const data = parsed.data;
        const finished =
          data.agent.stop === 'end_turn' &&
          data.choices[0].finish_reason === 'stop' &&
          data.choices[0].index === 0 &&
          data.agent.computer_id === id &&
          data.agent.steps <= max_steps &&
          data.usage.total_tokens === data.usage.prompt_tokens + data.usage.completion_tokens;
        return safeResult(
          finished
            ? said('The chat agent finished.', data)
            : refused(
                'The chat agent did not establish successful task completion. Inspect stop, finish reason and partial work before deciding what remains; do not replay automatically.',
                data,
              ),
          modelKey,
        );
      } catch (error) {
        return safeResult(chatFailure(error), modelKey);
      } finally {
        await beat?.stop();
      }
    },
  );
};
