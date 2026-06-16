/**
 * `tool` node executor.
 *
 * Calls an existing worker-side integration action through the same
 * pipeline agent tool calls use: disabled-action check, action source
 * lookup, credential resolution, action-policy resolution (allow /
 * deny / require_approval), and a deterministic `action_invocations`
 * row keyed by `workflow:<executionId>:<nodeId>` so step.do retries are
 * idempotent.
 *
 * onPolicyDeny:
 *   - 'fail' (default): a denied policy fails the workflow.
 *   - 'skip': a denied policy completes the node with `{denied:true}`.
 *
 * For `require_approval`, the executor pauses on
 * step.waitForEvent via the shared `requestApproval` helper, the same
 * mechanism the `approval` node uses.
 */

import type { ToolNode } from '@valet/shared';
import { renderJsonTemplates, renderTemplate } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import { integrationRegistry } from '../../integrations/registry.js';
import { isActionDisabled } from '../../lib/db/disabled-actions.js';
import { loadCustomMcpConnectorContext } from '../../services/custom-mcp-connectors.js';
import { getDb } from '../../lib/drizzle.js';
import { invokeWorkflowAction, markExecuted, markFailed } from '../../services/actions.js';
import { updateInvocationStatus } from '../../lib/db/actions.js';
import { requestApproval } from '../approvals.js';
import { setExecutionStatus } from '../execution-status.js';
import { CancelledError, iterationSuffix, NO_RETRY } from '../types.js';
import type { NodeExecutorArgs } from '../types.js';

export interface ToolDeniedOutput {
  denied: true;
  reason: string;
}

