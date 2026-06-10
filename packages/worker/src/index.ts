import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';

import type { Env, Variables } from './env.js';
import { errorHandler } from './middleware/error-handler.js';
import { authMiddleware } from './middleware/auth.js';
import { dbMiddleware } from './middleware/db.js';
import { requestTelemetry } from './middleware/request-telemetry.js';

import { sessionsRouter } from './routes/sessions.js';
import { integrationsRouter } from './routes/integrations.js';
import { filesRouter } from './routes/files.js';
import { webhooksRouter } from './routes/webhooks.js';
import { agentRouter } from './routes/agent.js';
import { authRouter } from './routes/auth.js';
import { oauthRouter } from './routes/oauth.js';
import { ogRouter } from './routes/og.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { workflowsRouter } from './routes/workflows.js';
import { triggersRouter } from './routes/triggers.js';
import { executionsRouter } from './routes/executions.js';
import { eventsRouter } from './routes/events.js';
import { reposRouter } from './routes/repos.js';
import { dashboardRouter } from './routes/dashboard.js';
import { adminRouter } from './routes/admin.js';
import { invitesRouter, invitesApiRouter } from './routes/invites.js';
import { orgReposAdminRouter, orgReposReadRouter } from './routes/org-repos.js';
import { personasRouter } from './routes/personas.js';
import { orchestratorRouter } from './routes/orchestrator.js';
import { tasksRouter } from './routes/tasks.js';
import { threadsRouter } from './routes/threads.js';
import { notificationQueueRouter } from './routes/mailbox.js';
import { channelsRouter } from './routes/channels.js';
import { telegramApiRouter } from './routes/telegram.js';
import { slackAdminRouter, slackUserRouter } from './routes/slack.js';
import { adminGitHubRouter, githubAppSetupCallbackRouter } from './routes/admin-github.js';
import { slackEventsRouter } from './routes/slack-events.js';
import { channelWebhooksRouter } from './routes/channel-webhooks.js';
import { actionPoliciesRouter } from './routes/action-policies.js';
import { actionPolicyOverridesRouter } from './routes/action-policy-overrides.js';
import { disabledActionsRouter } from './routes/disabled-actions.js';
import { actionInvocationsRouter } from './routes/action-invocations.js';
import { usageRouter } from './routes/usage.js';
import { analyticsRouter } from './routes/analytics.js';
import { pluginsRouter } from './routes/plugins.js';
import { skillsRouter } from './routes/skills.js';
import { orgDefaultSkillsRouter } from './routes/org-default-skills.js';
import { avatarsRouter } from './routes/avatars.js';
import { repoProviderRouter } from './routes/repo-providers.js';
import { githubMeRouter } from './routes/github-me.js';
import { githubAuthRouter } from './routes/github-auth.js';
import { adminMcpConnectorsRouter } from './routes/admin-mcp-connectors.js';
import {
  enqueueWorkflowApprovalNotificationIfMissing,
  markWorkflowApprovalNotificationsRead,
  updateSessionGitState,
  getTimedOutApprovals,
  finalizeExecution,
  getStaleWorkflowExecutions,
  persistStepTrace,
  getActiveScheduleTriggers,
  insertScheduleTick,
  updateTriggerLastRun,
  type TriggerConfig,
  getArchivableSessions,
  markSessionsArchived,
  getTrackedGitHubResources,
  pruneEmptyJournals,
} from './lib/db.js';
import { getCredential } from './services/credentials.js';
import { getDb } from './lib/drizzle.js';
import {
  checkWorkflowConcurrency,
  createWorkflowSession,
  dispatchOrchestratorPrompt,
  enqueueWorkflowExecution,
  sha256Hex,
} from './lib/workflow-runtime.js';
import { syncPluginsOnce } from './services/plugin-sync.js';
import { matchesCronField, getZonedDateParts, cronMatchesNow, findMissedCronTicks } from './lib/cron.js';

// Durable Object exports
export { SessionAgentDO } from './durable-objects/session-agent.js';
export { EventBusDO } from './durable-objects/event-bus.js';
export { WorkflowExecutorDO } from './durable-objects/workflow-executor.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use('*', requestId());
// Capture API request latency. Registered early so it wraps the full pipeline
// (auth, db, handler); records fire-and-forget so it adds no response latency.
app.use('*', requestTelemetry);
app.use('*', dbMiddleware);
app.use('*', logger());
app.use('*', async (c, next) => {
  // Skip secureHeaders for avatar serving — needs cross-origin access for <img> loads
  if (c.req.path.startsWith('/avatars/')) return next();
  return secureHeaders()(c, next);
});
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const frontendUrl = (c.env as Env).FRONTEND_URL;
      const allowed = [frontendUrl, 'http://localhost:5173', 'http://localhost:4173'].filter(Boolean);
      if (allowed.includes(origin)) return origin;
      // Allow Cloudflare Pages preview deployments (e.g. abc123.my-valet.pages.dev)
      if (frontendUrl) {
        const pagesHost = new URL(frontendUrl).hostname; // my-valet.pages.dev
        if (origin.endsWith(`.${pagesHost}`) && origin.startsWith('https://')) return origin;
      }
      return '';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
  })
);

