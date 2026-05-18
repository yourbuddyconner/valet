/**
 * Workflow runtime utilities.
 *
 * Business logic functions have moved to services/:
 * - dispatchOrchestratorPrompt → services/orchestrator.ts
 * - checkWorkflowConcurrency, enqueueWorkflowExecution → services/executions.ts
 *
 * This module keeps sha256Hex (pure utility) and createWorkflowSession (data access helper),
 * and re-exports the moved functions for backward compatibility.
 */

import type { AppDb } from './drizzle.js';
import * as db from './db.js';

// ─── Re-exports (backward compatibility) ───────────────────────────────────

export { dispatchOrchestratorPrompt } from '../services/orchestrator.js';
export { checkWorkflowConcurrency, enqueueWorkflowExecution } from '../services/executions.js';

// ─── Pure Utility ───────────────────────────────────────────────────────────

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Data Access Helper ─────────────────────────────────────────────────────

function buildWorkflowWorkspace(workflowId: string | null, executionId: string): string {
  // For test/dry runs (no workflowId) we derive a stable workspace name from the execution id.
  const wf = (workflowId ?? 'test').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'workflow';
  const ex = executionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'execution';
  return `workflow-${wf}-${ex}`.slice(0, 100);
}

export async function createWorkflowSession(
  database: AppDb,
  params: {
    userId: string;
    // Nullable for test/dry runs that don't have a persisted workflow row.
    workflowId: string | null;
    executionId: string;
    sourceRepoFullName?: string;
    sourceRepoUrl?: string;
    branch?: string;
    ref?: string;
  }
): Promise<string> {
  const sessionId = crypto.randomUUID();

  const titlePrefix = params.workflowId
    ? `Workflow ${params.workflowId.slice(0, 12)} run`
    : `Workflow test run ${params.executionId.slice(0, 8)}`;

  await db.createSession(database, {
    id: sessionId,
    userId: params.userId,
    workspace: buildWorkflowWorkspace(params.workflowId, params.executionId),
    title: titlePrefix,
    metadata: {
      workflowId: params.workflowId,
      executionId: params.executionId,
      internal: true,
      // Flag test sessions so consumers can hide them from default lists.
      isTestRun: params.workflowId === null,
    },
    purpose: 'workflow',
  });

  await db.createSessionGitState(database, {
    sessionId,
    sourceType: 'manual',
    sourceRepoFullName: params.sourceRepoFullName,
    sourceRepoUrl: params.sourceRepoUrl,
    branch: params.branch,
    ref: params.ref,
  });

  // Workflow sessions are created headless and should not appear as active runtime sessions.
  await db.updateSessionStatus(database, sessionId, 'hibernated');

  return sessionId;
}
