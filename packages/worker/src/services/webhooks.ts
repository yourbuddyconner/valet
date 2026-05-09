import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { checkWorkflowConcurrency, enqueueWorkflowExecution } from './executions.js';
import { sha256Hex, createWorkflowSession } from '../lib/workflow-runtime.js';

// ─── Generic Webhook Handler ────────────────────────────────────────────────

export interface GenericWebhookResult {
  received: true;
  executionId?: string;
  workflowId?: string;
  workflowName?: string;
  status?: string;
  sessionId?: string;
  dispatched?: boolean;
  deduplicated?: boolean;
  queued?: boolean;
  message: string;
  error?: string;
  reason?: string;
  activeUser?: number;
  activeGlobal?: number;
}

export async function handleGenericWebhook(
  env: Env,
  webhookPath: string,
  method: string,
  rawBody: string,
  headers: { [key: string]: string | undefined },
  query: Record<string, string>,
  workerOrigin: string,
): Promise<{ result: GenericWebhookResult; statusCode: number } | null> {
  const appDb = getDb(env.DB);
  // Look up trigger by webhook path
  const trigger = await db.lookupWebhookTrigger(env.DB, webhookPath);

  if (!trigger) {
    return {
      result: { received: true, message: 'Webhook not found' } as any,
      statusCode: 404,
    };
  }

  const config = JSON.parse(trigger.config as string);

  // Verify HTTP method if specified
  if (config.method && config.method !== method) {
    return {
      result: { received: true, message: `Method ${method} not allowed` } as any,
      statusCode: 405,
    };
  }

  // Verify secret/signature if configured
  if (config.secret) {
    const signature = headers['x-webhook-signature'] || headers['x-hub-signature-256'];
    if (!signature) {
      return {
        result: { received: true, message: 'Missing webhook signature' } as any,
        statusCode: 401,
      };
    }
  }

  // Parse request body
  let payload: Record<string, unknown> = {};
  try {
    if (rawBody) {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    }
  } catch {
    // Body might be empty or not JSON
  }

  // Add query params to payload
  if (Object.keys(query).length > 0) {
    payload.query = query;
  }

  // Extract variables using the trigger's variable mapping
  const variableMapping = trigger.variable_mapping
    ? JSON.parse(trigger.variable_mapping as string)
    : {};

  const extractedVariables: Record<string, unknown> = {};
  for (const [varName, pathExpr] of Object.entries(variableMapping)) {
    const pathStr = pathExpr as string;
    if (pathStr.startsWith('$.')) {
      const parts = pathStr.slice(2).split('.');
      let value: unknown = payload;
      for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }
      if (value !== undefined) {
        extractedVariables[varName] = value;
      }
    }
  }

  const variables = {
    ...extractedVariables,
    _trigger: {
      type: 'webhook',
      triggerId: trigger.id,
      path: webhookPath,
      method,
      timestamp: new Date().toISOString(),
    },
    _payload: payload,
  };

  const deliveryId = headers['x-github-delivery']
    || headers['x-request-id']
    || headers['x-webhook-id']
    || null;
  const signature = headers['x-webhook-signature']
    || headers['x-hub-signature-256']
    || '';
  const fallbackBodyHash = await sha256Hex(`${signature}:${rawBody}`);
  const idempotencyKey = `webhook:${trigger.id}:${deliveryId || fallbackBodyHash}`;

  const existing = await db.checkIdempotencyKey(env.DB, trigger.workflow_id, idempotencyKey);

  if (existing) {
    return {
      result: {
        received: true,
        deduplicated: true,
        executionId: existing.id as string,
        workflowId: trigger.workflow_id,
        workflowName: trigger.workflow_name,
        status: existing.status as string,
        sessionId: existing.session_id as string,
        message: 'Webhook received. Existing workflow execution reused.',
      },
      statusCode: 200,
    };
  }

  const concurrency = await checkWorkflowConcurrency(appDb, trigger.user_id);
  if (!concurrency.allowed) {
    return {
      result: {
        received: true,
        queued: false,
        error: 'Too many concurrent workflow executions',
        reason: concurrency.reason,
        activeUser: concurrency.activeUser,
        activeGlobal: concurrency.activeGlobal,
        message: 'Webhook received but rate limited.',
      },
      statusCode: 429,
    };
  }

  const executionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const workflowHash = await sha256Hex(String(trigger.data ?? '{}'));
  const sessionId = await createWorkflowSession(appDb, {
    userId: trigger.user_id,
    workflowId: trigger.workflow_id,
    executionId,
  });

  await db.createExecution(env.DB, {
    id: executionId,
    workflowId: trigger.workflow_id,
    userId: trigger.user_id,
    triggerId: trigger.id,
    triggerType: 'webhook',
    triggerMetadata: JSON.stringify({ path: webhookPath, method }),
    variables: JSON.stringify(variables),
    now,
    workflowVersion: trigger.version || null,
    workflowHash,
    workflowSnapshot: trigger.data,
    idempotencyKey,
    sessionId,
    initiatorType: 'webhook',
    initiatorUserId: trigger.user_id,
  });

  const dispatched = await enqueueWorkflowExecution(env, {
    executionId,
    workflowId: trigger.workflow_id,
    userId: trigger.user_id,
    sessionId,
    triggerType: 'webhook',
    workerOrigin,
  });

  await db.updateTriggerLastRun(appDb, trigger.id, now);

  return {
    result: {
      received: true,
      executionId,
      workflowId: trigger.workflow_id,
      workflowName: trigger.workflow_name,
      status: 'pending',
      sessionId,
      dispatched,
      message: dispatched
        ? 'Webhook received. Workflow execution queued and dispatched.'
        : 'Webhook received. Workflow execution queued but dispatch failed.',
    },
    statusCode: 202,
  };
}