// Error handling
app.onError(errorHandler);

// Sync plugin registry to D1 on cold start. Runs in the background via
// ctx.waitUntil so requests never block on it — the registry is idempotent
// and slightly stale content for one request is acceptable.
//
// Skip entirely for public latency-critical paths so cold isolates serving
// the login screen / health checks / OAuth redirects don't even spin up
// the work alongside them.
const PLUGIN_SYNC_SKIP_PREFIXES = ['/auth', '/health'];
app.use('*', async (c, next) => {
  const path = c.req.path;
  const skip = PLUGIN_SYNC_SKIP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  if (!skip) {
    c.executionCtx.waitUntil(
      syncPluginsOnce(c.env.DB).catch((err) => {
        console.error('[plugin-sync] Sync failed, continuing:', err);
      }),
    );
  }
  return next();
});

// Health check (no auth required)
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook routes (authenticated via webhook signatures)
app.route('/webhooks', webhooksRouter);

// Unified GitHub auth router (login + link via GitHub App OAuth)
// Must be mounted before both the legacy callback router and the generic /auth router
app.route('/auth/github', githubAuthRouter);

// OAuth routes (no auth required — handles login flow)
app.route('/auth', oauthRouter);

// OG meta/image routes (public, no auth required)
app.route('/og', ogRouter);

// Public invite validation (no auth required)
app.route('/invites', invitesRouter);

// Avatar serving (public, no auth — external services like Slack need to render these)
app.route('/avatars', avatarsRouter);

// Channel webhooks (unauthenticated — platforms send updates here)
app.route('/channels', channelWebhooksRouter);
app.route('/channels', slackEventsRouter);

// GitHub App manifest callback (unauthenticated — GitHub redirects here after app creation)
app.route('/github', githubAppSetupCallbackRouter);

// Protected API routes
app.use('/api/*', authMiddleware);
app.route('/api/auth', authRouter);
app.route('/api/api-keys', apiKeysRouter);
app.route('/api/sessions', sessionsRouter);
app.route('/api/integrations', integrationsRouter);
app.route('/api/files', filesRouter);
app.route('/api/workflows', workflowsRouter);
app.route('/api/triggers', triggersRouter);
app.route('/api/executions', executionsRouter);
app.route('/api/events', eventsRouter);
app.route('/api/repos', reposRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/admin', adminRouter);
app.route('/api/admin/repos', orgReposAdminRouter);
app.route('/api/repos/org', orgReposReadRouter);
app.route('/api/personas', personasRouter);
app.route('/api/me', orchestratorRouter);
app.route('/api/sessions', tasksRouter);
app.route('/api/sessions', threadsRouter);
app.route('/api', notificationQueueRouter);
app.route('/api', channelsRouter);
app.route('/api/me/telegram', telegramApiRouter);
app.route('/api/admin/slack', slackAdminRouter);
app.route('/api/admin/github', adminGitHubRouter);
app.route('/api/admin/mcp-connectors', adminMcpConnectorsRouter);
app.route('/api/admin/action-policies', actionPoliciesRouter);
app.route('/api/action-policy-overrides', actionPolicyOverridesRouter);
app.route('/api/admin/disabled-actions', disabledActionsRouter);
app.route('/api/admin/default-skills', orgDefaultSkillsRouter);
app.route('/api/action-invocations', actionInvocationsRouter);
app.route('/api/me/slack', slackUserRouter);
app.route('/api/me/github', githubMeRouter);
app.route('/api/invites', invitesApiRouter);
app.route('/api/usage', usageRouter);
app.route('/api/analytics', analyticsRouter);
app.route('/api/plugins', pluginsRouter);
app.route('/api/skills', skillsRouter);
app.route('/api/repo-providers', repoProviderRouter);

// Agent container proxy (protected)
app.use('/agent/*', authMiddleware);
app.route('/agent', agentRouter);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
});

