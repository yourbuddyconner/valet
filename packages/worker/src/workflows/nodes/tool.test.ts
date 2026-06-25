import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.fn();
const listActionsMock = vi.fn();
const resolveCredentialsMock = vi.fn();
const getActionsMock = vi.fn();
const getProviderMock = vi.fn();
const isActionDisabledMock = vi.fn();
const loadCustomMcpConnectorContextMock = vi.fn();
const invokeWorkflowActionMock = vi.fn();
const updateInvocationStatusMock = vi.fn();
const requestApprovalMock = vi.fn();

vi.mock('../../integrations/registry.js', () => ({
  integrationRegistry: {
    getActions: (...args: unknown[]) => getActionsMock(...args),
    getProvider: (...args: unknown[]) => getProviderMock(...args),
    resolveCredentials: (...args: unknown[]) => resolveCredentialsMock(...args),
  },
}));

vi.mock('../../lib/db/disabled-actions.js', () => ({
  isActionDisabled: (...args: unknown[]) => isActionDisabledMock(...args),
}));

vi.mock('../../services/custom-mcp-connectors.js', () => ({
  loadCustomMcpConnectorContext: (...args: unknown[]) => loadCustomMcpConnectorContextMock(...args),
}));

vi.mock('../../lib/drizzle.js', () => ({
  getDb: () => ({} as unknown),
}));

const markExecutedMock = vi.fn();
const markFailedMock = vi.fn();
vi.mock('../../services/actions.js', () => ({
  invokeWorkflowAction: (...args: unknown[]) => invokeWorkflowActionMock(...args),
  markExecuted: (...args: unknown[]) => markExecutedMock(...args),
  markFailed: (...args: unknown[]) => markFailedMock(...args),
}));

vi.mock('../../lib/db/actions.js', () => ({
  updateInvocationStatus: (...args: unknown[]) => updateInvocationStatusMock(...args),
}));

vi.mock('../approvals.js', () => ({
  requestApproval: (...args: unknown[]) => requestApprovalMock(...args),
}));

// setExecutionStatus persists workflow_executions.status transitions via
// the live Drizzle instance. Tests run with a stub DB so we mock this
// module to a no-op; the assertions don't depend on the row update.
vi.mock('../execution-status.js', () => ({
  setExecutionStatus: vi.fn(async () => {}),
}));

import { executeTool } from './tool.js';
import type { ToolNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function makeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
      const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<T>;
      return fn();
    },
    async sleep() { /* noop */ },
    async sleepUntil() { /* noop */ },
    async waitForEvent() { throw new Error('waitForEvent not used in tool tests'); },
  } as unknown as WorkflowStep;
}

function args(node: ToolNode, triggerData: Record<string, unknown> = {}) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: triggerData, metadata: {} },
    nodes: {},
    skipped: {},
  };
  return {
    node,
    state: fullState,
    params: { executionId: 'exec-1', workflowId: 'wf-1', userId: 'user-1' } as WorkflowRunParams,
    env: { DB: {} } as Env,
    step: makeStep(),
  };
}

beforeEach(() => {
  executeMock.mockReset();
  listActionsMock.mockReset();
  resolveCredentialsMock.mockReset();
  getActionsMock.mockReset();
  getProviderMock.mockReset();
  isActionDisabledMock.mockReset();
  loadCustomMcpConnectorContextMock.mockReset();
  invokeWorkflowActionMock.mockReset();
  updateInvocationStatusMock.mockReset();
  requestApprovalMock.mockReset();
  markExecutedMock.mockReset();
  markFailedMock.mockReset();
  isActionDisabledMock.mockResolvedValue(false);
  loadCustomMcpConnectorContextMock.mockResolvedValue({ connectors: new Map() });
  listActionsMock.mockResolvedValue([{ id: 'slack.send_message', riskLevel: 'low' }, { id: 'slack.test', riskLevel: 'low' }, { id: 'gmail.send', riskLevel: 'medium' }, { id: 'sheets.clear_range', riskLevel: 'medium' }, { id: 'unknown.x', riskLevel: 'low' }, { id: 'unknown.y', riskLevel: 'low' }]);
  getActionsMock.mockReturnValue({ execute: executeMock, listActions: listActionsMock });
  getProviderMock.mockReturnValue({ authType: 'none' });
  invokeWorkflowActionMock.mockResolvedValue({ outcome: 'allowed', invocationId: 'inv-1', mode: 'allow', policyId: null });
});

