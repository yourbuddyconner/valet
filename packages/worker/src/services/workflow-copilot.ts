/**
 * Workflow Copilot service.
 *
 * Per-workflow chat threads backed by the Vercel AI SDK. Distinct from
 * agent sessions: stateless conversations, no sandbox, scoped tools,
 * frozen system prompt for cache stability.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { copilotThreads, copilotMessages } from '../lib/schema/copilot.js';
import { getWorkflowByIdOrSlug } from '../lib/db.js';
import { getDraft } from './workflow-versions.js';
import { getWorkflowSchemaReference } from './workflow-schema-reference.js';
import { NotFoundError } from '@valet/shared';

export interface CopilotThread {
  id: string;
  workflowId: string;
  userId: string;
  systemPrompt: string;
  model: string | null;
  title: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CopilotMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  parts: unknown | null;
  createdAt: string;
}

export async function listCopilotThreads(
  db: AppDb,
  workflowId: string,
  userId: string,
): Promise<CopilotThread[]> {
  const rows = await db.select().from(copilotThreads)
    .where(and(eq(copilotThreads.workflowId, workflowId), eq(copilotThreads.userId, userId)))
    .orderBy(desc(copilotThreads.updatedAt))
    .all();
  return rows.map(toThread);
}

export async function getCopilotThread(
  db: AppDb,
  threadId: string,
  userId: string,
): Promise<CopilotThread | null> {
  const row = await db.select().from(copilotThreads)
    .where(and(eq(copilotThreads.id, threadId), eq(copilotThreads.userId, userId)))
    .get();
  return row ? toThread(row) : null;
}

export async function listCopilotMessages(
  db: AppDb,
  threadId: string,
): Promise<CopilotMessage[]> {
  const rows = await db.select().from(copilotMessages)
    .where(eq(copilotMessages.threadId, threadId))
    .orderBy(copilotMessages.createdAt)
    .all();
  return rows.map(toMessage);
}

/**
 * Create a new copilot thread. The system prompt is rendered against
 * the workflow's *current* draft and snapshotted into the row — it's
 * not re-templated on subsequent turns. This is intentional:
 *   • Cache prefix stays stable across the conversation lifetime.
 *   • The model can call getWorkflow if it suspects drift.
 *   • Simpler mental model: the thread carries its own context.
 */