// Scheduled handler for cron triggers
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env, ctx) => {
  console.log('Running scheduled handler:', event.cron);

  try {
    await reconcileWorkflowExecutions(env);
  } catch (error) {
    console.error('Workflow execution reconcile error:', error);
  }

  try {
    await dispatchScheduledWorkflows(event, env);
  } catch (error) {
    console.error('Scheduled workflow dispatch error:', error);
  }

  try {
    await reconcileGitHubResources(env);
  } catch (error) {
    console.error('GitHub reconciliation error:', error);
  }

  // Nightly: archive terminated sessions older than 7 days + prune empty journals
  if (event.cron === '0 3 * * *') {
    try {
      await archiveTerminatedSessions(env);
    } catch (error) {
      console.error('Session archive error:', error);
    }

    try {
      const pruned = await pruneEmptyJournals(env.DB);
      if (pruned > 0) {
        console.log(`Pruned ${pruned} empty journal stubs`);
      }
    } catch (error) {
      console.error('Journal prune error:', error);
    }

    // Delete analytics events older than 90 days (batched to avoid D1 timeout)
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      let totalDeleted = 0;
      let deleted: number;
      do {
        const result = await env.DB.prepare(
          'DELETE FROM analytics_events WHERE id IN (SELECT id FROM analytics_events WHERE created_at < ? LIMIT 1000)'
        ).bind(cutoff).run();
        deleted = result.meta.changes ?? 0;
        totalDeleted += deleted;
      } while (deleted >= 1000);
      if (totalDeleted > 0) {
        console.log(`Analytics retention: deleted ${totalDeleted} events older than 90 days`);
      }
    } catch (error) {
      console.error('Analytics retention error:', error);
    }

    // Delete request metrics older than 90 days (batched to avoid D1 timeout)
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      let totalDeleted = 0;
      let deleted: number;
      do {
        const result = await env.DB.prepare(
          'DELETE FROM request_metrics WHERE id IN (SELECT id FROM request_metrics WHERE created_at < ? LIMIT 1000)'
        ).bind(cutoff).run();
        deleted = result.meta.changes ?? 0;
        totalDeleted += deleted;
      } while (deleted >= 1000);
      if (totalDeleted > 0) {
        console.log(`Request metrics retention: deleted ${totalDeleted} rows older than 90 days`);
      }
    } catch (error) {
      console.error('Request metrics retention error:', error);
    }

    // Prune schedule tick dedup rows older than 7 days (only needed for ~4h catch-up window, batched to avoid D1 timeout)
    try {
      const tickCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      let totalTicksDeleted = 0;
      let ticksDeleted: number;
      do {
        const tickResult = await env.DB.prepare(
          'DELETE FROM workflow_schedule_ticks WHERE id IN (SELECT id FROM workflow_schedule_ticks WHERE created_at < ? LIMIT 1000)'
        ).bind(tickCutoff).run();
        ticksDeleted = tickResult.meta.changes ?? 0;
        totalTicksDeleted += ticksDeleted;
      } while (ticksDeleted >= 1000);
      if (totalTicksDeleted > 0) {
        console.log(`Schedule tick retention: deleted ${totalTicksDeleted} rows older than 7 days`);
      }
    } catch (error) {
      console.error('Schedule tick retention error:', error);
    }
  }

  // Reconcile orchestrator state (replaces autoRestartDeadOrchestrators)
  try {
    await reconcileOrchestrators(env);
  } catch (error) {
    console.error('[OrchestratorReconcile] Reconciliation error:', error);
  }

  // Proactively refresh OAuth credentials expiring within 15 minutes (runs every 5 min)
  if (new Date().getMinutes() % 5 === 0) {
    try {
      const { refreshExpiringCredentials } = await import('./services/credentials.js');
      const result = await refreshExpiringCredentials(env);
      if (result.refreshed > 0 || result.failed > 0) {
        console.log(`Credential refresh sweep: ${result.refreshed} refreshed, ${result.failed} failed`);
      }
    } catch (error) {
      console.error('Credential refresh sweep error:', error);
    }
  }
};

const MAX_GITHUB_RESOURCES_PER_RUN = 100;
const LIVE_NOTIFY_SESSION_STATUSES = new Set(['initializing', 'running', 'idle', 'restoring', 'hibernating']);

interface TrackedGitHubResource {
  owner: string;
  repo: string;
  prNumber: number;
  links: Array<{
    sessionId: string;
    userId: string;
    sessionStatus: string;
    prState: string | null;
    prTitle: string | null;
    prUrl: string | null;
    prMergedAt: string | null;
  }>;
}

