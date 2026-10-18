import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MODEL_KEY_HEADER } from '../api.js';
import { APIError, agentRunAdvice, messageFromBody } from '../errors.js';
import { apiErrorMessage, errorMetadata, failed, originWording, refused, said } from '../format.js';
import * as P from '../paths.js';
import { heartbeat } from '../poll.js';
import {
  keptThread,
  keptThreadField,
  STORE_WITH_THREAD,
  storeArg,
  threadIdArg,
  threadLine,
} from './conversation.js';
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
// `thread_id` is the thread the exchange was kept in (OPL-6085), absent with
// `store: false`; listed here because an object schema drops what it does not
// name, and the id is what continues the conversation.
const agent = z.object({
  computer_id: label,
  steps: count,
  stop: label,
  thread_id: keptThreadField,
});
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
const failedAgent = z.object({
  computer_id: label,
  usage: z.object({
    input_tokens: count,
    output_tokens: count,
    cache_read_tokens: count,
    cache_write_tokens: count,
  }),
  steps,
  // A failed run is kept too, once it acted or when it continued a thread.
  thread_id: keptThreadField,
});
/**
 * The advice for a failed chat run, in place of the status advice every other
 * tool gets (OPL-5437). A run that started and failed comes back in OpenAI's
 * nested shape, `{error: {message, ...}}`, and there its 402, 504, 529 and
 * unrevoked 403 are the model provider's statuses for the configured model key
 * rather than the Mandala plan or role — see `agentRunAdvice`. A flat
 * `{error: string}` is the platform refusing before any run started (the role
 * gate, a bad body, a suspension, the meter), so it keeps the status advice
 * every other tool gets: nothing ran, nothing was billed, and a viewer's 403 is
 * the role. Without a JSON body the status is a proxy's, and the one this route
 * meets by design is the hosted edge's cut on a request that is not streaming.
 */
function runAdvice(error: APIError): string | undefined {
  if (isRecord(error.body)) {
    return isRecord(error.body.error)
      ? agentRunAdvice(error.status, error.reason, 'run_agent_chat')
      : undefined;
  }
  if (edgeCut(error)) return EDGE_CUT.advice;
  return undefined;
}

/**
 * The hosted edge cuts a request that is not streaming after about 120 seconds
 * with a 524 that carries no JSON body (none at all, or the edge's own page),
 * and this tool's request never streams. The platform ties the run to the
 * request, so the cut stops the run where it was and loses its result, usage
 * and steps.
 *
 * `detail` stands in for the message, not beside it: the shared gateway text
 * for a 524 says the work carries on without the request, which is true of a
 * foreground exec and false here, and one answer cannot say both (OPL-5445).
 * `advice` is the rest of the account, given in place of the status advice.
 */
const EDGE_CUT = {
  detail: 'The hosted edge cut this request after about 120 seconds, because it does not stream',
  advice:
    'the run was stopped where it was, and its result, usage and steps were lost with it. Steps it took were still billed and may have changed the computer, so take a screenshot before deciding what is left, and use run_agent, which streams, for a task that can take longer. Do not call run_agent_chat again with the same task',
} as const;

/** A 524 with no JSON record body is the edge's cut, not the platform's answer. */
const edgeCut = (error: APIError): boolean => error.status === 524 && !isRecord(error.body);

function chatFailure(error: unknown): CallToolResult {
  if (!(error instanceof APIError)) return failed(error);
  const nested = isRecord(error.body) && isRecord(error.body.error) ? error.body.error : undefined;
  const source = nested ?? (isRecord(error.body) ? error.body : {});
  const projected: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries({ usage, steps })) {
    const parsed = schema.safeParse(source[key]);
    if (parsed.success) projected[key] = parsed.data;
  }
  projected.reason = error.reason;
  const native = failedAgent.safeParse(nested?.agent);
  const boundedNative = native.success && JSON.stringify(native.data).length <= 4000;
  const incompleteNative = nested?.agent !== undefined && !boundedNative;
  // A nested `{error: {...}}` body on this route is always the platform's own
  // run-failure envelope, which forwards the model provider's status: a 522 or
  // 525 there is the provider's edge failing a later step, after earlier steps
  // ran and were billed. The SDK wording ("the request was never sent") would
  // be false, so it applies only to a flat or absent body, which is the edge in
  // front of the platform speaking.
  const detail =
    (nested === undefined ? originWording(error) : undefined) ??
    (isRecord(error.body)
      ? (messageFromBody(error.body) ?? 'Chat request failed without a usable error message')
      : edgeCut(error)
        ? EDGE_CUT.detail
        : apiErrorMessage(error));
  const result = failed(
    new APIError(detail, error.status, { ...projected, error: detail }, error.retryAfterMs, error),
    nested === undefined,
    runAdvice(error),
  );
  const diagnostics = errorMetadata(error);
  // Read on its own rather than off the bounded native record: a failure with
  // many steps is exactly the one whose record is omitted for size, and the
  // thread is how the next run picks up from what those steps did.
  const thread = keptThread(isRecord(nested?.agent) ? nested.agent.thread_id : undefined);
  if (thread) result.content.push({ type: 'text', text: threadLine(thread) });
  result.content.push(
    ...said(
      `${incompleteNative ? 'Native agent failure metadata was malformed or oversized and omitted. ' : ''}${diagnostics.omitted ? 'Oversized diagnostic metadata was omitted. ' : ''}Chat refusal metadata; recorded work may already be billed. Inspect what took effect before another run.`,
      {
        ...diagnostics.fields,
        ...(thread ? { thread_id: thread } : {}),
        ...(boundedNative ? { agent: native.data } : {}),
        ...(incompleteNative ? { incomplete: true } : {}),
      },
    ).content,
  );
  return result;
}

