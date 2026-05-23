import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { checkWorkflowConcurrency, enqueueWorkflowExecution } from './executions.js';
import { sha256Hex, createWorkflowSession } from '../lib/workflow-runtime.js';
import { recordTriggerDelivery, truncatePayloadPreview } from '../lib/db/trigger-deliveries.js';

// Best-effort logging — never let a delivery-log write break webhook handling.
async function safeRecord(
  appDb: ReturnType<typeof getDb>,
  params: Parameters<typeof recordTriggerDelivery>[1],
): Promise<void> {
  try {
    await recordTriggerDelivery(appDb, params);
  } catch (err) {
    console.error('[webhook] failed to record delivery:', err);
  }
}

/**
 * Verify an HMAC-SHA256 signature over a webhook body.
 *
 * Accepts either a bare hex digest (`abc123...`) or the GitHub-style
 * `sha256=abc123...` prefix on either side. Returns true when the supplied
 * signature matches `HMAC-SHA256(secret, body)`.
 *
 * We use plain string equality rather than a constant-time compare. Timing
 * attacks against HMAC verification are not practically exploitable on
 * Cloudflare Workers (request scheduling, isolate jitter, and the global
 * front-door queue all add far more noise than a single hex compare leaks),
 * and the V8 engine doesn't expose a primitive that's reliably constant-time
 * anyway.
 */
