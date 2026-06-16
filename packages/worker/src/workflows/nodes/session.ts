/**
 * `session` node executor.
 *
 * Two modes (discriminated on `mode`):
 *   - "start": create a new persona-driven session with an initial
 *     prompt via the existing sessionService.createSession.
 *   - "prompt": send a prompt to an existing session via the DO's
 *     /prompt endpoint. Supports optional threadId targeting and a
 *     forceNewThread escape hatch.
 *
 * Both modes optionally wait for the session to reach an idle terminal
 * state via the polling helper in workflows/polling.ts.
 */

import type { SessionNode, StartSessionNode, PromptSessionNode } from '@valet/shared';
import { renderJsonTemplates, renderTemplate } from '../../lib/workflow-dag/expression.js';
import { parseDurationMs } from '../../lib/workflow-dag/duration.js';
import { getDb } from '../../lib/drizzle.js';
import { getUserById } from '../../lib/db/users.js';
import { assertSessionAccess } from '../../lib/db/sessions.js';
import { createThread } from '../../lib/db/threads.js';
import { workflowSpawnedSessions } from '../../lib/schema/workflow-spawned-sessions.js';
import { iterationSuffix, NO_RETRY } from '../types.js';
import { createSession } from '../../services/sessions.js';
import { buildTemplateContext } from '../context.js';
import { coerceTemplateString } from '../templates.js';
import { pollSessionUntilIdle } from '../polling.js';
import type { NodeExecutorArgs } from '../types.js';

const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface SessionStartResult {
  mode: 'start';
  sessionId: string;
  status: string;
  threadId?: string;
  finalStatus?: string;
}

export interface SessionPromptResult {
  mode: 'prompt';
  sessionId: string;
  status: 'queued';
  threadId?: string;
  finalStatus?: string;
}

export type SessionResult = SessionStartResult | SessionPromptResult;

export async function executeSession(args: NodeExecutorArgs<SessionNode>): Promise<SessionResult> {
  if (args.node.mode === 'start') return executeStart(args as NodeExecutorArgs<StartSessionNode>);
  return executePrompt(args as NodeExecutorArgs<PromptSessionNode>);
}

// ─── start mode ─────────────────────────────────────────────────────────────

async function executeStart(args: NodeExecutorArgs<StartSessionNode>): Promise<SessionStartResult> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const prompt = coerceTemplateString(renderTemplate(args.node.prompt, ctx));
  const workspace = coerceTemplateString(renderTemplate(args.node.workspace, ctx));
  const title = args.node.title !== undefined ? coerceTemplateString(renderTemplate(args.node.title, ctx)) : undefined;
  const repo = args.node.repo ? (renderJsonTemplates(args.node.repo, ctx) as StartSessionNode['repo']) : undefined;

  // Split into three sequential step.do calls so a retry of any
  // single step doesn't re-fire the prior side effect. Without this
  // split, a transient D1 failure in the spawned-sessions insert
  // would replay createSession, generating a fresh sandbox UUID and
  // leaving the original sandbox orphaned (no row in
  // workflow_spawned_sessions to find it).
  //
  //   Step A: alloc-id    — pre-allocate the session id (cached UUID)
  //   Step B: record-spawn — insert workflow_spawned_sessions BEFORE
  //                          createSession; cancel-cleanup can now
  //                          find the row even if step C failed.
  //   Step C: create      — createSession (idempotent on PK via
  //                          presetSessionId + onConflictDoNothing)
  //                          and createThread.
  const db = getDb(args.env.DB);
  const iSuffix = iterationSuffix(args.aliases);
  const mode = args.params.mode ?? 'production';
  // 7d retention for test-mode executions, 30d for production —
  // matches the workflow_execution_nodes retention policy.
  const retentionMs = mode === 'test' ? 7 * 86400_000 : 30 * 86400_000;

  // Step A: pre-allocate the session id. Cached in step.do so replays
  // return the same UUID without spawning a new sandbox.
  const sessionId = await args.step.do(`session-start:${args.node.id}${iSuffix}:alloc-id`, async () => {
    return crypto.randomUUID();
  });

  // Step B: insert the spawned-session lookup row BEFORE createSession.
  // If createSession's step.do (C) ever throws before its onConflictDoNothing
  // INSERT lands, cancel-cleanup still has a row pointing at the sandbox
  // (if one was provisioned) to terminate. expires_at + createdAt
  // captured inside step.do so they're replay-stable.
  await args.step.do(`session-start:${args.node.id}${iSuffix}:record-spawn`, async () => {
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + retentionMs).toISOString();
    await db.insert(workflowSpawnedSessions).values({
      executionId: args.params.executionId,
      nodeId: args.node.id,
      sessionId,
      createdAt,
      expiresAt,
    }).onConflictDoNothing().run();
    return null;
  });

  // Step C: createSession + createThread. NO_RETRY caps duplicate-call
  // risk; onConflictDoNothing in db.createSession makes the insert
  // collide cleanly on retry.
  const json = await args.step.do(`session-start:${args.node.id}${iSuffix}:create`, { retries: { ...NO_RETRY } }, async () => {
    const user = await getUserById(db, args.params.userId);
    if (!user) throw new Error(`session node "${args.node.id}": user ${args.params.userId} not found`);
    const result = await createSession(args.env, {
      userId: args.params.userId,
      userEmail: user.email,
      workspace,
      presetSessionId: sessionId,
      ...(title !== undefined ? { title } : {}),
      ...(args.node.personaId !== undefined ? { personaId: args.node.personaId } : {}),
      ...(args.node.model !== undefined ? { initialModel: args.node.model } : {}),
      ...(repo?.url !== undefined ? { repoUrl: repo.url } : {}),
      ...(repo?.branch !== undefined ? { branch: repo.branch } : {}),
      ...(repo?.ref !== undefined ? { ref: repo.ref } : {}),
      ...(repo?.sourceRepoFullName !== undefined ? { sourceRepoFullName: repo.sourceRepoFullName } : {}),
      initialPrompt: prompt,
    }, { url: `workflow://exec/${args.params.executionId}` });

    if (!result.ok) {
      throw new Error(`session node "${args.node.id}": createSession failed (${result.reason}): ${result.message ?? 'unknown'}`);
    }

    const tId = crypto.randomUUID();
    await createThread(args.env.DB, { id: tId, sessionId });
    return JSON.stringify({ threadId: tId, status: String(result.session.status) });
  });
  const created = JSON.parse(json) as { threadId: string; status: string };

  const startResult: SessionStartResult = {
    mode: 'start',
    sessionId,
    threadId: created.threadId,
    status: created.status,
  };

  if (args.node.wait?.mode === 'until_idle') {
    const timeoutMs = args.node.wait.timeout ? (parseDurationMs(args.node.wait.timeout) ?? DEFAULT_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
    startResult.finalStatus = await pollSessionUntilIdle(args.env, args.step, {
      sessionId,
      pollKey: `session-poll:${args.node.id}${iSuffix}`,
      timeoutMs,
    });
  }

  return startResult;
}

