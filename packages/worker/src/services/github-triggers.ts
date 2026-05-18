import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { checkWorkflowConcurrency, enqueueWorkflowExecution } from './executions.js';
import { sha256Hex, createWorkflowSession } from '../lib/workflow-runtime.js';
import { getGithubInstallationById } from '../lib/db/github-installations.js';

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

  const candidates = await env.DB.prepare(`
    SELECT t.id, t.user_id, t.workflow_id, t.config, t.variable_mapping,
           w.name as workflow_name, w.version as workflow_version, w.data as workflow_data
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.type = 'github' AND t.enabled = 1 AND t.user_id = ?
  `).bind(userId).all<GitHubTriggerRow>();

  for (const row of candidates.results ?? []) {
    let config: GitHubTriggerConfig;
    try {
      config = JSON.parse(row.config) as GitHubTriggerConfig;
    } catch {
      continue;
    }

    if (!Array.isArray(config.repos) || !config.repos.includes(repoFullName)) continue;
    if (!eventMatches(eventType, action, config.events)) continue;
    if (!filterMatches(payload, eventType, config)) continue;

    summary.matched += 1;

    if (!row.workflow_id || !row.workflow_data) {
      // github triggers require a workflow per validator, but be defensive at the boundary.
      continue;
    }

    const dispatched = await dispatchOne(env, appDb, row, payload, eventType, deliveryId, workerOrigin);
    if (dispatched) summary.dispatched += 1;
  }

  return summary;
}

async function dispatchOne(
  env: Env,
  appDb: ReturnType<typeof getDb>,
  row: GitHubTriggerRow,
  payload: GitHubWebhookPayload,
  eventType: string,
  deliveryId: string,
  workerOrigin: string,
): Promise<boolean> {
  // github triggers require a workflow per validator; defensive at this boundary.
  if (!row.workflow_id || !row.workflow_data) return false;
  const workflowId = row.workflow_id;
  const workflowData = row.workflow_data;

  // Idempotency: GitHub delivery IDs are globally unique per webhook delivery.
  const idempotencyKey = `github:${row.id}:${deliveryId}`;
  const existing = await db.checkIdempotencyKey(env.DB, workflowId, idempotencyKey);
  if (existing) return false;

  const concurrency = await checkWorkflowConcurrency(appDb, row.user_id);
  if (!concurrency.allowed) {
    console.warn(
      `[github trigger] skipping ${row.id}: ${concurrency.reason} ` +
      `(activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`,
    );
    return false;
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

  await db.createExecution(env.DB, {
    id: executionId,
    workflowId,
    userId: row.user_id,
    triggerId: row.id,
    triggerType: 'github',
    triggerMetadata: JSON.stringify({ eventType, action: payload.action, deliveryId, repo: payload.repository?.full_name }),
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

  await db.updateTriggerLastRun(appDb, row.id, now);

  const ok = await enqueueWorkflowExecution(env, {
    executionId,
    workflowId,
    userId: row.user_id,
    sessionId,
    triggerType: 'github',
    workerOrigin,
  });
  return ok;
}
