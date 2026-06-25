import { describe, expect, it } from 'vitest';
import type { ExecutionApproval, ExecutionNode } from '@/api/executions';
import {
  buildExecutionNodeStateMap,
  buildTraceDetailSections,
  getReadableJsonItemTitle,
  getReadableJsonSummary,
  getReadableJsonTable,
  getNodeParametersForDisplay,
  getExecutionDisplayStatus,
  getSelectedNodeApproval,
  parseExecutionPayload,
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

  it('builds selected node parameters without id/type noise', () => {
    const params = getNodeParametersForDisplay({
      id: 'fetch_prs',
      type: 'tool',
      service: 'github',
      action: 'github.list_pull_requests',
      params: {
        owner: '{{nodes.config.data.owner}}',
        repo: '{{nodes.config.data.repo}}',
      },
      onPolicyDeny: 'fail',
    });

    expect(params).toEqual({
      service: 'github',
      action: 'github.list_pull_requests',
      params: {
        owner: '{{nodes.config.data.owner}}',
        repo: '{{nodes.config.data.repo}}',
      },
      onPolicyDeny: 'fail',
    });
  });

  it('omits selected node parameters when the node has no configurable fields', () => {
    expect(getNodeParametersForDisplay({ id: 'trigger', type: 'trigger' })).toBeNull();
  });

  it('parses JSON trace payloads into formatted values', () => {
    expect(parseExecutionPayload('[{"number":81,"title":"Handle first-come"}]')).toEqual({
      kind: 'json',
      value: [{ number: 81, title: 'Handle first-come' }],
      formatted: '[\n  {\n    "number": 81,\n    "title": "Handle first-come"\n  }\n]',
    });
  });

  it('splits trace payloads into labeled detail sections', () => {
    const sections = buildTraceDetailSections(trace({
      id: 'exec:fetch_prs:completed:0',
      nodeId: 'fetch_prs',
      status: 'completed',
      inputPreview: '{"owner":"tkhq"}',
      output: '[{"number":81}]',
    }));

    expect(sections.map((section) => [section.title, section.payload.kind])).toEqual([
      ['Input', 'json'],
      ['Output', 'json'],
    ]);
  });

  it('summarizes parsed JSON for human-readable execution details', () => {
    expect(getReadableJsonSummary([{ number: 81 }, { number: 78 }])).toBe('2 items');
    expect(getReadableJsonSummary({ owner: 'tkhq', repo: 'valet' })).toBe('2 fields');
    expect(getReadableJsonSummary('ready')).toBe('ready');
  });

  it('labels list items from recognizable object fields', () => {
    expect(getReadableJsonItemTitle({ number: 81, title: 'Handle first-come, first-served facilities' }, 0)).toBe(
      '#81 Handle first-come, first-served facilities',
    );
    expect(getReadableJsonItemTitle({ name: 'Customer Onboarding Pipeline' }, 1)).toBe('Customer Onboarding Pipeline');
    expect(getReadableJsonItemTitle({ state: 'open' }, 2)).toBe('Item 3');
  });

  it('formats matrix arrays as spreadsheet-like tables', () => {
    expect(getReadableJsonTable([
      ['Task', 'Owner', 'Done'],
      ['Ship workflows', 'Conner', false],
    ])).toEqual({
      kind: 'matrix',
      columns: ['1', '2', '3'],
      rows: [
        ['Task', 'Owner', 'Done'],
        ['Ship workflows', 'Conner', 'false'],
      ],
      totalRows: 2,
      hiddenRows: 0,
      hiddenColumns: 0,
    });
  });

  it('formats arrays of records as column tables', () => {
    expect(getReadableJsonTable([
      { number: 81, title: 'Handle first-come', state: 'open', user: 'conner' },
      { number: 78, title: 'Add POI search', state: 'open', user: 'conner' },
    ])).toEqual({
      kind: 'records',
      columns: ['number', 'title', 'state', 'user'],
      rows: [
        ['81', 'Handle first-come', 'open', 'conner'],
        ['78', 'Add POI search', 'open', 'conner'],
      ],
      totalRows: 2,
      hiddenRows: 0,
      hiddenColumns: 0,
    });
  });
});