// ─── prompt mode ────────────────────────────────────────────────────────────

async function executePrompt(args: NodeExecutorArgs<PromptSessionNode>): Promise<SessionPromptResult> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const sessionId = coerceTemplateString(renderTemplate(args.node.sessionId, ctx));
  if (!sessionId) throw new Error(`session node "${args.node.id}": sessionId did not resolve`);

  const prompt = coerceTemplateString(renderTemplate(args.node.prompt, ctx));
  // Normalize empty-string to undefined so the XOR check below uses one
  // shared semantic for 'absent threadId'.
  const renderedThreadId = args.node.threadId !== undefined
    ? coerceTemplateString(renderTemplate(args.node.threadId, ctx))
    : undefined;
  const requestedThreadId = renderedThreadId && renderedThreadId.length > 0 ? renderedThreadId : undefined;
  if (requestedThreadId !== undefined && args.node.forceNewThread === true) {
    throw new Error(`session node "${args.node.id}": cannot set both threadId and forceNewThread`);
  }

  // Access check is wrapped in step.do so the row read is cached and
  // a hibernation/wake doesn't re-issue the SELECT (and risk
  // observing a row that was deleted between runs).
  const db = getDb(args.env.DB);
  const iSuffix = iterationSuffix(args.aliases);
  const accessJson = await args.step.do(`session-prompt-access:${args.node.id}${iSuffix}`, async () => {
    const session = await assertSessionAccess(db, sessionId, args.params.userId, 'collaborator');
    return JSON.stringify({ status: session.status });
  });
  const session = JSON.parse(accessJson) as { status: string };
  if (['terminated', 'archived', 'error'].includes(session.status)) {
    throw new Error(`session node "${args.node.id}": target session ${sessionId} is not active (status=${session.status})`);
  }

  // forceNewThread: pre-create a thread row and pass its id, matching
  // the orchestrator service's pattern. The DO's /prompt handler
  // doesn't read a `forceNewThread` body field, so sending it would be
  // a silent no-op; creating the row up front guarantees the dispatch
  // lands on a fresh thread. Wrapped in step.do so the generated UUID
  // + insert are cached across replays.
  let effectiveThreadId = requestedThreadId;
  if (args.node.forceNewThread === true) {
    const newId = await args.step.do(`session-prompt-thread:${args.node.id}${iSuffix}`, async () => {
      const id = crypto.randomUUID();
      await createThread(args.env.DB, { id, sessionId });
      return id;
    });
    effectiveThreadId = newId;
  }

  // Wrap the DO fetch in step.do so the prompt is delivered exactly
  // once. session is in STEP_DRIVEN_NODE_TYPES so the outer step.do is
  // bypassed; without this cache, a hibernation/wake or any later
  // step.do retry replays the executor and re-dispatches the prompt.
  await args.step.do(`session-prompt-dispatch:${args.node.id}${iSuffix}`, { retries: { ...NO_RETRY } }, async () => {
    const doId = args.env.SESSIONS.idFromName(sessionId);
    const sessionDO = args.env.SESSIONS.get(doId);
    const body: Record<string, unknown> = { content: prompt };
    if (effectiveThreadId) body.threadId = effectiveThreadId;

    const doRes = await sessionDO.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    if (!doRes.ok) {
      const err = await doRes.text();
      throw new Error(`session node "${args.node.id}": prompt dispatch failed (${doRes.status}): ${err}`);
    }
    return null;
  });

  const promptResult: SessionPromptResult = {
    mode: 'prompt',
    sessionId,
    status: 'queued',
    ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
  };

  if (args.node.wait?.mode === 'until_idle') {
    const timeoutMs = args.node.wait.timeout ? (parseDurationMs(args.node.wait.timeout) ?? DEFAULT_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
    promptResult.finalStatus = await pollSessionUntilIdle(args.env, args.step, {
      sessionId,
      pollKey: `session-poll:${args.node.id}${iSuffix}`,
      timeoutMs,
    });
  }

  return promptResult;
}

