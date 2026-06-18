import { describe, expect, it } from 'vitest';
import type { ExecutionNode } from '@/api/executions';
import {
  buildExecutionNodeStateMap,
  getExecutionDisplayStatus,
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
});
