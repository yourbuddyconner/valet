import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@valet/shared';
import {
  applyDefaultDataFlowForConnection,
  buildToolCatalogIndex,
  deriveWorkflowOutputSources,
  createDefaultWorkflowDefinition,
  definitionToFlow,
  formatWorkflowTemplatePath,
  flowToDefinition,
  getDefaultNodeForType,
  normalizeWorkflowDefinitionForEditor,
  createWorkflowInputPatchForNode,
  updateWorkflowNode,
  validateWorkflowDataFlowEdges,
} from './workflow-editor-model';

describe('workflow editor model', () => {
  it('converts dag/v1 definitions to flow nodes and edges with saved positions', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'set', values: { ok: true } },
        {
          id: 'branch',
          type: 'if',
          conditions: [{ left: '{{nodes.start.data.ok}}', dataType: 'boolean', operation: 'equals', right: true }],
        },
        { id: 'done', type: 'stop', outcome: 'success', message: 'Finished' },
      ],
      edges: [
        { from: 'start', to: 'branch' },
        { from: 'branch', to: 'done', fromOutput: 'true' },
      ],
      ui: {
        nodes: {
          start: { position: { x: 10, y: 20 } },
          branch: { position: { x: 260, y: 20 } },
        },
        viewport: { x: 1, y: 2, zoom: 0.75 },
      },
    };

    const flow = definitionToFlow(definition);

    expect(flow.nodes.find((node) => node.id === 'trigger')).toMatchObject({
      id: 'trigger',
      type: 'workflow',
      position: { x: -330, y: 20 },
      deletable: false,
      data: { nodeType: 'trigger', label: 'Trigger', handles: { source: true, target: false } },
    });
    expect(flow.nodes.find((node) => node.id === 'start')).toMatchObject({
      id: 'start',
      type: 'workflow',
      position: { x: 10, y: 20 },
      data: { nodeType: 'set', label: 'Set values', handles: { source: true, target: true } },
    });
    expect(flow.nodes.find((node) => node.id === 'branch')).toMatchObject({
      id: 'branch',
      type: 'workflow',
      position: { x: 260, y: 20 },
      data: { nodeType: 'if', label: 'If', handles: { source: true, target: true } },
    });
    expect(flow.nodes.find((node) => node.id === 'done')).toMatchObject({
      id: 'done',
      type: 'workflow',
      position: { x: 1020, y: -140 },
      data: { nodeType: 'stop', label: 'Stop', handles: { source: false, target: true } },
    });
    expect(flow.edges).toEqual([
      {
        id: 'start->branch',
        source: 'start',
        target: 'branch',
        type: 'animated',
        data: {},
      },
      {
        id: 'branch:true->done',
        source: 'branch',
        sourceHandle: 'true',
        target: 'done',
        type: 'temporary',
        label: 'true',
        data: { fromOutput: 'true' },
      },
      {
        id: 'trigger->start',
        source: 'trigger',
        target: 'start',
        type: 'animated',
        data: {},
      },
    ]);
  });

  it('round-trips false branch handles on if nodes', () => {
    const flow = definitionToFlow({
      version: 'dag/v1',
      nodes: [
        { id: 'branch', type: 'if', conditions: [] },
        { id: 'reject', type: 'stop', outcome: 'failure' },
      ],
      edges: [{ from: 'branch', to: 'reject', fromOutput: 'false' }],
    });

    expect(flow.nodes.find((node) => node.id === 'branch')!.data.handles).toEqual({
      target: true,
      source: true,
      sourceOutputs: ['true', 'false'],
    });
    expect(flow.edges.find((edge) => edge.id === 'branch:false->reject')).toMatchObject({
      source: 'branch',
      sourceHandle: 'false',
      data: { fromOutput: 'false' },
    });

    expect(flowToDefinition(flow).edges).toEqual([
      { from: 'branch', to: 'reject', fromOutput: 'false' },
      { from: 'trigger', to: 'branch' },
    ]);
  });

  it('lays out tool-created workflows by graph depth and branch direction when positions are missing', () => {
    const flow = definitionToFlow({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'normalize', type: 'set', values: {} },
        { id: 'branch', type: 'if', conditions: [] },
        { id: 'true_tool', type: 'tool', service: 'github', action: 'github.list_issues', params: {} },
        { id: 'false_llm', type: 'llm', prompt: 'Write a fallback' },
        { id: 'finish', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 'trigger', to: 'normalize' },
        { from: 'normalize', to: 'branch' },
        { from: 'branch', to: 'true_tool', fromOutput: 'true' },
        { from: 'branch', to: 'false_llm', fromOutput: 'false' },
        { from: 'true_tool', to: 'finish' },
        { from: 'false_llm', to: 'finish' },
      ],
    });

    expect(Object.fromEntries(flow.nodes.map((node) => [node.id, node.position]))).toEqual({
      trigger: { x: 0, y: 0 },
      normalize: { x: 340, y: 0 },
      branch: { x: 680, y: 0 },
      true_tool: { x: 1020, y: -140 },
      false_llm: { x: 1020, y: 140 },
      finish: { x: 1360, y: 0 },
    });
  });

  it('preserves saved positions while laying out missing nodes', () => {
    const flow = definitionToFlow({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'start', type: 'set', values: {} },
        { id: 'done', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 'trigger', to: 'start' },
        { from: 'start', to: 'done' },
      ],
      ui: {
        nodes: {
          start: { position: { x: 25, y: 50 } },
        },
      },
    });

    expect(flow.nodes.find((node) => node.id === 'start')?.position).toEqual({ x: 25, y: 50 });
    expect(flow.nodes.find((node) => node.id === 'done')?.position).toEqual({ x: 680, y: 0 });
  });

  it('serializes flow edits back to dag/v1 while preserving node payloads', () => {
    const base = createDefaultWorkflowDefinition();
    const flow = definitionToFlow(base);
    const triggerNode = flow.nodes.find((node) => node.id === 'trigger')!;
    const setNode = flow.nodes.find((node) => node.id === 'start')!;
    const stopNode = {
      id: 'stop-1',
      type: 'workflow' as const,
      position: { x: 360, y: 0 },
      data: {
        node: { id: 'stop-1', type: 'stop' as const, outcome: 'success' as const, message: 'Done' },
        nodeType: 'stop' as const,
        label: 'Stop',
        description: 'Finish workflow',
        summary: 'Done',
        handles: { source: false, target: true },
      },
    };

    const definition = flowToDefinition({
      nodes: [
        triggerNode,
        { ...setNode, position: { x: 20, y: 40 } },
        stopNode,
      ],
      edges: [
        { id: 'start->stop-1', source: 'start', target: 'stop-1', type: 'animated', data: {} },
      ],
      viewport: { x: -10, y: 5, zoom: 1.2 },
    });

    expect(definition).toEqual({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'start', type: 'set', values: {} },
        { id: 'stop-1', type: 'stop', outcome: 'success', message: 'Done' },
      ],
      edges: [{ from: 'start', to: 'stop-1' }],
      ui: {
        nodes: {
          trigger: { position: { x: -320, y: 0 } },
          start: { position: { x: 20, y: 40 } },
          'stop-1': { position: { x: 360, y: 0 } },
        },
        viewport: { x: -10, y: 5, zoom: 1.2 },
      },
    });
  });

  it('creates default node payloads for every dag/v1 node type', () => {
    expect(createDefaultWorkflowDefinition().nodes[0]).toMatchObject({ id: 'trigger', type: 'trigger' });
    expect(getDefaultNodeForType('llm', 'llm-1')).toMatchObject({ id: 'llm-1', type: 'llm', prompt: '' });
    expect(getDefaultNodeForType('tool', 'tool-1')).toMatchObject({ id: 'tool-1', type: 'tool', service: '', action: '', params: {} });
    expect(getDefaultNodeForType('if', 'if-1')).toMatchObject({ id: 'if-1', type: 'if', conditions: [] });
    expect(getDefaultNodeForType('approval', 'approval-1')).toMatchObject({ id: 'approval-1', type: 'approval', prompt: '' });
    expect(getDefaultNodeForType('wait', 'wait-1')).toMatchObject({ id: 'wait-1', type: 'wait', mode: 'duration', duration: '5m' });
    expect(getDefaultNodeForType('set', 'set-1')).toMatchObject({ id: 'set-1', type: 'set', values: {} });
    expect(getDefaultNodeForType('foreach', 'foreach-1')).toMatchObject({ id: 'foreach-1', type: 'foreach', items: '', body: { type: 'set' } });
    expect(getDefaultNodeForType('orchestrator', 'orchestrator-1')).toMatchObject({ id: 'orchestrator-1', type: 'orchestrator', prompt: '' });
    expect(getDefaultNodeForType('session', 'session-1')).toMatchObject({ id: 'session-1', type: 'session', mode: 'start', prompt: '', workspace: '' });
    expect(getDefaultNodeForType('stop', 'stop-1')).toMatchObject({ id: 'stop-1', type: 'stop', outcome: 'success' });
  });

  it('normalizes legacy definitions with a locked trigger source connected to root nodes', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'set', values: {} },
        { id: 'followup', type: 'set', values: {} },
      ],
      edges: [{ from: 'start', to: 'followup' }],
      ui: {
        nodes: {
          start: { position: { x: 20, y: 40 } },
          followup: { position: { x: 340, y: 40 } },
        },
      },
    };

    const normalized = normalizeWorkflowDefinitionForEditor(definition);

    expect(normalized.nodes[0]).toMatchObject({ id: 'trigger', type: 'trigger' });
    expect(normalized.edges).toEqual([
      { from: 'start', to: 'followup' },
      { from: 'trigger', to: 'start' },
    ]);
    expect(normalized.ui?.nodes.trigger.position).toEqual({ x: -320, y: 40 });
  });

  it('derives trigger output sources from workflow inputs and runtime envelope fields', () => {
    const definition: WorkflowDefinition = normalizeWorkflowDefinitionForEditor({
      version: 'dag/v1',
      inputs: {
        issues: { type: 'array', description: 'Issues supplied by manual test run.' },
      },
      nodes: [{ id: 'loop', type: 'foreach', items: '', body: { id: 'loop-body', type: 'set', values: {} } }],
      edges: [{ from: 'trigger', to: 'loop' }],
    });

    const sources = deriveWorkflowOutputSources(definition, []);

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'trigger',
        label: 'Trigger data',
        expression: '{{trigger.data}}',
        valueType: 'object',
      }),
      expect.objectContaining({
        nodeId: 'trigger',
        label: 'Trigger input issues',
        expression: '{{inputs.issues}}',
        valueType: 'array',
      }),
    ]));
  });

  it('updates typed node parameters and refreshes card summary', () => {
    const node = {
      id: 'llm-1',
      type: 'workflow' as const,
      position: { x: 0, y: 0 },
      data: {
        node: { id: 'llm-1', type: 'llm' as const, prompt: '' },
        nodeType: 'llm' as const,
        label: 'LLM',
        description: 'Generate or transform text with a model',
        summary: 'No prompt configured',
        handles: { source: true, target: true },
      },
    };

    const updated = updateWorkflowNode(node, {
      prompt: 'Summarize the current issue',
      model: 'gpt-4.1',
      temperature: 0.2,
    });

    expect(updated.data.node).toEqual({
      id: 'llm-1',
      type: 'llm',
      prompt: 'Summarize the current issue',
      model: 'gpt-4.1',
      temperature: 0.2,
    });
    expect(updated.data.summary).toBe('Summarize the current issue');
  });

  it('creates a set value patch from a clicked available input', () => {
    const patch = createWorkflowInputPatchForNode(
      { id: 'start', type: 'set', values: { triggerData: 'existing' } },
      {
        nodeId: 'trigger',
        nodeLabel: 'Trigger',
        actionName: 'Workflow trigger',
        path: ['trigger', 'data'],
        expression: '{{trigger.data}}',
        label: 'Trigger data',
        valueType: 'object',
      },
    );

    expect(patch).toEqual({
      values: {
        triggerData: 'existing',
        triggerData2: '{{trigger.data}}',
      },
    });
  });

  it('appends clicked available inputs into prompt nodes', () => {
    const patch = createWorkflowInputPatchForNode(
      { id: 'llm-1', type: 'llm', prompt: 'Summarize this:' },
      {
        nodeId: 'trigger',
        nodeLabel: 'Trigger',
        actionName: 'Workflow trigger',
        path: ['trigger', 'data'],
        expression: '{{trigger.data}}',
        label: 'Trigger data',
        valueType: 'object',
      },
    );

    expect(patch).toEqual({ prompt: 'Summarize this:\n{{trigger.data}}' });
  });

  it('adds clicked available inputs as if conditions', () => {
    const patch = createWorkflowInputPatchForNode(
      { id: 'if-1', type: 'if', conditions: [] },
      {
        nodeId: 'start',
        nodeLabel: 'Set values',
        actionName: 'Set values',
        path: ['nodes', 'start', 'data', 'count'],
        expression: '{{nodes.start.data.count}}',
        label: 'start count',
        valueType: 'scalar',
      },
    );

    expect(patch).toEqual({
      conditions: [
        {
          left: '{{nodes.start.data.count}}',
          dataType: 'string',
          operation: 'equals',
          right: '',
        },
      ],
    });
  });

  it('indexes tool action catalog entries by service for picker controls', () => {
    const index = buildToolCatalogIndex([
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.create_issue',
        name: 'Create issue',
        description: 'Create a GitHub issue',
        riskLevel: 'medium',
      },
      {
        service: 'slack',
        serviceDisplayName: 'Slack',
        actionId: 'slack.send_message',
        name: 'Send message',
        description: 'Send a Slack message',
        riskLevel: 'medium',
      },
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.create_pull_request',
        name: 'Create pull request',
        description: 'Open a GitHub pull request',
        riskLevel: 'high',
      },
    ]);

    expect(index.services).toEqual([
      { service: 'github', serviceDisplayName: 'GitHub', actionCount: 2 },
      { service: 'slack', serviceDisplayName: 'Slack', actionCount: 1 },
    ]);
    expect(index.actionsByService.get('github')?.map((action) => action.actionId)).toEqual([
      'github.create_issue',
      'github.create_pull_request',
    ]);
  });

  it('derives upstream array output sources from selected tool action schemas', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'set', values: {} },
        { id: 'tool-1', type: 'tool', service: 'github', action: 'github.list_issues', params: {} },
        { id: 'loop', type: 'foreach', items: '', body: { id: 'loop-body', type: 'set', values: {} } },
      ],
      edges: [
        { from: 'start', to: 'tool-1' },
        { from: 'tool-1', to: 'loop' },
      ],
    };

    const sources = deriveWorkflowOutputSources(definition, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.list_issues',
        name: 'List Issues',
        description: 'List issues for a repository',
        riskLevel: 'low',
        outputSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'number' },
              title: { type: 'string' },
            },
          },
        },
      },
    ]);

    expect(sources).toEqual([
      {
        nodeId: 'tool-1',
        nodeLabel: 'Tool',
        actionName: 'List Issues',
        path: ['nodes', 'tool-1', 'data'],
        expression: '{{nodes["tool-1"].data}}',
        label: 'tool-1 output',
        valueType: 'array',
        itemFields: [
          { name: 'number', path: ['nodes', 'tool-1', 'data', 'number'], valueType: 'number' },
          { name: 'title', path: ['nodes', 'tool-1', 'data', 'title'], valueType: 'string' },
        ],
      },
    ]);
  });

  it('derives nested array output sources from object schemas', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'search', type: 'tool', service: 'github', action: 'github.search_issues', params: {} },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.search_issues',
        name: 'Search Issues',
        description: 'Search issues and pull requests',
        riskLevel: 'low',
        outputSchema: {
          type: 'object',
          properties: {
            total_count: { type: 'number' },
            items: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    ]);

    expect(sources.map((source) => source.expression)).toEqual([
      '{{nodes.search.data.items}}',
    ]);
  });

  it('derives the workflows array from the GitHub list workflows output contract', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'tool-1', type: 'tool', service: 'github', action: 'github.list_workflows', params: {} },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.list_workflows',
        name: 'List Workflows',
        description: 'List workflow definitions',
        riskLevel: 'low',
        outputSchema: {
          type: 'object',
          properties: {
            total_count: { type: 'number' },
            workflows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  path: { type: 'string' },
                  state: { type: 'string' },
                },
              },
            },
          },
        },
      },
    ]);

    expect(sources).toMatchObject([
      {
        nodeId: 'tool-1',
        actionName: 'List Workflows',
        expression: '{{nodes["tool-1"].data.workflows}}',
        label: 'tool-1 workflows',
        valueType: 'array',
        itemFields: [
          { name: 'id', path: ['nodes', 'tool-1', 'data', 'workflows', 'id'], valueType: 'number' },
          { name: 'name', path: ['nodes', 'tool-1', 'data', 'workflows', 'name'], valueType: 'string' },
          { name: 'path', path: ['nodes', 'tool-1', 'data', 'workflows', 'path'], valueType: 'string' },
          { name: 'state', path: ['nodes', 'tool-1', 'data', 'workflows', 'state'], valueType: 'string' },
        ],
      },
    ]);
  });

  it('defaults foreach items from a single compatible upstream array output', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'tool-1', type: 'tool', service: 'github', action: 'github.list_workflows', params: {} },
        { id: 'foreach-1', type: 'foreach', items: '', body: { id: 'foreach-1-body', type: 'set', values: {} } },
      ],
      edges: [{ from: 'tool-1', to: 'foreach-1' }],
    };

    const updated = applyDefaultDataFlowForConnection(
      definition,
      { from: 'tool-1', to: 'foreach-1' },
      [
        {
          service: 'github',
          serviceDisplayName: 'GitHub',
          actionId: 'github.list_workflows',
          name: 'List Workflows',
          description: 'List workflow definitions',
          riskLevel: 'low',
          outputSchema: {
            type: 'object',
            properties: {
              workflows: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      ],
    );

    expect(updated.nodes.find((node) => node.id === 'foreach-1')).toMatchObject({
      type: 'foreach',
      items: '{{nodes["tool-1"].data.workflows}}',
    });
  });

  it('warns when a foreach node is connected to an upstream node without a typed array output', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'tool-1', type: 'tool', service: 'github', action: 'github.create_issue', params: {} },
        { id: 'foreach-1', type: 'foreach', items: '', body: { id: 'foreach-1-body', type: 'set', values: {} } },
      ],
      edges: [{ from: 'tool-1', to: 'foreach-1' }],
    };

    expect(validateWorkflowDataFlowEdges(definition, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.create_issue',
        name: 'Create Issue',
        description: 'Create issue',
        riskLevel: 'medium',
        outputSchema: {
          type: 'object',
          properties: {
            number: { type: 'number' },
            title: { type: 'string' },
          },
        },
      },
    ])).toEqual([
      {
        edgeId: 'tool-1->foreach-1',
        severity: 'warning',
        message: 'For each needs an array output from tool-1, but no typed array output is available.',
      },
    ]);
  });

  it('formats template paths with bracket notation for unsafe path segments', () => {
    expect(formatWorkflowTemplatePath(['nodes', 'tool-1', 'data', 'pull_requests'])).toBe(
      '{{nodes["tool-1"].data.pull_requests}}',
    );
  });
});
