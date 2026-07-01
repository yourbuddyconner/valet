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
import { validateDefinition, validateAgainstEnvironment } from '../lib/workflow-dag/validator.js';
import { applyOpsLenient } from '../services/workflow-ops.js';
import { getWorkflowSchemaReference } from '../services/workflow-schema-reference.js';
import { resolveAvailableModels } from '../services/model-catalog.js';
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

/**
 * Minimal shape guard for AI SDK v6 UIMessage — matches the fields we
 * actually read (`role`, `parts`, `id`) without pulling in the SDK's
 * full generic type in a Zod-friendly way.
 */
const uiMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(z.record(z.unknown())).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

const chatBodySchema = z.object({
  // All three accept null because the client sends them through
  // JSON.stringify which preserves `null` for unset fields, and a fresh
  // thread has threadId === null on the first request.
  workflowId: z.string().min(1).nullish(),
  threadId: z.string().min(1).nullish(),
  model: z.string().min(1).nullish(),
  messages: z.array(uiMessageSchema),
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

  // Resolve the model + provider FIRST — before any DB writes — so a
  // missing API key or malformed model id can't leave orphaned rows
  // behind. Previously `createCopilotThread` committed a new thread
  // row before we checked provider health, so a mis-configured env
  // would create an orphaned thread on every retry.
  const modelId = modelInput ?? DEFAULT_MODEL;
  const { provider, model } = parseModelId(modelId);
  const envVars = await assembleLlmProviderEnv(db, c.env);
  const providerClient = buildProviderClient(provider, envVars, c.env);

  let thread = threadIdInput ? await getCopilotThread(db, threadIdInput, user.id) : null;
  if (!thread) {
    if (!workflowIdInput) {
      throw new ValidationError('workflowId required to start a new copilot thread');
    }
    thread = await createCopilotThread(db, c.env, {
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
  const incomingUi: UIMessage[] = body.messages.map((m) => ({
    id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
    role: m.role,
    parts: Array.isArray(m.parts) ? m.parts : [],
    metadata: m.metadata,
  }) as UIMessage);
  const lastUi = incomingUi[incomingUi.length - 1];
  if (lastUi && lastUi.role === 'user') {
    await appendCopilotMessage(db, thread.id, {
      role: 'user',
      content: extractText(lastUi),
      parts: lastUi.parts,
    });
  }

  const convertedUi = await convertToModelMessages(incomingUi);
  const modelMessages: ModelMessage[] = [
    { role: 'system', content: thread.systemPrompt },
    ...convertedUi,
  ];

  // Resolve validation env once per request. Both saveDraft and
  // applyWorkflowPatch use it to run the runtime env validator alongside
  // the structural one — otherwise the copilot can happily ship
  // workflows that fail at test-run with "resources not configured".
  const validationEnv = { ...c.env, ...envVars } as Env;
  const availableModels = await resolveAvailableModels(db, validationEnv);

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
      description: 'Persist a NEW draft definition for the workflow under edit, replacing it wholesale. Use this only when starting from scratch or restructuring the workflow at the graph level. For incremental edits to an existing workflow, prefer applyWorkflowPatch — it is dramatically cheaper.',
      inputSchema: z.object({
        definition: z.record(z.unknown()).describe('Full dag/v1 workflow definition: { version, nodes, edges, policy?, ui? }'),
      }),
      execute: async ({ definition }: { definition: Record<string, unknown> }) => {
        // saveDraft is a whole-rewrite tool — we intentionally skip the
        // CAS baseline. The model is knowingly clobbering existing state.
        return validateAndPersist(definition);
      },
    }),
    applyWorkflowPatch: tool({
      description: [
        'Apply a sequence of semantic patch operations to the current draft.',
        'Use this for ALL incremental edits — adding/removing nodes, tweaking',
        'a single field, re-wiring an edge. Operations apply in order and are',
        'atomic: a failure on any op rolls back the entire patch.',
        '',
        'Op types:',
        '  • addNode    { node: <full node object incl. id + type> }',
        '  • updateNode { id: <nodeId>, patch: <deep-merge partial> }',
        '       - JSON-merge-patch semantics: null deletes a key, arrays replace whole',
        '       - cannot change node.id (use removeNode + addNode for that)',
        '  • removeNode { id: <nodeId> } — cascades edges incident on the node',
        '  • addEdge    { edge: { from, to, fromOutput?, when? } }',
        '  • removeEdge { from, to, fromOutput? }',
        '  • setMeta    { patch: { version?, policy?, ui? } }',
        '',
        'On failure, this returns { ok: false, error, issues } — `issues` is',
        'the structured validator output (code, path, message, nodeId/edgeId).',
        'Both structural AND runtime-env validation run here — the model id on',
        'llm nodes must be a currently-available model. Use those to fix the',
        'patch and retry; do not call getWorkflow.',
        '',
        'Always prefer this over saveDraft when the workflow already exists.',
      ].join('\n'),
      inputSchema: z.object({
        ops: z.array(z.record(z.unknown())).min(1).describe('Ordered list of operations. See description for shapes.'),
      }),
      execute: async ({ ops }: { ops: Record<string, unknown>[] }) => {
        // Read the draft AND its updated_at atomically — one D1 query
        // so a canvas save between the two reads can't produce a stale
        // baseline. saveDraft then CAS-checks against this same
        // updated_at, so two concurrent copilot patches (or a copilot
        // patch racing a canvas save) fail the second write with a
        // `conflict` error instead of silently trampling the earlier
        // one.
        const draft = await getDraft(db, workflowId);
        if (!draft.draft) {
          return { ok: false, error: 'no current draft to patch — call saveDraft first to seed one' };
        }
        let next: unknown;
        try {
          next = applyOpsLenient(draft.draft, ops);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const persisted = await validateAndPersist(next, draft.updatedAt);
        return {
          ...persisted,
          appliedOps: ops.length,
        };
      },
    }),
    getNodeSchema: tool({
      description: 'Return the authoritative schema reference for every valid dag/v1 node type — required and optional fields, descriptions, foreach body constraints, condition operations, template syntax, edge fields. Call this BEFORE adding a node type you are not 100% sure about, especially `if`, `approval`, `foreach`, `wait`, and `session`. No arguments.',
      inputSchema: z.object({}),
      execute: async () => getWorkflowSchemaReference(),
    }),
    listModels: tool({
      description: 'List LLM model ids that are currently available in this environment. Use this whenever you set the `model` field on an `llm` node — the model id must come from this list, otherwise the workflow will fail runtime validation.',
      inputSchema: z.object({}),
      execute: async () => ({
        models: availableModels.flatMap((p) =>
          p.models.map((m) => ({ id: m.id, provider: p.provider, name: m.name })),
        ),
      }),
    }),
  };

  /**
   * Shared validate-then-persist pipeline for both saveDraft and
   * applyWorkflowPatch. Runs the structural validator + runtime env
   * validator, then writes via saveDraft. If `expectedUpdatedAt` is
   * provided we require the row to still be at that timestamp — used
   * by applyWorkflowPatch to reject concurrent writes.
   */
  async function validateAndPersist(candidate: unknown, expectedUpdatedAt?: string) {
    const structural = validateDefinition(candidate);
    const envIssues = validateAgainstEnvironment(candidate, validationEnv, { availableModels });
    const issues = [...structural, ...envIssues];
    if (issues.length > 0) {
      return {
        ok: false,
        error: `validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}; fix and retry`,
        issues,
      };
    }
    if (!isWorkflowDefinition(candidate)) {
      return { ok: false, error: 'candidate is not a valid dag/v1 workflow definition' };
    }
    try {
      await saveDraft(db, workflowId, candidate, undefined, expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : undefined);
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'conflict') {
        return {
          ok: false,
          error: 'draft was modified concurrently — call getWorkflow to re-fetch, then re-apply your patch',
        };
      }
      throw err;
    }
    // Include the resulting definition so the client can drop it
    // straight into its React Query cache via setQueryData, skipping
    // an otherwise-redundant GET /workflows/:id/draft round-trip.
    // The definition is also implicit in the model's incremental
    // knowledge (system-prompt snapshot + this turn's patches), so
    // returning it doesn't teach the model anything new — the cost is
    // additional output tokens on a single tool result, which is
    // dwarfed by the round-trip latency we save.
    return {
      ok: true,
      workflowId,
      nodeCount: candidate.nodes.length,
      edgeCount: candidate.edges.length,
      definition: candidate,
    };
  }

  const result = streamText({
    model: providerClient(model),
    messages: modelMessages,
    tools,
    // Let the model run a tool, get the result, and reply — without
    // having to be reprompted on the client side. Capped to keep cost
    // bounded.
    stopWhen: stepCountIs(8),
  });

  // Persist via the UI-message stream's onFinish. This gives us
  // `responseMessage.parts` in the canonical UIMessage shape — one
  // unified tool part per invocation (with state, input, output) —
  // which is exactly what the client renders both live and on reload.
  // Persisting ModelMessage content (previous approach) split tool
  // calls across assistant+tool roles and dropped the tool-name from
  // tool-result parts, so reloaded conversations lost half the picture.
  const threadId = thread.id;
  const streamResp = result.toUIMessageStreamResponse({
    onFinish: async ({ responseMessage }) => {
      const parts = Array.isArray(responseMessage.parts) ? responseMessage.parts : [];
      const textContent = parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
        .map((p) => p.text)
        .join('\n');
      await appendCopilotMessage(db, threadId, {
        role: 'assistant',
        content: textContent,
        parts,
      });
    },
  });
  // Keep the isolate alive to drain the stream even if the client
  // disconnects mid-response, so `onFinish` still runs and the
  // assistant turn gets persisted. Without this, closing the tab
  // during a long tool sequence leaves the thread with a user message
  // and no response on reload.
  c.executionCtx.waitUntil(Promise.resolve(result.consumeStream()));
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