async function verifyHmacSha256(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const provided = signature.startsWith('sha256=') ? signature : 'sha256=' + signature;
  return provided === expected;
}

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
  options: { skipSecretCheck?: boolean; testFire?: boolean } = {},
): Promise<{ result: GenericWebhookResult; statusCode: number } | null> {
  const appDb = getDb(env.DB);
  // Look up trigger by webhook path
  const trigger = await db.lookupWebhookTrigger(env.DB, webhookPath);

  if (!trigger) {
    return {
      result: { received: true, message: 'Webhook not found' },
      statusCode: 404,
    };
  }

  const config = JSON.parse(trigger.config as string);

  // Verify HTTP method if specified
  if (config.method && config.method !== method) {
    await safeRecord(appDb, {
      triggerId: trigger.id,
      userId: trigger.user_id,
      eventType: webhookPath,
      deliveryId: headers['x-github-delivery'] || headers['x-request-id'] || headers['x-webhook-id'] || null,
      outcome: 'no_match',
      reason: `Method ${method} not allowed (expected ${config.method})`,
      payloadPreview: truncatePayloadPreview(rawBody, 'no_match'),
    });
    return {
      result: { received: true, message: `Method ${method} not allowed` },
      statusCode: 405,
    };
  }

  // Verify secret/signature if configured. The test-fire path passes
  // `skipSecretCheck: true` so synthetic deliveries don't require a real HMAC.
  if (config.secret && !options.skipSecretCheck) {
    const signature = headers['x-webhook-signature'] || headers['x-hub-signature-256'];
    if (!signature) {
      await safeRecord(appDb, {
        triggerId: trigger.id,
        userId: trigger.user_id,
        eventType: webhookPath,
        deliveryId: headers['x-github-delivery'] || headers['x-request-id'] || headers['x-webhook-id'] || null,
        outcome: 'no_match',
        reason: 'Missing webhook signature',
        payloadPreview: truncatePayloadPreview(rawBody, 'no_match'),
      });
      return {
        result: { received: true, message: 'Missing webhook signature', error: 'invalid signature' },
        statusCode: 401,
      };
    }

    const valid = await verifyHmacSha256(config.secret as string, rawBody, signature);
    if (!valid) {
      await safeRecord(appDb, {
        triggerId: trigger.id,
        userId: trigger.user_id,
        eventType: webhookPath,
        deliveryId: headers['x-github-delivery'] || headers['x-request-id'] || headers['x-webhook-id'] || null,
        outcome: 'no_match',
        reason: 'invalid signature',
        payloadPreview: truncatePayloadPreview(rawBody, 'no_match'),
      });
      return {
        result: { received: true, message: 'Invalid webhook signature', error: 'invalid signature' },
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
  // Test-fire deliveries use a `test:` prefix so synthetic runs never collide with real-run keys.
  const idempotencyKey = options.testFire
    ? `test:${trigger.id}:${deliveryId || fallbackBodyHash}`
    : `webhook:${trigger.id}:${deliveryId || fallbackBodyHash}`;

  const existing = await db.checkIdempotencyKey(env.DB, trigger.workflow_id, idempotencyKey);
  // Precompute both caps once. Matched gets 8KB; everything else gets 512B.
  // A single webhook delivery only ever produces one row, so this is cheap.
  const matchedPreview = truncatePayloadPreview(payload, 'matched');
  const nonMatchedPreview = truncatePayloadPreview(payload, 'no_match');

  if (existing) {
    const existingId = typeof existing.id === 'string' ? existing.id : null;
    await safeRecord(appDb, {
      triggerId: trigger.id,
      userId: trigger.user_id,
      eventType: webhookPath,
      deliveryId,
      outcome: 'duplicate',
      executionId: existingId,
      reason: `Idempotency key already exists: ${idempotencyKey}`,
      payloadPreview: nonMatchedPreview,
    });
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
    await safeRecord(appDb, {
      triggerId: trigger.id,
      userId: trigger.user_id,
      eventType: webhookPath,
      deliveryId,
      outcome: 'concurrency_cap',
      reason: `${concurrency.reason ?? 'concurrency limit'} (activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`,
      payloadPreview: nonMatchedPreview,
    });
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

  const triggerMetadata: Record<string, unknown> = { path: webhookPath, method };
  if (options.testFire) {
    // Preserve original kind so the UI can distinguish a test-fired webhook from
    // a test-fired schedule even though both record as trigger_type='test'.
    triggerMetadata.originalTriggerType = 'webhook';
    triggerMetadata.testFire = true;
  }

  try {
    await db.createExecution(env.DB, {
      id: executionId,
      workflowId: trigger.workflow_id,
      userId: trigger.user_id,
      triggerId: trigger.id,
      // Test-fires write `'test'` so they don't count against concurrency or
      // pollute the default listExecutions view.
      triggerType: options.testFire ? 'test' : 'webhook',
      triggerMetadata: JSON.stringify(triggerMetadata),
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
  } catch (err) {
    // Two concurrent webhook deliveries can race past `checkIdempotencyKey`.
    // The UNIQUE(workflow_id, idempotency_key) constraint catches it here; surface
    // as a duplicate (200) instead of bubbling a 500 that would trigger upstream
    // retry storms.
    if (db.isUniqueConstraintError(err)) {
      await safeRecord(appDb, {
        triggerId: trigger.id,
        userId: trigger.user_id,
        eventType: webhookPath,
        deliveryId,
        outcome: 'duplicate',
        executionId: null,
        reason: 'concurrent duplicate',
        payloadPreview: nonMatchedPreview,
      });
      return {
        result: {
          received: true,
          deduplicated: true,
          workflowId: trigger.workflow_id,
          workflowName: trigger.workflow_name,
          message: 'Webhook received. Duplicate delivery deduplicated.',
        },
        statusCode: 200,
      };
    }
    throw err;
  }

  const dispatched = await enqueueWorkflowExecution(env, {
    executionId,
    workflowId: trigger.workflow_id,
    userId: trigger.user_id,
    sessionId,
    triggerType: options.testFire ? 'test' : 'webhook',
    workerOrigin,
  });

  await db.updateTriggerLastRun(appDb, trigger.id, now);

  await safeRecord(appDb, {
    triggerId: trigger.id,
    userId: trigger.user_id,
    eventType: webhookPath,
    deliveryId,
    outcome: 'matched',
    executionId,
    reason: dispatched ? null : 'Execution created but dispatch enqueue failed',
    payloadPreview: matchedPreview,
  });

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