function extractOwnerRepoFromGitState(sourceRepoFullName: string | null, sourceRepoUrl: string | null): {
  owner: string;
  repo: string;
} | null {
  if (sourceRepoFullName) {
    const [owner, repo] = sourceRepoFullName.split('/');
    if (owner && repo) return { owner, repo };
  }
  if (sourceRepoUrl) {
    const match = sourceRepoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

function mapGitHubPullRequestState(
  state: string | undefined,
  draft: boolean,
  mergedAt: string | null | undefined,
): 'draft' | 'open' | 'closed' | 'merged' | null {
  if (mergedAt) return 'merged';
  if (state === 'open') return draft ? 'draft' : 'open';
  if (state === 'closed') return 'closed';
  return null;
}

async function reconcileGitHubResources(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const rows = await getTrackedGitHubResources(env.DB);
  if (rows.length === 0) return;

  const resourceMap = new Map<string, TrackedGitHubResource>();
  for (const row of rows) {
    const ownerRepo = extractOwnerRepoFromGitState(row.source_repo_full_name, row.source_repo_url);
    if (!ownerRepo) continue;

    const prNumber = typeof row.tracked_pr_number === 'number'
      ? row.tracked_pr_number
      : Number.parseInt(String(row.tracked_pr_number), 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;

    const key = `${ownerRepo.owner}/${ownerRepo.repo}#${prNumber}`;
    const existing = resourceMap.get(key);
    const link = {
      sessionId: row.session_id,
      userId: row.user_id,
      sessionStatus: row.session_status,
      prState: row.pr_state,
      prTitle: row.pr_title,
      prUrl: row.pr_url,
      prMergedAt: row.pr_merged_at,
    };

    if (existing) {
      existing.links.push(link);
    } else {
      resourceMap.set(key, {
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        prNumber,
        links: [link],
      });
    }
  }

  const resources = Array.from(resourceMap.values()).slice(0, MAX_GITHUB_RESOURCES_PER_RUN);
  if (resources.length === 0) return;

  const tokenCache = new Map<string, string | null>();
  const getTokenForUser = async (userId: string): Promise<string | null> => {
    if (tokenCache.has(userId)) return tokenCache.get(userId) ?? null;
    try {
      const result = await getCredential(env, 'user', userId, 'github');
      if (!result.ok) {
        tokenCache.set(userId, null);
        return null;
      }
      tokenCache.set(userId, result.credential.accessToken);
      return result.credential.accessToken;
    } catch (error) {
      console.warn(`GitHub reconcile: failed to get token for user ${userId}`, error);
      tokenCache.set(userId, null);
      return null;
    }
  };

  let checked = 0;
  let updated = 0;
  let notified = 0;
  let skippedNoToken = 0;
  let rateLimited = false;

  for (const resource of resources) {
    if (rateLimited) break;
    checked++;

    const url = `https://api.github.com/repos/${encodeURIComponent(resource.owner)}/${encodeURIComponent(resource.repo)}/pulls/${resource.prNumber}`;
    const candidateUserIds = Array.from(new Set(resource.links.map((link) => link.userId)));

    let prPayload: {
      state?: string;
      draft?: boolean;
      merged_at?: string | null;
      title?: string;
      html_url?: string;
    } | null = null;

    let hadTokenCandidate = false;
    for (const userId of candidateUserIds) {
      const token = await getTokenForUser(userId);
      if (!token) continue;
      hadTokenCandidate = true;

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Valet-Reconciler',
          },
        });
      } catch (error) {
        console.warn(`GitHub reconcile: request failed for ${resource.owner}/${resource.repo}#${resource.prNumber}`, error);
        continue;
      }

      if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        rateLimited = true;
        const resetAt = response.headers.get('x-ratelimit-reset');
        console.warn(
          `GitHub reconcile: rate limit reached while checking ${resource.owner}/${resource.repo}#${resource.prNumber}`
          + (resetAt ? ` (reset at ${resetAt})` : ''),
        );
        break;
      }

      if (!response.ok) {
        // Permission errors are token-specific; try another linked user's token.
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          continue;
        }
        const body = await response.text();
        console.warn(
          `GitHub reconcile: unexpected ${response.status} for ${resource.owner}/${resource.repo}#${resource.prNumber}: ${body.slice(0, 200)}`,
        );
        continue;
      }

      prPayload = await response.json() as {
        state?: string;
        draft?: boolean;
        merged_at?: string | null;
        title?: string;
        html_url?: string;
      };
      break;
    }

    if (!prPayload) {
      if (!hadTokenCandidate) skippedNoToken++;
      continue;
    }

    const nextState = mapGitHubPullRequestState(prPayload.state, Boolean(prPayload.draft), prPayload.merged_at ?? null);
    if (!nextState || typeof prPayload.title !== 'string' || typeof prPayload.html_url !== 'string') {
      continue;
    }

    const nextMergedAt = prPayload.merged_at ?? null;
    for (const link of resource.links) {
      const changed =
        link.prState !== nextState
        || link.prTitle !== prPayload.title
        || link.prUrl !== prPayload.html_url
        || link.prMergedAt !== nextMergedAt;

      if (!changed) continue;

      try {
        await updateSessionGitState(db, link.sessionId, {
          prState: nextState as any,
          prTitle: prPayload.title,
          prUrl: prPayload.html_url,
          prMergedAt: nextMergedAt as any,
        });
        updated++;
      } catch (error) {
        console.error(`GitHub reconcile: failed to update git state for session ${link.sessionId}`, error);
        continue;
      }

      if (!LIVE_NOTIFY_SESSION_STATUSES.has(link.sessionStatus)) {
        continue;
      }

      try {
        const doId = env.SESSIONS.idFromName(link.sessionId);
        const stub = env.SESSIONS.get(doId);
        await stub.fetch(new Request('http://do/webhook-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'git-state-update',
            prState: nextState,
            prTitle: prPayload.title,
            prUrl: prPayload.html_url,
            prMergedAt: nextMergedAt,
          }),
        }));
        notified++;
      } catch (error) {
        console.warn(`GitHub reconcile: failed to notify session DO ${link.sessionId}`, error);
      }
    }
  }

  if (resourceMap.size > MAX_GITHUB_RESOURCES_PER_RUN) {
    console.log(
      `GitHub reconcile processed ${MAX_GITHUB_RESOURCES_PER_RUN}/${resourceMap.size} tracked resources (truncated this run)`,
    );
  }

  console.log(
    `GitHub reconcile summary: checked=${checked}, updated=${updated}, notified=${notified}, missingTokenResources=${skippedNoToken}, rateLimited=${rateLimited}`,
  );
}