describe('executeTool', () => {
  it('renders templated params and calls actionSource.execute', async () => {
    executeMock.mockResolvedValue({ success: true, data: { messageTs: '123' } });
    const node: ToolNode = {
      id: 't', type: 'tool', service: 'slack', action: 'slack.send_message',
      params: { channel: '{{trigger.data.channel}}', text: 'hi {{trigger.data.user}}' },
    };
    const out = await executeTool(args(node, { channel: 'C1', user: 'bob' }));
    expect(out).toEqual({ messageTs: '123' });
    expect(executeMock).toHaveBeenCalledWith(
      'slack.send_message',
      { channel: 'C1', text: 'hi bob' },
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(invokeWorkflowActionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      invocationId: 'workflow:exec-1:t',
      executionId: 'exec-1',
    }));
  });

  it('throws when the action is disabled', async () => {
    isActionDisabledMock.mockResolvedValue(true);
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    await expect(executeTool(args(node))).rejects.toThrow(/is disabled/);
  });

  it('throws when no integration package exists for the service', async () => {
    getActionsMock.mockReturnValue(undefined);
    const node: ToolNode = { id: 't', type: 'tool', service: 'unknown', action: 'unknown.x', params: {} };
    await expect(executeTool(args(node))).rejects.toThrow(/no integration package/);
  });

  it('throws when the action id is not in the package', async () => {
    listActionsMock.mockResolvedValue([{ id: 'something_else', riskLevel: 'low' }]);
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    await expect(executeTool(args(node))).rejects.toThrow(/not found in slack package/);
  });

  it('fails when the action-policy resolves to denied', async () => {
    invokeWorkflowActionMock.mockResolvedValue({ outcome: 'denied', invocationId: 'inv-1', mode: 'deny', policyId: null });
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    await expect(executeTool(args(node))).rejects.toThrow(/policy denied/);
  });

  it('returns a denied envelope when onPolicyDeny=skip and policy denies', async () => {
    invokeWorkflowActionMock.mockResolvedValue({ outcome: 'denied', invocationId: 'inv-1', mode: 'deny', policyId: null });
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {}, onPolicyDeny: 'skip' };
    const out = await executeTool(args(node));
    expect(out).toEqual({ denied: true, reason: 'policy_denied' });
  });

  it('pauses for approval and proceeds when granted', async () => {
    invokeWorkflowActionMock.mockResolvedValue({ outcome: 'pending_approval', invocationId: 'inv-1', mode: 'require_approval', policyId: null });
    requestApprovalMock.mockResolvedValue({ result: 'approved', approvedBy: 'user-2', respondedAt: 'now' });
    executeMock.mockResolvedValue({ success: true, data: 'ok' });
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    await executeTool(args(node));
    expect(requestApprovalMock).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 't', kind: 'tool_policy' }));
    expect(executeMock).toHaveBeenCalled();
  });

  it('fails when approval is denied', async () => {
    invokeWorkflowActionMock.mockResolvedValue({ outcome: 'pending_approval', invocationId: 'inv-1', mode: 'require_approval', policyId: null });
    requestApprovalMock.mockResolvedValue({ result: 'denied', deniedBy: 'user-2', respondedAt: 'now' });
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    await expect(executeTool(args(node))).rejects.toThrow(/approval denied/);
  });

  it('uses a foreach iteration index in the invocation id', async () => {
    executeMock.mockResolvedValue({ success: true, data: null });
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    const a = args(node);
    // Foreach now injects the iteration index under a reserved key
    // (__iterationIndex) so user-configurable indexAlias rename
    // doesn't collide.
    (a as { aliases?: Record<string, unknown> }).aliases = { item: { x: 1 }, index: 7, __iterationIndex: 7 };
    await executeTool(a);
    expect(invokeWorkflowActionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      invocationId: 'workflow:exec-1:t:7',
    }));
  });

  it('passes credentials when provider requires them', async () => {
    getProviderMock.mockReturnValue({ authType: 'oauth2' });
    resolveCredentialsMock.mockResolvedValue({
      ok: true,
      credential: { accessToken: 'tok-1', customFields: { workspace_id: 'W1' } },
    });
    executeMock.mockResolvedValue({ success: true, data: null });
    const node: ToolNode = { id: 't', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} };
    await executeTool(args(node));
    expect(executeMock).toHaveBeenCalledWith(
      'slack.send_message',
      {},
      expect.objectContaining({ credentials: { access_token: 'tok-1', workspace_id: 'W1' } }),
    );
  });

  it('force-refreshes credentials and retries once when an action returns a 401 auth error', async () => {
    getProviderMock.mockReturnValue({ authType: 'oauth2' });
    resolveCredentialsMock
      .mockResolvedValueOnce({
        ok: true,
        credential: { accessToken: 'stale-token' },
      })
      .mockResolvedValueOnce({
        ok: true,
        credential: { accessToken: 'fresh-token' },
      });
    executeMock
      .mockResolvedValueOnce({ success: false, error: 'Sheets API 401: Request had invalid authentication credentials.' })
      .mockResolvedValueOnce({ success: true, data: { clearedRange: 'Tasks!A1:D6' } });

    const node: ToolNode = {
      id: 'clear_sheet',
      type: 'tool',
      service: 'google_workspace',
      action: 'sheets.clear_range',
      params: { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
    };

    const out = await executeTool(args(node));

    expect(out).toEqual({ clearedRange: 'Tasks!A1:D6' });
    expect(resolveCredentialsMock).toHaveBeenNthCalledWith(1, 'google_workspace', expect.anything(), 'user-1', {
      params: { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
      forceRefresh: false,
    });
    expect(resolveCredentialsMock).toHaveBeenNthCalledWith(2, 'google_workspace', expect.anything(), 'user-1', {
      params: { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
      forceRefresh: true,
    });
    expect(executeMock).toHaveBeenNthCalledWith(
      1,
      'sheets.clear_range',
      { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
      expect.objectContaining({ credentials: { access_token: 'stale-token' } }),
    );
    expect(executeMock).toHaveBeenNthCalledWith(
      2,
      'sheets.clear_range',
      { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
      expect.objectContaining({ credentials: { access_token: 'fresh-token' } }),
    );
    expect(markExecutedMock).toHaveBeenCalledWith(expect.anything(), 'workflow:exec-1:clear_sheet', { clearedRange: 'Tasks!A1:D6' });
    expect(markFailedMock).not.toHaveBeenCalled();
  });
});
