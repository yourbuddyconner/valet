import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { streamText, tool, stepCountIs, convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Env, Variables } from '../env.js';
import { NotFoundError, ValidationError } from '@valet/shared';
import { getWorkflowByIdOrSlug } from '../lib/db.js';
import { getDraft, saveDraft } from '../services/workflow-versions.js';
import { isWorkflowDefinition } from '../lib/workflow-dag/schema.js';
import {
  createCopilotThread,
  getCopilotThread,
  listCopilotThreads,
  listCopilotMessages,
  appendCopilotMessage,
  deleteCopilotThread,
} from '../services/workflow-copilot.js';
import { parseModelId, hasProviderKey } from '../lib/llm/model-id.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';

export const copilotRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_MODEL = 'anthropic:claude-sonnet-4-6';

// ────────────────────────────────────────────────────────────────────────
// Thread CRUD
// ────────────────────────────────────────────────────────────────────────

copilotRouter.get('/threads', async (c) => {
  const user = c.get('user');
  const workflowId = c.req.query('workflowId');
  if (!workflowId) throw new ValidationError('workflowId query param required');
  const db = c.get('db');
  const threads = await listCopilotThreads(db, workflowId, user.id);
  return c.json({ threads: threads.map(stripSystemPrompt) });
});

copilotRouter.get('/threads/:threadId/messages', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const threadId = c.req.param('threadId');
  const thread = await getCopilotThread(db, threadId, user.id);
  if (!thread) throw new NotFoundError('Copilot thread', threadId);
  const messages = await listCopilotMessages(db, threadId);
  return c.json({ thread: stripSystemPrompt(thread), messages });
});

copilotRouter.delete('/threads/:threadId', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const threadId = c.req.param('threadId');
  await deleteCopilotThread(db, threadId, user.id);
  return c.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────
// Chat streaming
// ────────────────────────────────────────────────────────────────────────

const chatBodySchema = z.object({
  // All three accept null because the client sends them through
  // JSON.stringify which preserves `null` for unset fields, and a fresh
  // thread has threadId === null on the first request.
  workflowId: z.string().min(1).nullish(),
  threadId: z.string().min(1).nullish(),
  model: z.string().min(1).nullish(),
  // Vercel AI SDK UI message shape. We pass through to convertToModelMessages.
  messages: z.array(z.record(z.unknown())),
});

copilotRouter.post('/chat', zValidator('json', chatBodySchema), async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const body = c.req.valid('json');

  // Resolve or create the thread. workflowId is required when creating;
  // threadId is required when continuing. Both fields are nullish on
  // the wire to accommodate the client's serialised null defaults.
  const threadIdInput = body.threadId ?? null;
  const workflowIdInput = body.workflowId ?? null;
  const modelInput = body.model ?? null;

  let thread = threadIdInput ? await getCopilotThread(db, threadIdInput, user.id) : null;
  if (!thread) {
    if (!workflowIdInput) {
      throw new ValidationError('workflowId required to start a new copilot thread');
    }
    thread = await createCopilotThread(db, {
      workflowId: workflowIdInput,
      userId: user.id,
      model: modelInput ?? DEFAULT_MODEL,
    });
  }

  // Authorize against the underlying workflow on every call so deleted
  // / transferred workflows can't be edited via stale thread ids.
  const workflow = await getWorkflowByIdOrSlug(db, user.id, thread.workflowId);
  if (!workflow) throw new NotFoundError('Workflow', thread.workflowId);
  const workflowId = workflow.id;

  // Persist the latest user message before kicking off the stream so a
  // disconnect mid-response doesn't lose it.
  const incomingUi = body.messages as unknown as UIMessage[];
  const lastUi = incomingUi[incomingUi.length - 1];
  if (lastUi && lastUi.role === 'user') {
    await appendCopilotMessage(db, thread.id, {
      role: 'user',
      content: extractText(lastUi),
      parts: lastUi.parts,
    });
  }

  const modelId = modelInput ?? thread.model ?? DEFAULT_MODEL;
  const { provider, model } = parseModelId(modelId);

  // Provider client — DB-configured org BYOK keys win over env vars.
  const envVars = await assembleLlmProviderEnv(db, c.env);
  const providerClient = buildProviderClient(provider, envVars, c.env);

  const convertedUi = await convertToModelMessages(incomingUi);
  const modelMessages: ModelMessage[] = [
    { role: 'system', content: thread.systemPrompt },
    ...convertedUi,
  ];

  const tools = {
    getWorkflow: tool({
      description: 'Fetch the current draft definition of the workflow under edit. Use this only if you suspect the snapshot in your system prompt is stale — for instance, after the user mentions an external canvas edit.',
      inputSchema: z.object({}),
      execute: async () => {
        const draft = await getDraft(db, workflowId);
        return {
          workflowId,
          name: workflow.name,
          slug: workflow.slug,
          description: workflow.description,
          publishedVersionId: draft.publishedVersionId,
          draft: draft.draft,
        };
      },
    }),
    saveDraft: tool({
      description: 'Persist a new draft definition for the workflow under edit. Always pass the COMPLETE definition (not a patch). Run validate after saving when you want to confirm structural correctness.',
      inputSchema: z.object({
        definition: z.record(z.unknown()).describe('Full dag/v1 workflow definition: { version, nodes, edges, dataSchema?, uiHints? }'),
      }),
      execute: async ({ definition }: { definition: Record<string, unknown> }) => {
        if (!isWorkflowDefinition(definition)) {
          return { ok: false, error: 'definition is not a valid dag/v1 workflow definition' };
        }
        await saveDraft(db, workflowId, definition);
        return { ok: true, workflowId };
      },
    }),
  };

  const result = streamText({
    model: providerClient(model),
    messages: modelMessages,
    tools,
    // Let the model run a tool, get the result, and reply — without
    // having to be reprompted on the client side. Capped to keep cost
    // bounded.
    stopWhen: stepCountIs(8),
    onFinish: async ({ response }) => {
      // Persist the assistant turn (and any tool calls/results) so the
      // thread can be replayed on reload. Append-only: never mutates
      // earlier messages so the cache prefix stays stable.
      for (const msg of response.messages) {
        if (msg.role === 'assistant' || msg.role === 'tool') {
          await appendCopilotMessage(db, thread!.id, {
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : '',
            parts: msg.content,
          });
        }
      }
    },
  });

  // toUIMessageStreamResponse pipes the UI-message stream the Vercel AI
  // SDK client expects (useChat hook).
  const streamResp = result.toUIMessageStreamResponse();
  // Tag the thread id on the response so the client can persist it.
  streamResp.headers.set('X-Copilot-Thread-Id', thread.id);
  return streamResp;
});

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function buildProviderClient(
  provider: 'anthropic' | 'openai' | 'google',
  envVars: Record<string, string>,
  env: Env,
) {
  if (!hasProviderKey({ ...env, ...envVars } as Env, provider)) {
    throw new ValidationError(`No API key configured for provider "${provider}"`);
  }
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: envVars.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY });
    case 'openai':
      return createOpenAI({ apiKey: envVars.OPENAI_API_KEY ?? env.OPENAI_API_KEY });
    case 'google':
      return createGoogleGenerativeAI({ apiKey: envVars.GOOGLE_API_KEY ?? env.GOOGLE_API_KEY });
  }
}

function extractText(message: UIMessage): string {
  if (!message.parts) return '';
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => p.text)
    .join('\n');
}

function stripSystemPrompt<T extends { systemPrompt: string }>(thread: T): Omit<T, 'systemPrompt'> {
  const { systemPrompt: _systemPrompt, ...rest } = thread;
  return rest;
}