function hasPromptDispatch(runtimeStateRaw: string | null): boolean {
  if (!runtimeStateRaw) return false;
  try {
    const parsed = JSON.parse(runtimeStateRaw) as {
      executor?: { promptDispatchedAt?: string };
    };
    return !!parsed?.executor?.promptDispatchedAt;
  } catch {
    return false;
  }
}

interface WorkflowResultEnvelope {
  executionId?: string;
  status?: 'ok' | 'needs_approval' | 'cancelled' | 'failed';
  output?: Record<string, unknown>;
  steps?: Array<{
    stepId: string;
    status: string;
    attempt?: number;
    startedAt?: string;
    completedAt?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  }>;
  requiresApproval?: {
    stepId?: string;
    prompt?: string;
    resumeToken?: string;
    items?: unknown[];
  } | null;
  error?: string | null;
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push(trimmed);
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = fenceRegex.exec(text);
  while (match) {
    const block = match[1]?.trim();
    if (block && block.startsWith('{') && block.endsWith('}')) {
      candidates.push(block);
    }
    match = fenceRegex.exec(text);
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const block = text.slice(firstBrace, lastBrace + 1).trim();
    if (block.startsWith('{') && block.endsWith('}')) {
      candidates.push(block);
    }
  }

  return candidates;
}

function parseWorkflowResultEnvelope(text: string, executionId: string): WorkflowResultEnvelope | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as WorkflowResultEnvelope;
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.executionId && parsed.executionId !== executionId) continue;
      if (!parsed.status) continue;
      if (!['ok', 'needs_approval', 'cancelled', 'failed'].includes(parsed.status)) continue;
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchWorkflowResultEnvelope(
  env: Env,
  sessionId: string,
  executionId: string,
): Promise<WorkflowResultEnvelope | null> {
  try {
    const doId = env.SESSIONS.idFromName(sessionId);
    const sessionDO = env.SESSIONS.get(doId);
    const response = await sessionDO.fetch(new Request('http://do/messages?limit=200'));
    if (!response.ok) return null;

    const payload = await response.json<{
      messages?: Array<{ role?: string; content?: string }>;
    }>();

    const messages = payload.messages || [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg = messages[index];
      if (!msg?.content || (msg.role !== 'assistant' && msg.role !== 'system')) continue;
      const envelope = parseWorkflowResultEnvelope(msg.content, executionId);
      if (envelope) return envelope;
    }
    return null;
  } catch (error) {
    console.warn(`Failed to fetch workflow result envelope for session ${sessionId}`, error);
    return null;
  }
}

// persistStepTrace is now in lib/db/executions.ts

async function expireWaitingApprovalExecutions(env: Env): Promise<number> {
  const db = getDb(env.DB);
  const now = new Date();
  const cutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
  const nowIso = now.toISOString();

  const rows = await getTimedOutApprovals(env.DB, cutoff);

  let expired = 0;
  for (const row of rows) {
    await finalizeExecution(db, row.id, {
      status: 'cancelled',
      error: 'approval_timeout',
      resumeToken: null,
      completedAt: nowIso,
    });
    await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
    expired++;
  }

  return expired;
}

