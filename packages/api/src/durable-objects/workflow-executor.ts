import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { getExecutionWithWorkflow, updateExecutionRuntimeState, resumeExecution, cancelExecutionWithReason, type ExecutionWithWorkflowRow } from '../lib/db/executions.js';
import { getUserIdleTimeout, getUserGitConfig } from '../lib/db/users.js';
import { getCredential } from '../services/credentials.js';
import { getSession, getSessionGitState, updateSessionStatus } from '../lib/db/sessions.js';
import { deriveSandboxJwtSecret } from '../lib/jwt.js';

interface EnqueueRequest {
  executionId: string;
  workflowId: string;
  userId: string;
  sessionId?: string;
  triggerType: 'manual' | 'webhook' | 'schedule';
  workerOrigin?: string;
}

interface ResumeRequest {
  executionId: string;
  resumeToken: string;
  approve: boolean;
  reason?: string;
}

interface CancelRequest {
  executionId: string;
  reason?: string;
}

interface RuntimeState {
  executor?: {
    dispatchCount: number;
    firstEnqueuedAt: string;
    lastEnqueuedAt: string;
    sessionId?: string;
    triggerType: 'manual' | 'webhook' | 'schedule';
    promptDispatchedAt?: string;
    sessionStartedAt?: string;
    workerOrigin?: string;
    lastError?: string;
  };
}

type ExecutionRow = ExecutionWithWorkflowRow;

interface EnsureSessionResult {
  ok: boolean;
  startedAt?: string;
  error?: string;
}

interface WorkflowExecutionDispatchPayload {
  kind: 'run' | 'resume';
  executionId: string;
  workflowHash?: string;
  resumeToken?: string;
  decision?: 'approve' | 'deny';
  payload: Record<string, unknown>;
}