// ─── Pull Request Webhook Handler ───────────────────────────────────────────

export async function handlePullRequestWebhook(env: Env, payload: any): Promise<void> {
  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) return;

  const repoFullName = payload.repository?.full_name;
  const prNumber = pr.number;

  if (!repoFullName || !prNumber) return;

  const appDb = getDb(env.DB);
  const rows = await db.findSessionsByPR(appDb, repoFullName, prNumber);

  if (!rows.results || rows.results.length === 0) return;

  let prState: string;
  if (pr.merged_at || action === 'closed' && pr.merged) {
    prState = 'merged';
  } else if (action === 'closed') {
    prState = 'closed';
  } else if (action === 'reopened' || action === 'opened') {
    prState = pr.draft ? 'draft' : 'open';
  } else {
    prState = pr.draft ? 'draft' : (pr.state === 'open' ? 'open' : pr.state);
  }

  for (const row of rows.results) {
    const sessionId = row.session_id;

    await db.updateSessionGitState(appDb, sessionId, {
      prState: prState as any,
      prTitle: pr.title,
      prUrl: pr.html_url,
      prMergedAt: pr.merged_at || undefined,
    });

    try {
      const doId = env.SESSIONS.idFromName(sessionId);
      const stub = env.SESSIONS.get(doId);
      await stub.fetch(new Request('https://session/webhook-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'git-state-update',
          prState,
          prTitle: pr.title,
          prUrl: pr.html_url,
          prMergedAt: pr.merged_at || null,
        }),
      }));
    } catch (err) {
      console.error(`Failed to notify DO for session ${sessionId}:`, err);
    }
  }
}

// ─── Push Webhook Handler ───────────────────────────────────────────────────

export async function handlePushWebhook(env: Env, payload: any): Promise<void> {
  const ref = payload.ref;
  const repoFullName = payload.repository?.full_name;
  const commitCount = payload.commits?.length ?? 0;

  if (!ref || !repoFullName || commitCount === 0) return;

  const branch = ref.replace('refs/heads/', '');

  const appDb = getDb(env.DB);
  const rows = await db.findSessionsByRepoBranch(appDb, repoFullName, branch);

  if (!rows.results || rows.results.length === 0) return;

  for (const row of rows.results) {
    await db.updateSessionGitState(appDb, row.session_id, {
      commitCount: row.commit_count + commitCount,
    });

    try {
      const doId = env.SESSIONS.idFromName(row.session_id);
      const stub = env.SESSIONS.get(doId);
      await stub.fetch(new Request('https://session/webhook-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'git-state-update',
          commitCount: row.commit_count + commitCount,
          branch,
        }),
      }));
    } catch (err) {
      console.error(`Failed to notify DO for session ${row.session_id}:`, err);
    }
  }
}