async function reconcileWorkflowExecutions(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date().toISOString();
  const approvalsExpired = await expireWaitingApprovalExecutions(env);
  const rows = await getStaleWorkflowExecutions(env.DB);

  let completed = 0;
  let waitingApproval = 0;
  let cancelled = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.session_status === 'error') {
      await finalizeExecution(db, row.id, { status: 'failed', error: 'workflow_session_error', completedAt: now });
      await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
      failed++;
      continue;
    }

    if (row.session_status === 'hibernated') {
      await finalizeExecution(db, row.id, { status: 'failed', error: 'workflow_session_hibernated', completedAt: now });
      await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
      failed++;
      continue;
    }

    const promptDispatched = hasPromptDispatch(row.runtime_state);
    if (!promptDispatched) {
      await finalizeExecution(db, row.id, { status: 'failed', error: 'workflow_session_terminated_before_dispatch', completedAt: now });
      await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
      failed++;
      continue;
    }

    const envelope = row.session_id
      ? await fetchWorkflowResultEnvelope(env, row.session_id, row.id)
      : null;

    if (!envelope) {
      await finalizeExecution(db, row.id, { status: 'completed', completedAt: now });
      await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
      completed++;
      continue;
    }

    if (envelope.steps?.length) {
      await persistStepTrace(env.DB, row.id, envelope.steps);
    }

    const outputsJson = envelope.output ? JSON.stringify(envelope.output) : null;
    const stepsJson = envelope.steps ? JSON.stringify(envelope.steps) : null;

    if (envelope.status === 'needs_approval') {
      const resumeToken = envelope.requiresApproval?.resumeToken;
      if (!resumeToken) {
        await finalizeExecution(db, row.id, { status: 'failed', outputs: outputsJson, steps: stepsJson, error: 'approval_resume_token_missing', completedAt: now });
        await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
        failed++;
        continue;
      }

      await finalizeExecution(db, row.id, { status: 'waiting_approval', outputs: outputsJson, steps: stepsJson, resumeToken, completedAt: null });
      await enqueueWorkflowApprovalNotificationIfMissing(env.DB, {
        toUserId: row.user_id,
        executionId: row.id,
        fromSessionId: row.session_id || undefined,
        contextSessionId: row.session_id || undefined,
        workflowName: row.workflow_name,
        approvalPrompt: envelope.requiresApproval?.prompt,
      });
      waitingApproval++;
      continue;
    }

    if (envelope.status === 'cancelled') {
      await finalizeExecution(db, row.id, { status: 'cancelled', outputs: outputsJson, steps: stepsJson, error: envelope.error || 'workflow_cancelled', completedAt: now });
      await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
      cancelled++;
      continue;
    }

    if (envelope.status === 'failed') {
      await finalizeExecution(db, row.id, { status: 'failed', outputs: outputsJson, steps: stepsJson, error: envelope.error || 'workflow_failed', completedAt: now });
      await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
      failed++;
      continue;
    }

    await finalizeExecution(db, row.id, { status: 'completed', outputs: outputsJson, steps: stepsJson, completedAt: now });
    await markWorkflowApprovalNotificationsRead(db, row.user_id, row.id);
    completed++;
  }

  if (completed > 0 || waitingApproval > 0 || cancelled > 0 || failed > 0) {
    console.log(
      `Workflow reconcile finalized executions: completed=${completed} waiting_approval=${waitingApproval} cancelled=${cancelled} failed=${failed}`,
    );
  }
  if (approvalsExpired > 0) {
    console.log(`Workflow approval timeout sweep cancelled ${approvalsExpired} execution(s)`);
  }
}

type ScheduleTriggerConfig = Extract<TriggerConfig, { type: 'schedule' }>;

type TriggerRow = Awaited<ReturnType<typeof getActiveScheduleTriggers>>[number];