export async function executeTool(args: NodeExecutorArgs<ToolNode>): Promise<unknown> {
  const { node, env, params: runParams, step } = args;
  const db = getDb(env.DB);
  const ctx = buildTemplateContext(args.state, args.aliases);
  // Iteration suffix is APPENDED to every step.do name below so foreach
  // iterations of this tool don't collide on CF cache keys (iteration
  // 0's return would otherwise replay for items 1..N).
  const iSuffix = iterationSuffix(args.aliases);
  const iterIdx = args.aliases?.__iterationIndex;
  const iterationIndex = typeof iterIdx === 'number' ? iterIdx : undefined;

  // tool is STEP_DRIVEN — runtime.ts does NOT wrap this executor in an
  // outer step.do. Every D1 write and external call below has its own
  // step.do so the CF durability layer caches results across hibernate/
  // wake and a retry of any single step does not re-fire side effects
  // already committed by an earlier step.

  // 1. Preflight reads (disabled-action + action definition) — cached
  // so a replay returns the same risk level and disabled state without
  // re-reading D1 or re-listing integration actions.
  const preflightJson = await step.do(`tool:${node.id}${iSuffix}:preflight`, async () => {
    if (await isActionDisabled(db, node.service, node.action)) {
      throw new Error(`tool node "${node.id}": action ${node.service}.${node.action} is disabled`);
    }
    const customCtx = await loadCustomMcpConnectorContext(env, db);
    const source = integrationRegistry.getActions(node.service, customCtx);
    if (!source) {
      throw new Error(`tool node "${node.id}": no integration package for service "${node.service}"`);
    }
    const defs = await source.listActions();
    const def = defs.find((a) => a.id === node.action);
    if (!def) {
      throw new Error(`tool node "${node.id}": action "${node.action}" not found in ${node.service} package`);
    }
    return JSON.stringify({ riskLevel: def.riskLevel ?? 'medium' });
  });
  const preflight = JSON.parse(preflightJson) as { riskLevel: string };

  // Loading the customContext + actionSource is not cached because they
  // bind closures (mcp clients) we can't serialize. They are derived
  // from inputs that don't change across replay, so re-running is
  // safe.
  const customContext = await loadCustomMcpConnectorContext(env, db);
  const actionSource = integrationRegistry.getActions(node.service, customContext);
  if (!actionSource) {
    throw new Error(`tool node "${node.id}": no integration package for service "${node.service}"`);
  }

  // 2. Render params (deterministic from state.nodes + inputs).
  const renderedParams = renderJsonTemplates(node.params, ctx) as Record<string, unknown>;

  // 3. Invocation row + policy resolution. Cached because creating /
  // resolving the row is the contract that prevents re-firing the
  // action on replay.
  const invocationId = aliasedInvocationId(runParams.executionId, node.id, args.aliases);
  // Surface the invocation id back to the runtime so the trace row
  // for this node has it set on every status transition.
  if (args.correlations) args.correlations.invocationId = invocationId;
  const invocationJson = await step.do(`tool:${node.id}${iSuffix}:invocation`, { retries: { ...NO_RETRY } }, async () => {
    const result = await invokeWorkflowAction(db, {
      invocationId,
      executionId: runParams.executionId,
      userId: runParams.userId,
      service: node.service,
      actionId: node.action,
      riskLevel: preflight.riskLevel,
      params: renderedParams,
    });
    return JSON.stringify(result);
  });
  const invocation = JSON.parse(invocationJson) as { outcome: 'allowed' | 'denied' | 'pending_approval' };

  // 4. Handle policy outcome.
  if (invocation.outcome === 'denied') {
    if (node.onPolicyDeny === 'skip') {
      return { denied: true, reason: 'policy_denied' } satisfies ToolDeniedOutput;
    }
    throw new Error(`tool node "${node.id}": action policy denied`);
  }

  if (invocation.outcome === 'pending_approval') {
    const summary = node.summary !== undefined
      ? coerceString(renderTemplate(node.summary, ctx))
      : `${node.service}.${node.action}`;
    // Surface the approvalId onto correlations BEFORE entering the
    // wait so the waiting_approval trace row records it. Computed
    // identically to requestApproval's internal id (including the
    // iteration suffix) so the link is stable. Without this the trace
    // row recorded during the wait shows invocationId but approvalId
    // is NULL — breaking the audit chain during the (potentially long)
    // pending window.
    if (args.correlations) {
      args.correlations.approvalId = `approval:${runParams.executionId}:${node.id}${iSuffix}`;
    }
    // Drive workflow_executions.status to 'waiting_approval' before
    // suspending. The explicit approval and wait node executors do
    // this too; tool-policy approvals previously stayed in 'running'
    // which broke the stuck-approval retry sweep (it filters on
    // status='waiting_approval'), letting sendEvent failures after
    // approve/deny stall the execution indefinitely. The try/finally
    // around requestApproval guarantees the exit transition runs even
    // on timeout / cancel / denial throws.
    await setExecutionStatus({
      env,
      step,
      executionId: runParams.executionId,
      status: 'waiting_approval',
      stepKey: `tool:${node.id}${iSuffix}:enter:waiting_approval`,
      allowedPrior: ['running'],
    });
    // Persist a waiting_approval trace row so the execution detail UI
    // shows this tool node parked on the approval, with both
    // invocationId and approvalId linked. The runtime's running trace
    // was written before this executor ran, so neither correlation id
    // was available then. For foreach iterations, the foreach wrapper
    // injects iterationIndex so this trace row stays per-iteration.
    const approvalStartedAt = await step.do(`tool:${node.id}${iSuffix}:approval-started-at`, async () => new Date().toISOString());
    await args.recordWaiting?.({
      nodeId: node.id,
      nodeType: 'tool',
      status: 'waiting_approval',
      startedAt: approvalStartedAt,
      invocationId,
      approvalId: `approval:${runParams.executionId}:${node.id}${iSuffix}`,
    });
    // requestApproval already does its own step.do / step.waitForEvent.
    // iterationIndex scopes the approvalId + step.waitForEvent type
    // when this tool is the body of a foreach.
    let approval: Awaited<ReturnType<typeof requestApproval>>;
    try {
      approval = await requestApproval({
        env,
        step,
        executionId: runParams.executionId,
        workflowInstanceId: runParams.executionId,
        nodeId: node.id,
        kind: 'tool_policy',
        prompt: `Approve ${node.service}.${node.action}?`,
        summary,
        details: renderedParams,
        ...(iterationIndex !== undefined ? { iterationIndex } : {}),
      });
    } finally {
      // Exit transition: drive the row back to 'running' so downstream
      // node executions can update status from a known prior state.
      // Mirrors the wait + approval executors' try/finally pattern;
      // without this a thrown approval (timeout, denial, sendEvent
      // race) would leave the execution stuck in waiting_approval.
      await setExecutionStatus({
        env,
        step,
        executionId: runParams.executionId,
        status: 'running',
        stepKey: `tool:${node.id}${iSuffix}:exit:running`,
        allowedPrior: ['waiting_approval'],
      });
    }
    if (approval.result === 'cancelled') {
      // System cancel — do NOT run onPolicyDeny logic. Mark invocation
      // as denied so the audit chain is consistent, then throw
      // CancelledError so the runtime tags this node 'skipped:cancelled'.
      await step.do(`tool:${node.id}${iSuffix}:invocation-cancelled`, async () => {
        await updateInvocationStatus(db, invocationId, { status: 'denied', expectedStatus: 'pending' });
        return null;
      });
      throw new CancelledError(`tool node "${node.id}" cancelled by ${approval.cancelledBy}`);
    }
    if (approval.result !== 'approved') {
      await step.do(`tool:${node.id}${iSuffix}:invocation-denied`, async () => {
        await updateInvocationStatus(db, invocationId, {
          status: approval.result === 'timed_out' ? 'expired' : 'denied',
          expectedStatus: 'pending',
        });
        return null;
      });
      if (node.onPolicyDeny === 'skip') {
        return { denied: true, reason: approval.result === 'timed_out' ? 'approval_timeout' : 'approval_denied' } satisfies ToolDeniedOutput;
      }
      throw new Error(`tool node "${node.id}": approval ${approval.result}`);
    }
    await step.do(`tool:${node.id}${iSuffix}:invocation-approved`, async () => {
      await updateInvocationStatus(db, invocationId, {
        status: 'approved',
        expectedStatus: 'pending',
        resolvedBy: approval.approvedBy,
      });
      return null;
    });
  }

  // 5. Resolve credentials inside step.do — the credential fetch
  // touches D1 + external token refresh; we want the resolved tuple
  // cached so a retry doesn't re-issue a refresh token call.
  const provider = integrationRegistry.getProvider(node.service, customContext);
  let credentials: Record<string, string> = {};
  let attribution: { name: string; email: string } | undefined;
  if (provider && providerRequiresUserCredential(provider)) {
    const credJson = await step.do(`tool:${node.id}${iSuffix}:credentials`, { retries: { ...NO_RETRY } }, async () => {
      const credResult = await integrationRegistry.resolveCredentials(node.service, env, runParams.userId, {
        params: renderedParams,
        forceRefresh: false,
      });
      if (!credResult.ok) {
        // Allow-mode rows enter as 'pending' and are flipped to
        // 'executed' only after a successful action call; approval-mode
        // rows are flipped to 'approved' by the resolver. Credential
        // failure happens before either flip, so the prior status is
        // whatever the policy outcome left.
        await updateInvocationStatus(db, invocationId, { status: 'failed', expectedStatus: invocation.outcome === 'allowed' ? 'pending' : 'approved' });
        throw new Error(`tool node "${node.id}": no credentials for ${node.service}: ${credResult.error.message}`);
      }
      return JSON.stringify({
        credentials: buildCredentials(credResult),
        attribution: credResult.credential.attribution,
      });
    });
    const credParsed = JSON.parse(credJson) as { credentials: Record<string, string>; attribution?: { name: string; email: string } };
    credentials = credParsed.credentials;
    attribution = credParsed.attribution;
  }

  // 6. Invoke the action. This is the actual external side effect —
  // wrap in step.do so the result is cached and we don't re-issue the
  // API call on replay. NO_RETRY is enforced by the outer runtime
  // resolveStepConfig for tool, but the inner action call is naturally
  // single-shot under its own step.do regardless.
  const actionContext = {
    credentials,
    userId: runParams.userId,
    ...(attribution ? { attribution } : {}),
    analytics: { emit: () => { /* TODO: wire into analytics_events */ } },
  };

  // node.retries is the author-declared number of additional attempts
  // (0 = single attempt, the NO_RETRY default). Action calls are
  // potentially non-idempotent (sends an email, creates a PR), so this
  // is opt-in per node. CF's step.do `retries.limit` counts total
  // attempts including the first try, so we translate retries → limit
  // as 1 + retries. Defaults stay at NO_RETRY (limit=1).
  const retryConfig = typeof node.retries === 'number' && node.retries > 0
    ? { limit: 1 + node.retries, delay: '1 second' as const }
    : { ...NO_RETRY };
  const executeJson = await step.do(`tool:${node.id}${iSuffix}:execute`, { retries: retryConfig }, async () => {
    const result = await actionSource.execute(node.action, renderedParams, actionContext);
    return JSON.stringify(result);
  });
  const result = JSON.parse(executeJson) as { success: boolean; data?: unknown; error?: string };

  if (!result.success) {
    await step.do(`tool:${node.id}${iSuffix}:mark-failed`, async () => {
      await markFailed(db, invocationId, result.error ?? 'unknown error');
      return null;
    });
    throw new Error(`tool node "${node.id}": action failed: ${result.error ?? 'unknown error'}`);
  }
  await step.do(`tool:${node.id}${iSuffix}:mark-executed`, async () => {
    await markExecuted(db, invocationId, result.data);
    return null;
  });
  return result.data;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function aliasedInvocationId(executionId: string, nodeId: string, aliases?: Record<string, unknown>): string {
  // Foreach iterations inject the iteration index under a reserved key
  // (__iterationIndex) so this lookup is stable regardless of the
  // author-configured indexAlias name.
  const idx = aliases?.__iterationIndex;
  if (typeof idx === 'number') {
    return `workflow:${executionId}:${nodeId}:${idx}`;
  }
  return `workflow:${executionId}:${nodeId}`;
}

function providerRequiresUserCredential(
  provider?: { authType?: string; isCustomConnector?: boolean; credentialScope?: 'org' | 'user' },
): boolean {
  if (!provider) return false;
  if (provider.authType === 'none') return false;
  if (provider.isCustomConnector && provider.authType === 'api_key') return provider.credentialScope === 'user';
  return true;
}

interface CredentialOk {
  ok: true;
  credential: {
    accessToken?: string;
    refreshToken?: string;
    customFields?: Record<string, string>;
    attribution?: { name: string; email: string };
  };
}

function buildCredentials(result: CredentialOk): Record<string, string> {
  const out: Record<string, string> = {};
  const cred = result.credential;
  if (cred.accessToken) out.access_token = cred.accessToken;
  if (cred.refreshToken) out.refresh_token = cred.refreshToken;
  if (cred.customFields) Object.assign(out, cred.customFields);
  return out;
}

function coerceString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

