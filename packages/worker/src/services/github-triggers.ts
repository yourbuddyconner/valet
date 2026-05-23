import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { checkWorkflowConcurrency, enqueueWorkflowExecution } from './executions.js';
import { sha256Hex, createWorkflowSession } from '../lib/workflow-runtime.js';
import { getGithubInstallationById } from '../lib/db/github-installations.js';
import {
  recordTriggerDelivery,
  recordTriggerDeliveriesBulk,
  truncatePayloadPreview,
  type RecordTriggerDeliveryParams,
} from '../lib/db/trigger-deliveries.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GitHubTriggerRow {
  id: string;
  user_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  workflow_version: string | null;
  workflow_data: string | null;
  variable_mapping: string | null;
  config: string;
}

interface GitHubTriggerConfig {
  type: 'github';
  repos: string[];
  events: string[];
  filter?: {
    branch?: string | string[];
    labels?: string[];
    actions?: string[];
  };
}

interface GitHubWebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: { base?: { ref?: string }; head?: { ref?: string }; labels?: Array<{ name?: string }> };
  ref?: string;
  installation?: { id?: number };
  // Additional fields are passed through verbatim to the workflow as _payload.
  [key: string]: unknown;
}

export interface GitHubDispatchSummary {
  matched: number;
  dispatched: number;
}

// ─── Event Matching ─────────────────────────────────────────────────────────

/**
 * Matches a GitHub delivery event against a trigger's configured events list.
 * Supports two forms:
 *   - bare event name: 'pull_request' matches any pull_request.*
 *   - event.action:    'pull_request.opened' matches only that action
 */
export function eventMatches(eventType: string, action: string | undefined, configured: string[]): boolean {
  for (const entry of configured) {
    if (entry === eventType) return true;
    if (action && entry === `${eventType}.${action}`) return true;
  }
  return false;
}

/**
 * Applies the trigger's optional filters. All present filters must pass.
 * - filter.actions: payload.action must be one of these
 * - filter.branch:  for push, matches payload.ref (refs/heads/X);
 *                   for pull_request, matches payload.pull_request.base.ref
 * - filter.labels:  for pull_request, any configured label must be present on the PR
 */