async function dispatchScheduledWorkflows(event: ScheduledController, env: Env): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date();
  const tickBucket = now.toISOString().slice(0, 16); // UTC minute precision

  const activeTriggers = await getActiveScheduleTriggers(env.DB);

  let dispatched = 0;
  let catchupDispatched = 0;

  // Dispatch helper shared by normal and catch-up paths. Returns true if dispatched.
  async function dispatchTrigger(
    row: TriggerRow,
    config: ScheduleTriggerConfig,
    bucket: string,
    dispatchTime: Date,
    catchup: boolean,
  ): Promise<boolean> {
    const timezone = config.timezone || 'UTC';
    const target = config.target === 'orchestrator' ? 'orchestrator' : 'workflow';
    const label = catchup ? '[catchup] ' : '';

    if (target === 'workflow') {
      if (!row.workflow_id || !row.workflow_data || !row.workflow_enabled) {
        return false;
      }

      const concurrency = await checkWorkflowConcurrency(db, row.user_id);
      if (!concurrency.allowed) {
        console.warn(
          `${label}Skipping scheduled workflow dispatch for trigger ${row.trigger_id}: ${concurrency.reason} (activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`,
        );
        return false;
      }

      const tickInserted = await insertScheduleTick(env.DB, row.trigger_id, bucket);
      if (!tickInserted) {
        return false;
      }

      const executionId = crypto.randomUUID();
      const workflowHash = await sha256Hex(String(row.workflow_data ?? '{}'));
      const sessionId = await createWorkflowSession(db, {
        userId: row.user_id,
        workflowId: row.workflow_id,
        executionId,
      });

      const variables = {
        _trigger: {
          type: 'schedule',
          triggerId: row.trigger_id,
          cron: config.cron,
          timezone,
          eventCron: event.cron,
          tickBucket: bucket,
          timestamp: dispatchTime.toISOString(),
        },
      };

      const idempotencyKey = `schedule:${row.trigger_id}:${bucket}`;
      await env.DB.prepare(`
        INSERT INTO workflow_executions
          (id, workflow_id, user_id, trigger_id, status, trigger_type, trigger_metadata, variables, started_at,
           workflow_version, workflow_hash, workflow_snapshot, idempotency_key, session_id, initiator_type, initiator_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        executionId,
        row.workflow_id,
        row.user_id,
        row.trigger_id,
        'pending',
        'schedule',
        JSON.stringify({ cron: config.cron, timezone, tickBucket: bucket }),
        JSON.stringify(variables),
        dispatchTime.toISOString(),
        row.workflow_version || null,
        workflowHash,
        row.workflow_data,
        idempotencyKey,
        sessionId,
        'schedule',
        row.user_id
      ).run();

      await enqueueWorkflowExecution(env, {
        executionId,
        workflowId: row.workflow_id,
        userId: row.user_id,
        sessionId,
        triggerType: 'schedule',
      });

      await updateTriggerLastRun(db, row.trigger_id, dispatchTime.toISOString());

      return true;
    }

    // Orchestrator target
    const prompt = config.prompt?.trim();
    if (!prompt) {
      return false;
    }

    // Claim the tick BEFORE dispatch to prevent concurrent cron invocations from
    // both dispatching the same prompt (the DO prompt queue has no dedup).
    const orchTickInserted = await insertScheduleTick(env.DB, row.trigger_id, bucket);
    if (!orchTickInserted) {
      return false;
    }

    let scheduledDate: string;
    try {
      scheduledDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone,
      }).format(dispatchTime);
    } catch {
      scheduledDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
      }).format(dispatchTime);
    }
    const dispatch = await dispatchOrchestratorPrompt(env, {
      userId: row.user_id,
      content: `[Today is ${scheduledDate}]\n\n${prompt}`,
      authorName: 'Scheduled Task',
      authorEmail: 'scheduled-task@valet.local',
      forceNewThread: true,
    });

    if (!dispatch.dispatched) {
      // Dispatch failed with a retriable reason (backoff, not configured, etc.) —
      // release the tick so catch-up can retry on the next cron invocation.
      // If this delete fails, the tick stays burned (safer than risking duplicate dispatch).
      try {
        await env.DB.prepare(
          'DELETE FROM workflow_schedule_ticks WHERE trigger_id = ? AND tick_bucket = ?'
        ).bind(row.trigger_id, bucket).run();
      } catch {
        // Best-effort release — if it fails, the tick is burned for this bucket
      }
      console.warn(
        `${label}Skipping scheduled orchestrator prompt for trigger ${row.trigger_id}: ${dispatch.reason || 'unknown_reason'}`,
      );
      return false;
    }

    await updateTriggerLastRun(db, row.trigger_id, dispatchTime.toISOString());
    return true;
  }

  // --- Parse configs once for both passes ---
  const parsedTriggers: Array<{ row: TriggerRow; config: ScheduleTriggerConfig }> = [];
  for (const row of activeTriggers) {
    let config: TriggerConfig;
    try {
      config = JSON.parse(row.config);
    } catch {
      continue;
    }
    if (config.type !== 'schedule' || !config.cron) continue;
    parsedTriggers.push({ row, config });
  }

  // --- Pass 1: dispatch triggers whose cron matches the current minute ---
  for (const { row, config } of parsedTriggers) {
    const timezone = config.timezone || 'UTC';
    if (!cronMatchesNow(config.cron, now, timezone)) {
      continue;
    }

    try {
      if (await dispatchTrigger(row, config, tickBucket, now, false)) {
        dispatched++;
      }
    } catch (err) {
      console.error(`Failed to dispatch trigger ${row.trigger_id}:`, err);
    }
  }

  // --- Pass 2: catch up triggers that missed their tick (e.g. Cloudflare skipped a cron invocation) ---
  // Look back from last_run_at up to a max window. The schedule_ticks dedup table prevents
  // double-dispatching if the tick was already handled (including ticks just dispatched in
  // Pass 1). Cap iterations to avoid burning CPU on very frequent crons.
  // Returns all missed ticks (oldest first) so consecutive misses are fully recovered.
  const CATCHUP_MAX_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours max lookback
  const CATCHUP_MAX_MINUTES = 240; // hard cap on backward scan iterations

  for (const { row, config } of parsedTriggers) {
    const timezone = config.timezone || 'UTC';
    const lastRun = row.last_run_at ? new Date(row.last_run_at) : null;
    if (!lastRun || isNaN(lastRun.getTime())) continue; // Never ran or corrupted — skip catch-up

    const windowStart = new Date(Math.max(lastRun.getTime(), now.getTime() - CATCHUP_MAX_WINDOW_MS));
    const missedBuckets = findMissedCronTicks(config.cron, timezone, windowStart, now, CATCHUP_MAX_MINUTES);

    for (const missedBucket of missedBuckets) {
      try {
        const missedTime = new Date(missedBucket + ':00.000Z');
        if (await dispatchTrigger(row, config, missedBucket, missedTime, true)) {
          catchupDispatched++;
          console.log(
            `[catchup] Dispatched missed trigger ${row.trigger_id} for bucket ${missedBucket} (last_run=${row.last_run_at})`,
          );
        }
      } catch (err) {
        console.error(`[catchup] Failed to dispatch trigger ${row.trigger_id} for bucket ${missedBucket}:`, err);
      }
    }
  }

  const parts = [`${dispatched} trigger(s) processed`];
  if (catchupDispatched > 0) parts.push(`${catchupDispatched} catch-up`);
  console.log(`Scheduled dispatch complete: ${parts.join(', ')}`);
}

/**
 * Archive terminated sessions older than 7 days.
 * GCs the Durable Object storage, deletes the persisted workspace volume,
 * then marks the session as 'archived' in D1.
 */
async function archiveTerminatedSessions(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const sessionIds = await getArchivableSessions(env.DB, cutoff, 50);
  if (sessionIds.length === 0) return;

  console.log(`Archiving ${sessionIds.length} terminated sessions older than 7 days`);

  // Fan-out: GC each SessionAgent DO's storage
  const gcResults = await Promise.allSettled(
    sessionIds.map(async (sessionId) => {
      const doId = env.SESSIONS.idFromName(sessionId);
      const sessionDO = env.SESSIONS.get(doId);
      await sessionDO.fetch(new Request('http://do/gc', { method: 'POST' }));
      return sessionId;
    })
  );

  // Collect IDs where DO GC succeeded
  const gcSucceededIds: string[] = [];
  for (const result of gcResults) {
    if (result.status === 'fulfilled') {
      gcSucceededIds.push(result.value);
    } else {
      console.error('Failed to GC session DO:', result.reason);
    }
  }

  if (gcSucceededIds.length === 0) return;

  // Fan-out: delete each session's persisted workspace volume
  const deleteWorkspaceUrl = env.MODAL_BACKEND_URL.replace('{label}', 'delete-workspace');
  const workspaceDeleteResults = await Promise.allSettled(
    gcSucceededIds.map(async (sessionId) => {
      const response = await fetch(deleteWorkspaceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const payload = await response.json() as { success?: boolean; deleted?: boolean };
      if (!payload.success) {
        throw new Error('Modal backend returned success=false');
      }

      return { sessionId, deleted: payload.deleted === true };
    })
  );

  const archivedIds: string[] = [];
  let deletedCount = 0;
  for (const result of workspaceDeleteResults) {
    if (result.status === 'fulfilled') {
      archivedIds.push(result.value.sessionId);
      if (result.value.deleted) deletedCount += 1;
    } else {
      console.error('Failed to delete workspace volume during archive:', result.reason);
    }
  }

  if (archivedIds.length === 0) return;

  // Batch-update status to 'archived' (re-check status to avoid race conditions)
  await markSessionsArchived(env.DB, archivedIds);

  console.log(`Archived ${archivedIds.length} sessions (workspace volumes deleted: ${deletedCount})`);
}

/**
 * Reconcile orchestrator state: find sessions stuck in transient states and ping their
 * DOs to resume, and log orphaned identities that have no session row.
 * This is a safety net — primary recovery is DO-internal and on-demand via ensureRunning.
 */
async function reconcileOrchestrators(env: Env): Promise<void> {
  // Find orchestrator sessions stuck in transient states for too long
  const stuckSessions = await env.DB.prepare(`
    SELECT s.id, s.user_id, s.status, s.last_active_at
    FROM sessions s
    JOIN orchestrator_identities oi ON oi.user_id = s.user_id
    WHERE s.id = 'orchestrator:' || s.user_id
      AND s.status IN ('initializing', 'recovering', 'waiting_runner', 'backoff')
      AND s.last_active_at < datetime('now', '-5 minutes')
  `).all();

  if (stuckSessions.results && stuckSessions.results.length > 0) {
    for (const row of stuckSessions.results) {
      console.error(`[OrchestratorReconcile] Session ${row.id} stuck in ${row.status} since ${row.last_active_at}`);
      try {
        const doId = env.SESSIONS.idFromName(row.id as string);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/ensure-running', { method: 'POST' }));
      } catch (err) {
        console.error(`[OrchestratorReconcile] Failed to ping ensureRunning for ${row.id}:`, err);
      }
    }
  }

  // Find orchestrators with identities but no session row (shouldn't happen post-migration)
  const orphanedIdentities = await env.DB.prepare(`
    SELECT oi.user_id, oi.name
    FROM orchestrator_identities oi
    WHERE NOT EXISTS (
      SELECT 1 FROM sessions s WHERE s.id = 'orchestrator:' || oi.user_id
    )
  `).all();

  if (orphanedIdentities.results && orphanedIdentities.results.length > 0) {
    for (const row of orphanedIdentities.results) {
      console.error(`[OrchestratorReconcile] Orchestrator identity for user ${row.user_id} (${row.name}) has no session row`);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
