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

function buildWorkflowWorkspace(workflowId: string, executionId: string): string {
  const wf = workflowId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'workflow';
  const ex = executionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'execution';
  return `workflow-${wf}-${ex}`.slice(0, 100);
}

export async function createWorkflowSession(
  database: AppDb,
  params: {
    userId: string;
    workflowId: string;
    executionId: string;
    sourceRepoFullName?: string;
    sourceRepoUrl?: string;
    branch?: string;
    ref?: string;
  }
): Promise<string> {
  const sessionId = crypto.randomUUID();

  await db.createSession(database, {
    id: sessionId,
    userId: params.userId,
    workspace: buildWorkflowWorkspace(params.workflowId, params.executionId),
    title: `Workflow ${params.workflowId.slice(0, 12)} run`,
    metadata: {
      workflowId: params.workflowId,
      executionId: params.executionId,
      internal: true,
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