export async function createCopilotThread(
  db: AppDb,
  params: { workflowId: string; userId: string; model?: string | null },
): Promise<CopilotThread> {
  const workflow = await getWorkflowByIdOrSlug(db, params.userId, params.workflowId);
  if (!workflow) throw new NotFoundError('Workflow', params.workflowId);

  const draft = await getDraft(db, workflow.id);
  const definition = draft.draft ?? JSON.parse(workflow.data as string);
  const systemPrompt = renderSystemPrompt({
    workflowName: workflow.name,
    workflowId: workflow.id,
    description: workflow.description ?? null,
    definition,
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(copilotThreads).values({
    id,
    workflowId: workflow.id,
    userId: params.userId,
    systemPrompt,
    model: params.model ?? null,
    title: null,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    workflowId: workflow.id,
    userId: params.userId,
    systemPrompt,
    model: params.model ?? null,
    title: null,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function appendCopilotMessage(
  db: AppDb,
  threadId: string,
  params: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    parts?: unknown;
  },
): Promise<CopilotMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(copilotMessages).values({
    id,
    threadId,
    role: params.role,
    content: params.content,
    parts: params.parts !== undefined ? JSON.stringify(params.parts) : null,
    createdAt: now,
  });

  // Backfill the thread title from the first user message so the
  // switcher shows something more recognizable than `Thread 4f9c…`.
  const updates: Record<string, unknown> = {
    messageCount: sql`message_count + 1`,
    updatedAt: now,
  };
  if (params.role === 'user' && params.content.trim().length > 0) {
    const existing = await db.select({ title: copilotThreads.title })
      .from(copilotThreads)
      .where(eq(copilotThreads.id, threadId))
      .get();
    if (existing && !existing.title) {
      updates.title = deriveThreadTitle(params.content);
    }
  }

  await db.update(copilotThreads)
    .set(updates)
    .where(eq(copilotThreads.id, threadId));
  return {
    id,
    threadId,
    role: params.role,
    content: params.content,
    parts: params.parts ?? null,
    createdAt: now,
  };
}

function deriveThreadTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 60 ? cleaned.slice(0, 60) + '…' : cleaned;
}

export async function deleteCopilotThread(
  db: AppDb,
  threadId: string,
  userId: string,
): Promise<void> {
  await db.delete(copilotThreads)
    .where(and(eq(copilotThreads.id, threadId), eq(copilotThreads.userId, userId)));
}

// ────────────────────────────────────────────────────────────────────────
// System prompt template
// ────────────────────────────────────────────────────────────────────────

/**
 * The system prompt is the *entire* persistent context the copilot
 * carries — workflow definition included. Frozen at thread creation,
 * which gives Anthropic prompt caching the maximum prefix to reuse.
 */
function renderSystemPrompt(input: {
  workflowName: string;
  workflowId: string;
  description: string | null;
  definition: unknown;
}): string {
  const defJson = JSON.stringify(input.definition, null, 2);
  const schemaJson = JSON.stringify(getWorkflowSchemaReference(), null, 2);
  return [
    `You are the Valet workflow copilot. Your job is to help the user build, edit,`,
    `validate, and ship the workflow they are currently editing. You have direct`,
    `access to that workflow's draft through the tools below.`,
    ``,
    `## Workflow under edit`,
    ``,
    `Name:        ${input.workflowName}`,
    `ID:          ${input.workflowId}`,
    input.description ? `Description: ${input.description}` : '',
    ``,
    `### Draft definition (dag/v1)`,
    ``,
    '```json',
    defJson,
    '```',
    ``,
    `### dag/v1 schema reference`,
    ``,
    `This is the authoritative shape for every valid node type. Do not invent`,
    `node types or fields not listed here. Common mistakes:`,
    `  • the conditional node type is \`if\` (with \`conditions[]\`), not "condition"`,
    `    or "branch"`,
    `  • approval nodes need \`prompt\` (required), not \`summary\``,
    `  • tool nodes require \`service\`, \`action\`, AND \`params\``,
    `  • foreach.body must be one of: ${getWorkflowSchemaReference().foreachBodyTypes.join(', ')}`,
    ``,
    '```json',
    schemaJson,
    '```',
    ``,
    `This snapshot was taken when this conversation started. The user or other`,
    `agents may edit it through the canvas; if you suspect drift, call`,
    `getWorkflow to fetch the latest.`,
    ``,
    `## How to make edits`,
    ``,
    `**Prefer applyWorkflowPatch** for every incremental edit — adding a node,`,
    `tweaking one field, re-wiring an edge. It applies a list of small semantic`,
    `ops (addNode, updateNode, removeNode, addEdge, removeEdge, setMeta) without`,
    `you having to re-emit the whole definition. Cheap, atomic, and exactly`,
    `targets what changed.`,
    ``,
    `Use **saveDraft** only when starting from scratch or restructuring at the`,
    `graph level — i.e. when re-emitting the full definition is genuinely`,
    `simpler than describing the diff. Don't reach for it for routine edits.`,
    ``,
    `## Rules`,
    ``,
    `- You only operate on this one workflow. Refuse requests to modify others.`,
    `- Don't ask permission for low-risk edits — just patch. The user can see`,
    `  and undo your changes from the canvas.`,
    `- Confirm before publish or destructive actions.`,
    `- If a node type or action is unfamiliar, call getNodeSchema or`,
    `  getActionSchema rather than guessing.`,
    `- Keep responses tight. The user has the canvas open and wants results,`,
    `  not narration.`,
  ].filter(Boolean).join('\n');
}

function toThread(row: typeof copilotThreads.$inferSelect): CopilotThread {
  return {
    id: row.id,
    workflowId: row.workflowId,
    userId: row.userId,
    systemPrompt: row.systemPrompt,
    model: row.model ?? null,
    title: row.title ?? null,
    messageCount: row.messageCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: typeof copilotMessages.$inferSelect): CopilotMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as 'user' | 'assistant' | 'tool',
    content: row.content,
    parts: row.parts ? JSON.parse(row.parts) : null,
    createdAt: row.createdAt,
  };
}
