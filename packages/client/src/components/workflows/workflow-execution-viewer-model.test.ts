import { describe, expect, it } from 'vitest';
import type { ExecutionApproval, ExecutionNode } from '@/api/executions';
import {
  buildExecutionNodeStateMap,
  getExecutionDisplayStatus,
  getSelectedNodeApproval,
} from './workflow-execution-viewer-model';

function trace(partial: Partial<ExecutionNode> & Pick<ExecutionNode, 'id' | 'nodeId' | 'status'>): ExecutionNode {
  return {
    nodeType: 'set',
    inputTruncated: false,
    outputTruncated: false,
    retryAttempts: 0,
    createdAt: '2026-06-18 00:00:00',
    ...partial,
  };
}

function approval(partial: Partial<ExecutionApproval> & Pick<ExecutionApproval, 'id' | 'nodeId' | 'status'>): ExecutionApproval {
  return {
    kind: 'explicit',
    prompt: 'Approve this step?',
    summary: null,
    details: null,
    timeoutAt: null,
    resolvedBy: null,
    resolvedAt: null,
    cancelledAt: null,
    createdAt: '2026-06-18 00:00:00',
    ...partial,
  };
}

describe('workflow execution viewer model', () => {
  it('keeps the latest trace row for each node in API order', () => {
    const map = buildExecutionNodeStateMap([
      trace({ id: 'exec:start:running:0', nodeId: 'start', status: 'running' }),
      trace({ id: 'exec:start:completed:0', nodeId: 'start', status: 'completed', durationMs: 12 }),
      trace({ id: 'exec:branch:running:0', nodeId: 'branch', status: 'running' }),
    ]);

    expect(map.get('start')?.status).toBe('completed');
    expect(map.get('start')?.durationMs).toBe(12);
    expect(map.get('branch')?.status).toBe('running');
  });

  it('surfaces not_run when a definition node has no trace', () => {
    const map = buildExecutionNodeStateMap([]);

    expect(getExecutionDisplayStatus('missing', map)).toBe('not_run');
  });

  it('returns the pending approval for the selected node', () => {
    const selected = getSelectedNodeApproval('review', [
      approval({ id: 'approval-old', nodeId: 'review', status: 'approved' }),
      approval({ id: 'approval-open', nodeId: 'review', status: 'pending' }),
      approval({ id: 'approval-other', nodeId: 'deploy', status: 'pending' }),
    ]);

    expect(selected?.id).toBe('approval-open');
  });

  it('returns resolved approval history when no pending approval exists for the selected node', () => {
    const selected = getSelectedNodeApproval('review', [
      approval({ id: 'approval-denied', nodeId: 'review', status: 'denied' }),
      approval({ id: 'approval-approved', nodeId: 'review', status: 'approved' }),
    ]);

    expect(selected?.id).toBe('approval-denied');
  });
});