export function filterMatches(
  payload: GitHubWebhookPayload,
  eventType: string,
  config: GitHubTriggerConfig,
): boolean {
  const filter = config.filter;
  if (!filter) return true;

  if (filter.actions && filter.actions.length > 0) {
    if (!payload.action || !filter.actions.includes(payload.action)) return false;
  }

  if (filter.branch) {
    const wanted = Array.isArray(filter.branch) ? filter.branch : [filter.branch];
    let actual: string | undefined;
    if (eventType === 'push' && typeof payload.ref === 'string') {
      actual = payload.ref.replace(/^refs\/heads\//, '');
    } else if (eventType === 'pull_request' && payload.pull_request?.base?.ref) {
      actual = payload.pull_request.base.ref;
    }
    if (!actual || !wanted.includes(actual)) return false;
  }

  if (filter.labels && filter.labels.length > 0) {
    const prLabels = payload.pull_request?.labels;
    if (!Array.isArray(prLabels)) return false;
    const names = prLabels.map((l) => l?.name).filter((n): n is string => typeof n === 'string');
    const overlap = filter.labels.some((wanted) => names.includes(wanted));
    if (!overlap) return false;
  }

  return true;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Find and dispatch all user-defined `github` triggers matching this delivery.
 * Scopes candidate triggers by the owning user(s) of the installation — we don't
 * fan out to every github trigger in the DB on every webhook.
 */
export async function dispatchGitHubTriggers(
  env: Env,
  payload: GitHubWebhookPayload,
  eventType: string,
  deliveryId: string,
  workerOrigin: string,
  options: { testFire?: boolean } = {},
): Promise<GitHubDispatchSummary> {
  const summary: GitHubDispatchSummary = { matched: 0, dispatched: 0 };

  const repoFullName = typeof payload.repository?.full_name === 'string'
    ? payload.repository.full_name
    : null;
  if (!repoFullName) {
    // Some events (e.g. installation lifecycle) carry no repository — nothing to match.
    return summary;
  }

  const installationId = payload.installation?.id;
  if (installationId === undefined || installationId === null) {
    // No installation context means we can't scope to a user safely.
    return summary;
  }

  const appDb = getDb(env.DB);
  const installation = await getGithubInstallationById(appDb, String(installationId));
  if (!installation || !installation.linkedUserId) {
    // Org installations without an owning valet user, or unknown installs — skip.
    return summary;
  }

  const userId = installation.linkedUserId;
  const action = typeof payload.action === 'string' ? payload.action : undefined;
  const fullEventType = action ? `${eventType}.${action}` : eventType;
  // Precompute both caps once: matched rows get the generous slice, the
  // hot-path no_match rows get the small slice. Computing both up front
  // avoids re-serializing per candidate.
  const matchedPreview = truncatePayloadPreview(payload, 'matched');
  const noMatchPreview = truncatePayloadPreview(payload, 'no_match');

  const candidates = await env.DB.prepare(`
    SELECT t.id, t.user_id, t.workflow_id, t.config, t.variable_mapping,
           w.name as workflow_name, w.version as workflow_version, w.data as workflow_data
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.type = 'github' AND t.enabled = 1 AND t.user_id = ?
  `).bind(userId).all<GitHubTriggerRow>();

  // Deferred no_match writes are collapsed into a single D1 batch at the
  // bottom of the function — a user with N github triggers gets one round
  // trip instead of N. Rare outcomes (matched/error/etc.) still write
  // synchronously since there's usually <5 of those per delivery.
  const deferredNoMatches: RecordTriggerDeliveryParams[] = [];

  try {
    for (const row of candidates.results ?? []) {
      let config: GitHubTriggerConfig;
      try {
        config = JSON.parse(row.config) as GitHubTriggerConfig;
      } catch {
        await safeRecord(appDb, {
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: 'error',
          reason: 'Invalid trigger config JSON',
          payloadPreview: truncatePayloadPreview(payload, 'error'),
        });
        continue;
      }

      // Per-trigger no-match logging: we only log when this trigger was actually
      // evaluated (i.e. it's one of the user's github triggers). Logging from the
      // top-level handler instead would flood the table for users with no
      // configured triggers at all.
      if (!Array.isArray(config.repos) || !config.repos.includes(repoFullName)) {
        deferredNoMatches.push({
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: 'no_match',
          reason: `repo "${repoFullName}" not in trigger.repos`,
          payloadPreview: noMatchPreview,
        });
        continue;
      }
      if (!eventMatches(eventType, action, config.events)) {
        deferredNoMatches.push({
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: 'no_match',
          reason: `event "${fullEventType}" not in trigger.events`,
          payloadPreview: noMatchPreview,
        });
        continue;
      }
      if (!filterMatches(payload, eventType, config)) {
        deferredNoMatches.push({
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: 'no_match',
          reason: 'filter conditions did not match',
          payloadPreview: noMatchPreview,
        });
        continue;
      }

      summary.matched += 1;

      if (!row.workflow_id || !row.workflow_data) {
        // github triggers require a workflow per validator, but be defensive at the boundary.
        await safeRecord(appDb, {
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: 'workflow_deleted',
          reason: 'Trigger has no linked workflow or workflow data is missing',
          payloadPreview: truncatePayloadPreview(payload, 'workflow_deleted'),
        });
        continue;
      }

      try {
        const result = await dispatchOne(env, appDb, row, payload, eventType, deliveryId, workerOrigin, options.testFire ?? false);
        if (result.dispatched) summary.dispatched += 1;
        await safeRecord(appDb, {
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: result.outcome,
          executionId: result.executionId,
          reason: result.reason,
          payloadPreview: result.outcome === 'matched' ? matchedPreview : truncatePayloadPreview(payload, result.outcome),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await safeRecord(appDb, {
          triggerId: row.id,
          userId: row.user_id,
          eventType: fullEventType,
          deliveryId,
          outcome: 'error',
          reason: message,
          payloadPreview: truncatePayloadPreview(payload, 'error'),
        });
        throw err;
      }
    }
  } finally {
    // Flush deferred no_match writes even on a thrown error: losing the log
    // rows would make the dispatch unattributable from the deliveries panel.
    if (deferredNoMatches.length > 0) {
      try {
        await recordTriggerDeliveriesBulk(env.DB, deferredNoMatches);
      } catch (err) {
        console.error('[github trigger] failed to bulk-record no_match deliveries:', err);
      }
    }
  }

  return summary;
}

// Best-effort logging — never let a delivery-log write break dispatch.
async function safeRecord(
  appDb: ReturnType<typeof getDb>,
  params: Parameters<typeof recordTriggerDelivery>[1],
): Promise<void> {
  try {
    await recordTriggerDelivery(appDb, params);
  } catch (err) {
    console.error('[github trigger] failed to record delivery:', err);
  }
}

interface DispatchOneResult {
  outcome: 'matched' | 'duplicate' | 'concurrency_cap' | 'error';
  dispatched: boolean;
  executionId: string | null;
  reason: string | null;
}

async function dispatchOne(
  env: Env,
  appDb: ReturnType<typeof getDb>,
  row: GitHubTriggerRow,
  payload: GitHubWebhookPayload,
  eventType: string,
  deliveryId: string,
  workerOrigin: string,
  testFire: boolean,
): Promise<DispatchOneResult> {
  // github triggers require a workflow per validator; defensive at this boundary.
  if (!row.workflow_id || !row.workflow_data) {
    return { outcome: 'error', dispatched: false, executionId: null, reason: 'Missing workflow' };
  }
  const workflowId = row.workflow_id;
  const workflowData = row.workflow_data;

  // Idempotency: GitHub delivery IDs are globally unique per webhook delivery.
  // Test-fires use a `test:` prefix so synthetic runs never collide with real-run keys.
  const idempotencyKey = testFire
    ? `test:${row.id}:${deliveryId}`
    : `github:${row.id}:${deliveryId}`;
  const existing = await db.checkIdempotencyKey(env.DB, workflowId, idempotencyKey);
  if (existing) {
    const existingId = typeof existing.id === 'string' ? existing.id : null;
    return {
      outcome: 'duplicate',
      dispatched: false,
      executionId: existingId,
      reason: `Idempotency key already exists: ${idempotencyKey}`,
    };
  }

  const concurrency = await checkWorkflowConcurrency(appDb, row.user_id);
  if (!concurrency.allowed) {
    console.warn(
      `[github trigger] skipping ${row.id}: ${concurrency.reason} ` +
      `(activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`,
    );
    return {
      outcome: 'concurrency_cap',
      dispatched: false,
      executionId: null,
      reason: `${concurrency.reason ?? 'concurrency limit'} (activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`,
    };
  }

  // Extract variables via the trigger's variable_mapping (same JSONPath subset as webhooks).
  const variableMapping = row.variable_mapping ? JSON.parse(row.variable_mapping) : {};
  const extracted: Record<string, unknown> = {};
  for (const [varName, pathExpr] of Object.entries(variableMapping)) {
    if (typeof pathExpr !== 'string' || !pathExpr.startsWith('$.')) continue;
    const parts = pathExpr.slice(2).split('.');
    let value: unknown = payload;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined) extracted[varName] = value;
  }

  const variables = {
    ...extracted,
    _trigger: {
      type: 'github',
      triggerId: row.id,
      eventType,
      action: payload.action,
      deliveryId,
      repo: payload.repository?.full_name,
      timestamp: new Date().toISOString(),
    },
    _payload: payload,
  };

  const executionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const workflowHash = await sha256Hex(workflowData);
  const sessionId = await createWorkflowSession(appDb, {
    userId: row.user_id,
    workflowId,
    executionId,
  });

  const triggerMetadata: Record<string, unknown> = {
    eventType,
    action: payload.action,
    deliveryId,
    repo: payload.repository?.full_name,
  };
  if (testFire) {
    // Preserve the underlying type so the UI can surface the original kind even
    // though the execution itself is bucketed as `'test'`.
    triggerMetadata.originalTriggerType = 'github';
    triggerMetadata.testFire = true;
  }

  try {
    await db.createExecution(env.DB, {
      id: executionId,
      workflowId,
      userId: row.user_id,
      triggerId: row.id,
      // Test-fires write `'test'` so they don't count against concurrency or
      // pollute the default listExecutions view (filters trigger_type != 'test').
      triggerType: testFire ? 'test' : 'github',
      triggerMetadata: JSON.stringify(triggerMetadata),
      variables: JSON.stringify(variables),
      now,
      workflowVersion: row.workflow_version || null,
      workflowHash,
      workflowSnapshot: workflowData,
      idempotencyKey,
      sessionId,
      initiatorType: 'github',
      initiatorUserId: row.user_id,
    });
  } catch (err) {
    // Two concurrent deliveries can race past `checkIdempotencyKey` and both
    // try to INSERT. The UNIQUE(workflow_id, idempotency_key) constraint
    // catches it here; treat as a duplicate rather than a 500 (which would
    // make GitHub retry and amplify the problem).
    if (db.isUniqueConstraintError(err)) {
      return {
        outcome: 'duplicate',
        dispatched: false,
        executionId: null,
        reason: 'concurrent duplicate',
      };
    }
    throw err;
  }

  await db.updateTriggerLastRun(appDb, row.id, now);

  const ok = await enqueueWorkflowExecution(env, {
    executionId,
    workflowId,
    userId: row.user_id,
    sessionId,
    triggerType: testFire ? 'test' : 'github',
    workerOrigin,
  });
  return {
    outcome: 'matched',
    dispatched: ok,
    executionId,
    reason: ok ? null : 'Execution created but dispatch enqueue failed',
  };
}