/**
 * Do not let a provider echo session secrets into output, even in a known text
 * field. A run on credits has no model key to look for; splitting on an empty
 * string would put the marker between every character, so it is skipped.
 */
export function safeResult(result: CallToolResult, modelKey: string | undefined): CallToolResult {
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === 'text'
        ? {
            ...item,
            text: (modelKey ? item.text.split(modelKey).join('[redacted]') : item.text).replace(
              /\b(?:com_|sk-)[A-Za-z0-9_-]+/g,
              '[redacted]',
            ),
          }
        : item,
    ),
  };
}

/**
 * BYOK only, and that is the platform's rule rather than this server's: the
 * chat route refuses a run without a model key, so a session whose run_agent
 * runs on AI credits still has no run_agent_chat.
 */
export const registerChat: Registrar = (server, session) => {
  if (!session.modelKey) return;
  const modelKey = session.modelKey;
  server.registerTool(
    'run_agent_chat',
    {
      title: 'Drive the computer with BYOK textual chat',
      description:
        "Run the same hosted computer agent using OpenAI-shaped textual messages and JSON-only results (stream:false). The last user message is the task; system messages provide standing instructions; the user and assistant messages before it are given to the model as the conversation so far, told they are done. With thread_id, the thread's own turns are the conversation instead and earlier messages are not read, so the last user message alone is enough. Unless it sent store: false, every run that acts or answers is kept in a thread, and agent.thread_id in the answer continues it. This is BYOK computer control, not hosted inference or a chat UI. The computer must already be running. Bills the caller's configured Anthropic or OpenAI key. A GPT or o-series model selects OpenAI; a Claude model selects Anthropic. SHORT TASKS ONLY: on the hosted API a request that does not stream is cut at the edge after about 120 seconds (HTTP 524), which stops the run and loses its result, usage and steps, and the default 20 steps can take longer than that. Use run_agent, which streams, for anything longer. Progress counts waiting heartbeats, not completed actions; progressToken plus resetTimeoutOnProgress keeps only the MCP client waiting, not the edge. Never automatically replay a failed run.",
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
        provider: z
          .enum(['anthropic', 'openai'])
          .optional()
          .describe(
            'Inferred from model when omitted. Select openai to use gpt-6.1-sol by default. The configured MANDALA_MODEL_KEY must match the provider.',
          ),
        model: z
          .string()
          .refine((v) => v.trim().length > 0, 'model must not be blank')
          .optional(),
        max_steps: z.number().int().min(1).max(P.AGENT_MAX_STEPS).default(20),
        thread_id: threadIdArg,
        store: storeArg,
      },
      annotations: { openWorldHint: true },
    },
    async ({ computer_id, messages, model, provider, max_steps, thread_id, store }, extra) => {
      if (store === false && thread_id !== undefined) return refused(STORE_WITH_THREAD);
      let beat: ReturnType<typeof heartbeat> | undefined;
      try {
        const id = session.resolve(computer_id);
        extra.signal.throwIfAborted();
        const body = P.chatBody({
          computer_id: id,
          messages,
          model,
          provider,
          max_steps,
          thread_id,
          store,
        });
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
        if (!parsed.success) {
          // The rest of the answer did not parse, but a thread it names is
          // still where this run's exchange was kept.
          const thread = keptThread(
            isRecord(value) && isRecord(value.agent) ? value.agent.thread_id : undefined,
          );
          return safeResult(
            refused(
              `Malformed or missing chat terminal metadata; task completion is unconfirmed.${thread ? ` ${threadLine(thread)}` : ''} Valid partial result:`,
              partial(value),
            ),
            modelKey,
          );
        }
        const data = parsed.data;
        const finished =
          data.agent.stop === 'end_turn' &&
          data.choices[0].finish_reason === 'stop' &&
          data.choices[0].index === 0 &&
          data.agent.computer_id === id &&
          data.agent.steps <= max_steps &&
          data.usage.total_tokens === data.usage.prompt_tokens + data.usage.completion_tokens;
        const thread = keptThread(data.agent.thread_id);
        const kept = thread ? ` ${threadLine(thread)}` : '';
        return safeResult(
          finished
            ? said(`The chat agent finished.${kept}`, data)
            : refused(
                `The chat agent did not establish successful task completion. Inspect stop, finish reason and partial work before deciding what remains; do not replay automatically.${kept}`,
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