export class WorkflowExecutorDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Drizzle AppDb instance wrapping the D1 binding. */
  private get appDb(): AppDb { return getDb(this.env.DB); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/enqueue' && request.method === 'POST') {
      return this.handleEnqueue(request);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return Response.json({ ok: true, state: 'ready' });
    }

    if (url.pathname === '/resume' && request.method === 'POST') {
      return this.handleResume(request);
    }

    if (url.pathname === '/cancel' && request.method === 'POST') {
      return this.handleCancel(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = await request.json<EnqueueRequest>();
    if (!body.executionId || !body.workflowId || !body.userId || !body.triggerType) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const row = await getExecutionWithWorkflow(this.env.DB, body.executionId);

    if (!row) {
      return Response.json({ error: 'Execution not found' }, { status: 404 });
    }

    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return Response.json({ ok: true, ignored: true, reason: 'already_finalized' });
    }

    if (row.status === 'waiting_approval') {
      return Response.json({ ok: true, ignored: true, reason: 'waiting_approval' });
    }

    const existingState = this.parseRuntimeState(row.runtime_state);
    const now = new Date().toISOString();
    const dispatchCount = (existingState.executor?.dispatchCount ?? 0) + 1;
    const workerOrigin = this.resolveWorkerOrigin(body.workerOrigin || existingState.executor?.workerOrigin);

    let promptDispatchedAt = existingState.executor?.promptDispatchedAt;
    let sessionStartedAt = existingState.executor?.sessionStartedAt;
    let lastError: string | undefined;

    if (!row.session_id) {
      lastError = 'Execution is missing bound session_id';
    } else if (!promptDispatchedAt) {
      const ensured = await this.ensureWorkflowSessionReady({
        sessionId: row.session_id,
        userId: row.user_id,
        workflowId: row.workflow_id,
        executionId: row.id,
        workerOrigin,
      });

      if (!ensured.ok) {
        lastError = ensured.error || 'Failed to prepare workflow session';
      } else {
        if (ensured.startedAt) {
          sessionStartedAt = ensured.startedAt;
        }

        const dispatchPayload = await this.buildWorkflowRunDispatchPayload(row);
        const dispatched = await this.dispatchWorkflowExecution(row.session_id, row.id, dispatchPayload);
        if (dispatched.ok) {
          promptDispatchedAt = now;
          lastError = undefined;
        } else {
          lastError = dispatched.error || 'Failed to dispatch workflow prompt';
        }
      }
    }

    const nextState: RuntimeState = {
      ...existingState,
      executor: {
        dispatchCount,
        firstEnqueuedAt: existingState.executor?.firstEnqueuedAt || now,
        lastEnqueuedAt: now,
        sessionId: row.session_id || body.sessionId,
        triggerType: body.triggerType,
        promptDispatchedAt,
        sessionStartedAt,
        workerOrigin,
        lastError,
      },
    };

    const nextStatus = row.status === 'pending' && promptDispatchedAt ? 'running' : row.status;

    await updateExecutionRuntimeState(this.appDb, body.executionId, JSON.stringify(nextState), nextStatus);

    await this.publishEnqueuedEvent(
      body.executionId,
      body.userId,
      body.workflowId,
      body.triggerType,
      dispatchCount,
      {
        sessionId: row.session_id || body.sessionId,
        promptDispatched: !!promptDispatchedAt,
        sessionStarted: !!sessionStartedAt,
        status: nextStatus,
        error: lastError,
      }
    );

    const responseBody = {
      ok: true,
      executionId: body.executionId,
      dispatchCount,
      status: nextStatus,
      promptDispatched: !!promptDispatchedAt,
      sessionStarted: !!sessionStartedAt,
      ...(lastError ? { error: lastError } : {}),
    };

    if (!promptDispatchedAt && row.status === 'pending') {
      console.warn(
        `[WorkflowExecutorDO] Enqueue did not dispatch prompt for execution ${body.executionId}: ${lastError || 'unknown_error'}`
      );
      return Response.json(responseBody, { status: 502 });
    }

    return Response.json(responseBody);
  }

  private async ensureWorkflowSessionReady(params: {
    sessionId: string;
    userId: string;
    workflowId: string;
    executionId: string;
    workerOrigin: string;
  }): Promise<EnsureSessionResult> {
    const session = await getSession(this.appDb, params.sessionId);

    if (!session) {
      return { ok: false, error: `Session ${params.sessionId} not found` };
    }

    if (session.status === 'running' || session.status === 'initializing' || (session.status as string) === 'waking') {
      return { ok: true };
    }

    const started = await this.bootstrapWorkflowSession({
      sessionId: session.id,
      workspace: session.workspace,
      userId: params.userId,
      workflowId: params.workflowId,
      executionId: params.executionId,
      workerOrigin: params.workerOrigin,
    });

    return started;
  }

  private async bootstrapWorkflowSession(params: {
    sessionId: string;
    workspace: string;
    userId: string;
    workflowId: string;
    executionId: string;
    workerOrigin: string;
  }): Promise<EnsureSessionResult> {
    try {
      const runnerToken = this.generateRunnerToken();
      const doWsUrl = this.buildDoWsUrl(params.workerOrigin, params.sessionId);

      const idleTimeoutSeconds = await getUserIdleTimeout(this.appDb, params.userId);
      const idleTimeoutMs = idleTimeoutSeconds * 1000;

      const envVars = await this.buildSandboxEnvVars({
        userId: params.userId,
        sessionId: params.sessionId,
        workflowId: params.workflowId,
        executionId: params.executionId,
      });

      const spawnRequest = {
        sessionId: params.sessionId,
        userId: params.userId,
        workspace: params.workspace,
        imageType: 'base',
        doWsUrl,
        runnerToken,
        jwtSecret: await deriveSandboxJwtSecret(this.env.ENCRYPTION_KEY, params.sessionId),
        idleTimeoutSeconds,
        envVars,
      };

      await updateSessionStatus(this.appDb, params.sessionId, 'initializing');

      const doId = this.env.SESSIONS.idFromName(params.sessionId);
      const sessionDO = this.env.SESSIONS.get(doId);

      const response = await sessionDO.fetch(new Request('http://do/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: params.sessionId,
          userId: params.userId,
          workspace: params.workspace,
          runnerToken,
          backendUrl: this.env.MODAL_BACKEND_URL.replace('{label}', 'create-session'),
          terminateUrl: this.env.MODAL_BACKEND_URL.replace('{label}', 'terminate-session'),
          hibernateUrl: this.env.MODAL_BACKEND_URL.replace('{label}', 'hibernate-session'),
          restoreUrl: this.env.MODAL_BACKEND_URL.replace('{label}', 'restore-session'),
          idleTimeoutMs,
          spawnRequest,
        }),
      }));

      if (!response.ok) {
        const errText = await response.text();
        return { ok: false, error: `Session start failed (${response.status}): ${errText}` };
      }

      return { ok: true, startedAt: new Date().toISOString() };
    } catch (error) {
      return {
        ok: false,
        error: `Session bootstrap error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async buildSandboxEnvVars(params: {
    userId: string;
    sessionId: string;
    workflowId: string;
    executionId: string;
  }): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {
      IS_WORKFLOW_SESSION: 'true',
      WORKFLOW_ID: params.workflowId,
      WORKFLOW_EXECUTION_ID: params.executionId,
    };

    if (this.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    if (this.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = this.env.OPENAI_API_KEY;
    if (this.env.GOOGLE_API_KEY) envVars.GOOGLE_API_KEY = this.env.GOOGLE_API_KEY;

    const gitUserRow = await getUserGitConfig(this.appDb, params.userId);

    envVars.GIT_USER_NAME = gitUserRow?.gitName || gitUserRow?.name || gitUserRow?.githubUsername || 'Valet User';
    envVars.GIT_USER_EMAIL = gitUserRow?.gitEmail || gitUserRow?.email || 'valet@example.local';

    const ghResult = await getCredential(this.env, 'user', params.userId, 'github');

    if (ghResult.ok) {
      try {
        envVars.GITHUB_TOKEN = ghResult.credential.accessToken;
      } catch (error) {
        console.warn('[WorkflowExecutorDO] Failed to get GitHub token for workflow session', error);
      }
    }

    const gitState = await getSessionGitState(this.appDb, params.sessionId);

    if (gitState?.sourceRepoUrl) {
      envVars.REPO_URL = gitState.sourceRepoUrl;
      if (gitState.branch) envVars.REPO_BRANCH = gitState.branch;
      if (gitState.ref) envVars.REPO_REF = gitState.ref;
    }

    return envVars;
  }

  private async buildWorkflowRunDispatchPayload(row: ExecutionRow): Promise<WorkflowExecutionDispatchPayload> {
    const payload = this.buildWorkflowRunPayload(row);
    const workflowHash = await this.computeCanonicalWorkflowHash(row.workflow_data);
    return {
      kind: 'run',
      executionId: row.id,
      ...(workflowHash ? { workflowHash } : {}),
      payload,
    };
  }

  private async buildWorkflowResumeDispatchPayload(
    row: ExecutionRow,
    resumeToken: string,
    approve: boolean,
  ): Promise<WorkflowExecutionDispatchPayload> {
    const decision = approve ? 'approve' : 'deny';
    const payload = this.buildWorkflowRunPayload(row);
    const workflowHash = await this.computeCanonicalWorkflowHash(row.workflow_data);
    return {
      kind: 'resume',
      executionId: row.id,
      resumeToken,
      decision,
      ...(workflowHash ? { workflowHash } : {}),
      payload,
    };
  }

  private buildWorkflowRunPayload(row: ExecutionRow): Record<string, unknown> {
    const workflow = this.parseJsonValue<Record<string, unknown>>(row.workflow_data, {});
    const trigger = this.parseJsonValue<Record<string, unknown>>(row.trigger_metadata, {});
    const variables = this.parseJsonValue<Record<string, unknown>>(row.variables, {});

    return {
      workflow,
      trigger,
      variables,
      runtime: {
        attempt: (row.attempt_count ?? 0) + 1,
        idempotencyKey: row.idempotency_key,
      },
    };
  }

  private async dispatchWorkflowExecution(
    sessionId: string,
    executionId: string,
    payload: WorkflowExecutionDispatchPayload,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const doId = this.env.SESSIONS.idFromName(sessionId);
      const sessionDO = this.env.SESSIONS.get(doId);
      const response = await sessionDO.fetch(new Request('http://do/workflow-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId, payload }),
      }));

      if (!response.ok) {
        const error = await response.text();
        return { ok: false, error: `Workflow dispatch failed (${response.status}): ${error}` };
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Prompt dispatch error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async stopWorkflowSession(sessionId: string, reason: string): Promise<void> {
    try {
      const doId = this.env.SESSIONS.idFromName(sessionId);
      const sessionDO = this.env.SESSIONS.get(doId);
      await sessionDO.fetch(new Request('http://do/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: `workflow_execution_cancelled:${reason}` }),
      }));
    } catch (error) {
      console.warn(`[WorkflowExecutorDO] Failed to stop workflow session ${sessionId}`, error);
    }
  }

  private resolveWorkerOrigin(origin?: string): string {
    const fallback = this.env.FRONTEND_URL || 'http://localhost:8787';
    const raw = origin || fallback;

    try {
      return new URL(raw).origin;
    } catch {
      return 'http://localhost:8787';
    }
  }

  private buildDoWsUrl(workerOrigin: string, sessionId: string): string {
    const parsed = new URL(workerOrigin);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}/api/sessions/${sessionId}/ws`;
  }

  private generateRunnerToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private parseJsonValue<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as T;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async computeCanonicalWorkflowHash(rawWorkflowData: string | null): Promise<string | undefined> {
    if (!rawWorkflowData) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawWorkflowData);
    } catch {
      return undefined;
    }

    const workflow = this.normalizeWorkflowForHash(parsed);
    if (!workflow) return undefined;

    const serialized = JSON.stringify(workflow);
    const data = new TextEncoder().encode(serialized);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  }

  private normalizeWorkflowForHash(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const workflow = value as Record<string, unknown>;
    if (!Array.isArray(workflow.steps)) {
      return null;
    }

    const normalizedSteps = workflow.steps
      .map((step, index) => this.normalizeStepForHash(step, `step[${index}]`))
      .filter((step): step is Record<string, unknown> => step !== null);

    if (normalizedSteps.length !== workflow.steps.length) {
      return null;
    }

    return this.deepSortForHash({
      ...workflow,
      steps: normalizedSteps,
    }) as Record<string, unknown>;
  }

  private normalizeStepForHash(stepValue: unknown, path: string): Record<string, unknown> | null {
    if (!stepValue || typeof stepValue !== 'object' || Array.isArray(stepValue)) {
      return null;
    }

    const source = stepValue as Record<string, unknown>;
    const typeValue = source.type;
    if (typeof typeValue !== 'string' || !typeValue.trim()) {
      return null;
    }

    const providedId = source.id;
    const id = typeof providedId === 'string' && providedId.trim()
      ? providedId.trim()
      : path.replace(/\./g, '_');

    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === 'then' || key === 'else' || key === 'steps') {
        if (Array.isArray(value)) {
          const nested = value
            .map((entry, index) => this.normalizeStepForHash(entry, `${path}.${key}[${index}]`))
            .filter((entry): entry is Record<string, unknown> => entry !== null);

          if (nested.length !== value.length) {
            return null;
          }
          normalized[key] = nested;
        } else if (value !== undefined && value !== null) {
          return null;
        }
        continue;
      }

      normalized[key] = this.deepSortForHash(value);
    }

    normalized.id = id;
    normalized.type = typeValue.trim();

    return this.deepSortForHash(normalized) as Record<string, unknown>;
  }

  private deepSortForHash(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.deepSortForHash(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = this.deepSortForHash((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  private async handleResume(request: Request): Promise<Response> {
    const body = await request.json<ResumeRequest>();
    if (!body.executionId || !body.resumeToken) {
      return Response.json({ error: 'Missing executionId or resumeToken' }, { status: 400 });
    }

    const row = await getExecutionWithWorkflow(this.env.DB, body.executionId);

    if (!row) {
      return Response.json({ error: 'Execution not found' }, { status: 404 });
    }

    if (row.status !== 'waiting_approval') {
      return Response.json({ error: 'Execution is not waiting approval' }, { status: 409 });
    }

    if (row.resume_token && row.resume_token !== body.resumeToken) {
      return Response.json({ error: 'Invalid resume token' }, { status: 400 });
    }

    const existingState = this.parseRuntimeState(row.runtime_state);
    const now = new Date().toISOString();
    const nextState: RuntimeState = {
      ...existingState,
      executor: {
        dispatchCount: existingState.executor?.dispatchCount ?? 0,
        firstEnqueuedAt: existingState.executor?.firstEnqueuedAt || now,
        lastEnqueuedAt: existingState.executor?.lastEnqueuedAt || now,
        sessionId: existingState.executor?.sessionId,
        triggerType: existingState.executor?.triggerType || 'manual',
        promptDispatchedAt: existingState.executor?.promptDispatchedAt,
        sessionStartedAt: existingState.executor?.sessionStartedAt,
        workerOrigin: existingState.executor?.workerOrigin,
        lastError: undefined,
      },
    };

    if (body.approve) {
      if (row.session_id) {
        const ensured = await this.ensureWorkflowSessionReady({
          sessionId: row.session_id,
          userId: row.user_id,
          workflowId: row.workflow_id,
          executionId: row.id,
          workerOrigin: this.resolveWorkerOrigin(existingState.executor?.workerOrigin),
        });
        if (!ensured.ok) {
          return Response.json({ error: ensured.error || 'Failed to prepare workflow session for resume' }, { status: 502 });
        }

        const dispatchPayload = await this.buildWorkflowResumeDispatchPayload(row, body.resumeToken, true);
        const dispatched = await this.dispatchWorkflowExecution(row.session_id, row.id, dispatchPayload);
        if (!dispatched.ok) {
          return Response.json({ error: dispatched.error || 'Failed to dispatch workflow resume prompt' }, { status: 502 });
        }
      }

      await resumeExecution(this.appDb, body.executionId, JSON.stringify(nextState));

      await this.publishLifecycleEvent(row.user_id, row.workflow_id, body.executionId, 'resumed', null);
      return Response.json({ ok: true, executionId: body.executionId, status: 'running' });
    }

    const reason = body.reason || 'approval_denied';
    await cancelExecutionWithReason(this.appDb, body.executionId, {
      runtimeState: JSON.stringify(nextState),
      reason,
      completedAt: now,
    });

    await this.publishLifecycleEvent(row.user_id, row.workflow_id, body.executionId, 'denied', reason);
    return Response.json({ ok: true, executionId: body.executionId, status: 'cancelled' });
  }

  private async handleCancel(request: Request): Promise<Response> {
    const body = await request.json<CancelRequest>();
    if (!body.executionId) {
      return Response.json({ error: 'Missing executionId' }, { status: 400 });
    }

    const row = await getExecutionWithWorkflow(this.env.DB, body.executionId);

    if (!row) {
      return Response.json({ error: 'Execution not found' }, { status: 404 });
    }

    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return Response.json({ ok: true, ignored: true, reason: 'already_finalized', status: row.status });
    }

    const existingState = this.parseRuntimeState(row.runtime_state);
    const now = new Date().toISOString();
    const reason = body.reason || 'cancelled_by_user';

    await cancelExecutionWithReason(this.appDb, body.executionId, {
      runtimeState: JSON.stringify(existingState),
      reason,
      completedAt: now,
    });

    if (row.session_id) {
      await this.stopWorkflowSession(row.session_id, reason);
    }

    await this.publishLifecycleEvent(row.user_id, row.workflow_id, body.executionId, 'cancelled', reason);
    return Response.json({ ok: true, executionId: body.executionId, status: 'cancelled' });
  }

  private parseRuntimeState(raw: string | null): RuntimeState {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as RuntimeState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async publishEnqueuedEvent(
    executionId: string,
    userId: string,
    workflowId: string,
    triggerType: 'manual' | 'webhook' | 'schedule',
    dispatchCount: number,
    details: {
      sessionId?: string;
      promptDispatched: boolean;
      sessionStarted: boolean;
      status: string;
      error?: string;
    }
  ): Promise<void> {
    try {
      const eventBusId = this.env.EVENT_BUS.idFromName('global');
      const eventBus = this.env.EVENT_BUS.get(eventBusId);
      await eventBus.fetch(new Request('https://event-bus/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          event: {
            type: 'notification',
            data: {
              category: 'workflow.execution.enqueued',
              executionId,
              workflowId,
              triggerType,
              dispatchCount,
              sessionId: details.sessionId,
              promptDispatched: details.promptDispatched,
              sessionStarted: details.sessionStarted,
              status: details.status,
              ...(details.error ? { error: details.error } : {}),
            },
            timestamp: new Date().toISOString(),
          },
        }),
      }));
    } catch (error) {
      console.error('Failed to publish workflow enqueue event', error);
    }
  }

  private async publishLifecycleEvent(
    userId: string,
    workflowId: string,
    executionId: string,
    action: 'resumed' | 'denied' | 'cancelled',
    reason: string | null
  ): Promise<void> {
    try {
      const eventBusId = this.env.EVENT_BUS.idFromName('global');
      const eventBus = this.env.EVENT_BUS.get(eventBusId);
      await eventBus.fetch(new Request('https://event-bus/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          event: {
            type: 'notification',
            data: {
              category: `workflow.execution.${action}`,
              executionId,
              workflowId,
              ...(reason ? { reason } : {}),
            },
            timestamp: new Date().toISOString(),
          },
        }),
      }));
    } catch (error) {
      console.error('Failed to publish workflow lifecycle event', error);
    }
  }
}
