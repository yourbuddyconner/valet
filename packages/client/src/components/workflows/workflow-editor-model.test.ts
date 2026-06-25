import { describe, expect, it } from 'vitest';
import { createDefaultWorkflowNode, type WorkflowDefinition } from '@valet/shared';
import {
  applyDefaultDataFlowForConnection,
  buildWorkflowEdgeInspection,
  buildToolCatalogIndex,
  deriveWorkflowOutputSources,
  deriveWorkflowTemplateSources,
  createDefaultWorkflowDefinition,
  jsonSchemaToWorkflowInputDefinitions,
  definitionToFlow,
  filterNodePaletteOptions,
  formatWorkflowTemplatePath,
  flowToDefinition,
  normalizeWorkflowDefinitionForEditor,
  removeWorkflowFlowNode,
  NODE_PALETTE_LIST_CLASSNAME,
  NODE_PALETTE_PANEL_CLASSNAME,
  createWorkflowInputPatchForNode,
  updateWorkflowNode,
  validateWorkflowDataFlowEdges,
  workflowInputDefinitionsToJsonSchema,
} from './workflow-editor-model';

describe('workflow editor model', () => {
  it('groups addable node types for the node palette', () => {
    const groups = filterNodePaletteOptions('');

    expect(groups.map((group) => [group.section.label, group.options.map((option) => option.type)])).toEqual([
      ['AI', ['llm', 'orchestrator', 'session']],
      ['Action in an app', ['tool']],
      ['Data transformation', ['set']],
      ['Flow', ['if', 'foreach', 'wait', 'stop']],
      ['Human in the loop', ['approval']],
    ]);
  });

  it('filters node palette options by node metadata', () => {
    expect(filterNodePaletteOptions('conditions')).toEqual([
      expect.objectContaining({
        section: expect.objectContaining({ label: 'Flow' }),
        options: [expect.objectContaining({ type: 'if' })],
      }),
    ]);

    expect(filterNodePaletteOptions('approval')).toEqual([
      expect.objectContaining({
        section: expect.objectContaining({ label: 'Human in the loop' }),
        options: [expect.objectContaining({ type: 'approval' })],
      }),
    ]);
  });

  it('returns a whole node palette category when the category matches', () => {
    expect(filterNodePaletteOptions('flow')).toEqual([
      expect.objectContaining({
        section: expect.objectContaining({ label: 'Flow' }),
        options: [
          expect.objectContaining({ type: 'if' }),
          expect.objectContaining({ type: 'foreach' }),
          expect.objectContaining({ type: 'wait' }),
          expect.objectContaining({ type: 'stop' }),
        ],
      }),
    ]);
  });

  it('keeps the node palette bounded while making the list scrollable', () => {
    expect(NODE_PALETTE_PANEL_CLASSNAME).toContain('flex');
    expect(NODE_PALETTE_PANEL_CLASSNAME).toContain('flex-col');
    expect(NODE_PALETTE_PANEL_CLASSNAME).toContain('max-h-[calc(100dvh-10rem)]');
    expect(NODE_PALETTE_LIST_CLASSNAME).toContain('min-h-0');
    expect(NODE_PALETTE_LIST_CLASSNAME).toContain('flex-1');
    expect(NODE_PALETTE_LIST_CLASSNAME).toContain('overflow-y-auto');
    expect(NODE_PALETTE_LIST_CLASSNAME).not.toContain('100vh-13rem');
  });

  it('converts workflow input definitions to an object JSON schema', () => {
    expect(workflowInputDefinitionsToJsonSchema({
      digest: { type: 'string', required: true, description: 'Summary text' },
      pr_count: { type: 'number' },
    })).toEqual({
      type: 'object',
      properties: {
        digest: { type: 'string', description: 'Summary text' },
        pr_count: { type: 'number' },
      },
      required: ['digest'],
    });
  });

  it('converts an object JSON schema into workflow input definitions for the shared schema builder', () => {
    expect(jsonSchemaToWorkflowInputDefinitions({
      type: 'object',
      required: ['digest'],
      properties: {
        digest: { type: 'string', description: 'Summary text' },
        pr_count: { type: 'number' },
        ignored_union: { type: ['string', 'null'] },
      },
    })).toEqual({
      digest: { type: 'string', required: true, description: 'Summary text' },
      pr_count: { type: 'number' },
      ignored_union: { type: 'string' },
    });
  });

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
        style: { stroke: 'var(--workflow-edge-stroke)', strokeWidth: 2 },
        data: {},
      },
      {
        id: 'branch:true->done',
        source: 'branch',
        sourceHandle: 'true',
        target: 'done',
        type: 'temporary',
        label: 'true',
        style: { stroke: 'var(--workflow-edge-branch-stroke)', strokeWidth: 2 },
        data: { fromOutput: 'true' },
      },
      {
        id: 'trigger->start',
        source: 'trigger',
        target: 'start',
        type: 'animated',
        style: { stroke: 'var(--workflow-edge-stroke)', strokeWidth: 2 },
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

  it('removes a flow node and its connected edges without removing trigger', () => {
    const flow = definitionToFlow({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'start', type: 'set', values: {} },
        { id: 'branch', type: 'if', conditions: [] },
        { id: 'done', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 'trigger', to: 'start' },
        { from: 'start', to: 'branch' },
        { from: 'branch', to: 'done', fromOutput: 'true' },
      ],
      ui: {
        nodes: {
          trigger: { position: { x: -340, y: 0 } },
          start: { position: { x: 0, y: 0 } },
          branch: { position: { x: 340, y: 0 } },
          done: { position: { x: 680, y: 0 } },
        },
        viewport: { x: 10, y: 20, zoom: 0.8 },
      },
    });

    const next = removeWorkflowFlowNode(flow, 'branch');

    expect(next.nodes.map((node) => node.id)).toEqual(['trigger', 'start', 'done']);
    expect(next.edges.map((edge) => edge.id)).toEqual(['trigger->start']);
    expect(next.viewport).toEqual({ x: 10, y: 20, zoom: 0.8 });
    expect(removeWorkflowFlowNode(next, 'trigger')).toBe(next);
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
    expect(createDefaultWorkflowNode('llm', 'llm-1')).toMatchObject({ id: 'llm-1', type: 'llm', prompt: '' });
    expect(createDefaultWorkflowNode('tool', 'tool-1')).toMatchObject({ id: 'tool-1', type: 'tool', service: '', action: '', params: {} });
    expect(createDefaultWorkflowNode('if', 'if-1')).toMatchObject({ id: 'if-1', type: 'if', conditions: [] });
    expect(createDefaultWorkflowNode('approval', 'approval-1')).toMatchObject({ id: 'approval-1', type: 'approval', prompt: '' });
    expect(createDefaultWorkflowNode('wait', 'wait-1')).toMatchObject({ id: 'wait-1', type: 'wait', mode: 'duration', duration: '5m' });
    expect(createDefaultWorkflowNode('set', 'set-1')).toMatchObject({ id: 'set-1', type: 'set', values: {} });
    expect(createDefaultWorkflowNode('foreach', 'foreach-1')).toMatchObject({ id: 'foreach-1', type: 'foreach', items: '', body: { type: 'set' } });
    expect(createDefaultWorkflowNode('orchestrator', 'orchestrator-1')).toMatchObject({ id: 'orchestrator-1', type: 'orchestrator', prompt: '' });
    expect(createDefaultWorkflowNode('session', 'session-1')).toMatchObject({ id: 'session-1', type: 'session', mode: 'start', prompt: '', workspace: '' });
    expect(createDefaultWorkflowNode('stop', 'stop-1')).toMatchObject({ id: 'stop-1', type: 'stop', outcome: 'success' });
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

  it('derives trigger output sources from trigger data schema and runtime envelope fields', () => {
    const definition: WorkflowDefinition = normalizeWorkflowDefinitionForEditor({
      version: 'dag/v1',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            issues: { type: 'array', description: 'Issues supplied by manual test run.' },
          },
        },
        { id: 'loop', type: 'foreach', items: '', body: { id: 'loop-body', type: 'set', values: {} } },
      ],
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
        label: 'Trigger data issues',
        expression: '{{trigger.data.issues}}',
        valueType: 'array',
      }),
    ]));
  });

  it('derives trigger data field sources from the trigger data schema', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            email: { type: 'string', description: 'Customer email' },
            issue_ids: { type: 'array', description: 'Issue ids' },
            profile: { type: 'object', description: 'Customer profile' },
          },
        },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, []);

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'trigger',
        label: 'Trigger data email',
        expression: '{{trigger.data.email}}',
        valueType: 'scalar',
      }),
      expect.objectContaining({
        nodeId: 'trigger',
        label: 'Trigger data issue_ids',
        expression: '{{trigger.data.issue_ids}}',
        valueType: 'array',
      }),
      expect.objectContaining({
        nodeId: 'trigger',
        label: 'Trigger data profile',
        expression: '{{trigger.data.profile}}',
        valueType: 'object',
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

    expect(sources).toContainEqual(
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
    );
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

  it('derives template outputs from set values and llm responses', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'normalize_input', type: 'set', values: { customer_name: '{{trigger.data.name}}', count: 1 } },
        {
          id: 'generate_welcome',
          type: 'llm',
          prompt: 'Write welcome email',
          model: 'anthropic:claude-opus-4-5',
        },
      ],
      edges: [{ from: 'normalize_input', to: 'generate_welcome' }],
    };

    const expressions = deriveWorkflowOutputSources(definition, []).map((source) => source.expression);

    expect(expressions).toContain('{{nodes.normalize_input.data.customer_name}}');
    expect(expressions).toContain('{{nodes.generate_welcome.data.response}}');
  });

  it('derives template outputs from orchestrator wait results', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'investigate', type: 'orchestrator', prompt: 'Investigate incident', wait: { mode: 'until_idle' }, resultMode: 'transcript' },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, []);
    const expressions = sources.map((source) => source.expression);

    expect(expressions).toContain('{{nodes.investigate.data.lastMessage}}');
    expect(expressions).toContain('{{nodes.investigate.data.lastMessage.content}}');
    expect(expressions).toContain('{{nodes.investigate.data.transcript}}');
    expect(sources.find((source) => source.expression === '{{nodes.investigate.data.transcript}}')?.valueType).toBe('array');
  });

  it('derives template outputs from structured orchestrator output schemas', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'investigate',
          type: 'orchestrator',
          prompt: 'Investigate incident',
          wait: { mode: 'until_idle' },
          outputSchema: {
            type: 'object',
            properties: {
              severity: { type: 'string' },
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    owner: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, []);

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'investigate',
        expression: '{{nodes.investigate.data.response}}',
        valueType: 'scalar',
      }),
      expect.objectContaining({
        nodeId: 'investigate',
        expression: '{{nodes.investigate.data.output.severity}}',
        label: 'investigate output.severity',
        valueType: 'scalar',
      }),
      expect.objectContaining({
        nodeId: 'investigate',
        expression: '{{nodes.investigate.data.output.actions}}',
        label: 'investigate output.actions',
        valueType: 'array',
        itemFields: [
          { name: 'label', path: ['nodes', 'investigate', 'data', 'output', 'actions', 'label'], valueType: 'string' },
          { name: 'owner', path: ['nodes', 'investigate', 'data', 'output', 'actions', 'owner'], valueType: 'string' },
        ],
      }),
    ]));
  });

  it('derives template outputs from session wait results', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'run_session', type: 'session', mode: 'start', prompt: 'Run tests', workspace: '/workspace', wait: { mode: 'until_idle' } },
      ],
      edges: [],
    };

    const expressions = deriveWorkflowOutputSources(definition, []).map((source) => source.expression);

    expect(expressions).toContain('{{nodes.run_session.data.sessionId}}');
    expect(expressions).toContain('{{nodes.run_session.data.threadId}}');
    expect(expressions).toContain('{{nodes.run_session.data.finalStatus}}');
    expect(expressions).toContain('{{nodes.run_session.data.waitStatus}}');
    expect(expressions).toContain('{{nodes.run_session.data.response}}');
  });

  it('derives template outputs from structured session output schemas', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'scrape_yc',
          type: 'session',
          mode: 'start',
          prompt: 'Scrape YC',
          workspace: 'yc-scraper',
          wait: { mode: 'until_idle' },
          outputSchema: {
            type: 'object',
            properties: {
              totalCount: { type: 'number' },
              companies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    website: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, []);

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'scrape_yc',
        expression: '{{nodes.scrape_yc.data.response}}',
        valueType: 'scalar',
      }),
      expect.objectContaining({
        nodeId: 'scrape_yc',
        expression: '{{nodes.scrape_yc.data.output.totalCount}}',
        label: 'scrape_yc output.totalCount',
        valueType: 'scalar',
      }),
      expect.objectContaining({
        nodeId: 'scrape_yc',
        expression: '{{nodes.scrape_yc.data.output.companies}}',
        label: 'scrape_yc output.companies',
        valueType: 'array',
        itemFields: [
          { name: 'name', path: ['nodes', 'scrape_yc', 'data', 'output', 'companies', 'name'], valueType: 'string' },
          { name: 'website', path: ['nodes', 'scrape_yc', 'data', 'output', 'companies', 'website'], valueType: 'string' },
        ],
      }),
    ]));
  });

  it('scopes template suggestions to transitive upstream nodes', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'normalize_input', type: 'set', values: { customer_name: '{{trigger.data.name}}' } },
        {
          id: 'generate_welcome',
          type: 'llm',
          prompt: 'Write welcome email',
          model: 'anthropic:claude-opus-4-5',
        },
        { id: 'cooldown', type: 'wait', mode: 'duration', duration: '5s' },
        { id: 'build_result', type: 'set', values: {} },
        { id: 'downstream', type: 'set', values: { ignored: 'later' } },
      ],
      edges: [
        { from: 'trigger', to: 'normalize_input' },
        { from: 'normalize_input', to: 'generate_welcome' },
        { from: 'generate_welcome', to: 'cooldown' },
        { from: 'cooldown', to: 'build_result' },
        { from: 'build_result', to: 'downstream' },
      ],
    };

    const expressions = deriveWorkflowTemplateSources(definition, [], 'build_result')
      .map((source) => source.expression);

    expect(expressions).toEqual(expect.arrayContaining([
      '{{trigger.data}}',
      '{{nodes.normalize_input.data.customer_name}}',
      '{{nodes.generate_welcome.data.response}}',
    ]));
    expect(expressions).not.toContain('{{nodes.downstream.data.ignored}}');
  });

  it('derives template outputs from structured llm output schemas', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'generate_digest',
          type: 'llm',
          prompt: 'Summarize pull requests',
          outputSchema: {
            type: 'object',
            properties: {
              digest: { type: 'string', description: 'Markdown digest' },
              priority_prs: {
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
          },
        },
      ],
      edges: [],
    };

    const sources = deriveWorkflowOutputSources(definition, []);

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'generate_digest',
        expression: '{{nodes.generate_digest.data.digest}}',
        label: 'generate_digest digest',
        valueType: 'scalar',
      }),
      expect.objectContaining({
        nodeId: 'generate_digest',
        expression: '{{nodes.generate_digest.data.priority_prs}}',
        label: 'generate_digest priority_prs',
        valueType: 'array',
        itemFields: [
          { name: 'number', path: ['nodes', 'generate_digest', 'data', 'priority_prs', 'number'], valueType: 'number' },
          { name: 'title', path: ['nodes', 'generate_digest', 'data', 'priority_prs', 'title'], valueType: 'string' },
        ],
      }),
    ]));
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
        nodeId: 'foreach-1',
        severity: 'warning',
        message: 'For each needs an array output from tool-1, but no typed array output is available.',
      },
    ]);
  });

  it('does not warn when foreach uses a typed array output through a branch edge', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'fetch_prs', type: 'tool', service: 'github', action: 'github.list_pull_requests', params: {} },
        {
          id: 'check_has_prs',
          type: 'if',
          conditions: [{ left: 'nodes.fetch_prs.data', dataType: 'array', operation: 'isNotEmpty' }],
        },
        {
          id: 'inspect_each_pr',
          type: 'foreach',
          items: '{{nodes.fetch_prs.data}}',
          body: { id: 'inspect_pr', type: 'set', values: {} },
        },
      ],
      edges: [
        { from: 'fetch_prs', to: 'check_has_prs' },
        { from: 'check_has_prs', to: 'inspect_each_pr', fromOutput: 'true' },
      ],
    };

    expect(validateWorkflowDataFlowEdges(definition, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.list_pull_requests',
        name: 'List Pull Requests',
        description: 'List pull requests',
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
    ])).toEqual([]);
  });

  it('does not warn about explicit foreach item templates while the tool catalog is loading', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'fetch_prs', type: 'tool', service: 'github', action: 'github.list_pull_requests', params: {} },
        {
          id: 'inspect_each_pr',
          type: 'foreach',
          items: '{{nodes.fetch_prs.data}}',
          body: { id: 'inspect_pr', type: 'set', values: {} },
        },
      ],
      edges: [{ from: 'fetch_prs', to: 'inspect_each_pr' }],
    };

    expect(validateWorkflowDataFlowEdges(definition, [], { toolCatalogLoaded: false })).toEqual([]);
  });

  it('builds edge inspection details with source outputs and target expectations', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'fetch_prs', type: 'tool', service: 'github', action: 'github.list_pull_requests', params: {} },
        {
          id: 'inspect_each_pr',
          type: 'foreach',
          items: '{{nodes.fetch_prs.data}}',
          body: { id: 'inspect_pr', type: 'set', values: {} },
        },
      ],
      edges: [{ from: 'fetch_prs', to: 'inspect_each_pr' }],
    };

    const inspection = buildWorkflowEdgeInspection(
      definition,
      { from: 'fetch_prs', to: 'inspect_each_pr' },
      [
        {
          service: 'github',
          serviceDisplayName: 'GitHub',
          actionId: 'github.list_pull_requests',
          name: 'List Pull Requests',
          description: 'List pull requests',
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
      ],
    );

    expect(inspection).toMatchObject({
      edgeId: 'fetch_prs->inspect_each_pr',
      fromNodeId: 'fetch_prs',
      toNodeId: 'inspect_each_pr',
      configuredExpression: '{{nodes.fetch_prs.data}}',
      targetExpectation: {
        label: 'For each item source',
        description: 'Requires a typed array output.',
        valueType: 'array',
      },
      sourceOutputs: [
        {
          expression: '{{nodes.fetch_prs.data}}',
          valueType: 'array',
          itemFields: [
            { name: 'number', path: ['nodes', 'fetch_prs', 'data', 'number'], valueType: 'number' },
            { name: 'title', path: ['nodes', 'fetch_prs', 'data', 'title'], valueType: 'string' },
          ],
        },
      ],
      warnings: [],
    });
  });

  it('derives foreach envelope output sources for downstream template fields', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'fetch_prs', type: 'tool', service: 'github', action: 'github.list_pull_requests', params: {} },
        {
          id: 'inspect_each_pr',
          type: 'foreach',
          items: '{{nodes.fetch_prs.data}}',
          body: {
            id: 'inspect_pr',
            type: 'tool',
            service: 'github',
            action: 'github.inspect_pull_request',
            params: {},
          },
        },
        {
          id: 'generate_digest',
          type: 'llm',
          prompt: 'Digest: {{nodes.inspect_each_pr.data}} {{nodes.inspect_each_pr.data.items}}',
        },
      ],
      edges: [
        { from: 'fetch_prs', to: 'inspect_each_pr' },
        { from: 'inspect_each_pr', to: 'generate_digest' },
      ],
    };

    const sources = deriveWorkflowTemplateSources(definition, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.list_pull_requests',
        name: 'List Pull Requests',
        description: 'List pull requests',
        riskLevel: 'low',
        outputSchema: { type: 'array', items: { type: 'object', properties: { number: { type: 'number' } } } },
      },
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.inspect_pull_request',
        name: 'Inspect Pull Request',
        description: 'Inspect a pull request',
        riskLevel: 'low',
        outputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } } } },
          },
        },
      },
    ], 'generate_digest');

    expect(sources.map((source) => source.expression)).toEqual(expect.arrayContaining([
      '{{nodes.inspect_each_pr.data}}',
      '{{nodes.inspect_each_pr.data.items}}',
      '{{nodes.inspect_each_pr.data.count}}',
      '{{nodes.inspect_each_pr.data.inputCount}}',
      '{{nodes.inspect_each_pr.data.truncatedCount}}',
      '{{nodes.inspect_each_pr.data.completedCount}}',
      '{{nodes.inspect_each_pr.data.failedCount}}',
      '{{nodes.inspect_each_pr.data.skippedCount}}',
    ]));
    expect(sources.find((source) => source.expression === '{{nodes.inspect_each_pr.data.items}}')).toMatchObject({
      valueType: 'array',
      itemFields: [
        { name: 'status', path: ['nodes', 'inspect_each_pr', 'data', 'items', 'status'], valueType: 'string' },
        { name: 'data', path: ['nodes', 'inspect_each_pr', 'data', 'items', 'data'], valueType: 'object' },
        { name: 'error', path: ['nodes', 'inspect_each_pr', 'data', 'items', 'error'], valueType: 'string' },
      ],
    });
  });

  it('builds edge inspection details for foreach source outputs', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'inspect_each_pr',
          type: 'foreach',
          items: '{{nodes.fetch_prs.data}}',
          body: { id: 'inspect_pr', type: 'set', values: { ok: true } },
        },
        { id: 'generate_digest', type: 'llm', prompt: '{{nodes.inspect_each_pr.data}}' },
      ],
      edges: [{ from: 'inspect_each_pr', to: 'generate_digest' }],
    };

    const inspection = buildWorkflowEdgeInspection(
      definition,
      { from: 'inspect_each_pr', to: 'generate_digest' },
      [],
    );

    expect(inspection?.sourceOutputs.map((source) => source.expression)).toEqual(expect.arrayContaining([
      '{{nodes.inspect_each_pr.data}}',
      '{{nodes.inspect_each_pr.data.items}}',
    ]));
  });

  it('includes edge validation warnings in inspection details', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'set', values: { message: 'hello' } },
        {
          id: 'loop',
          type: 'foreach',
          items: '',
          body: { id: 'loop-body', type: 'set', values: {} },
        },
      ],
      edges: [{ from: 'start', to: 'loop' }],
    };

    const inspection = buildWorkflowEdgeInspection(definition, { from: 'start', to: 'loop' }, []);

    expect(inspection?.targetExpectation?.valueType).toBe('array');
    expect(inspection?.warnings).toEqual([
      {
        edgeId: 'start->loop',
        nodeId: 'loop',
        severity: 'warning',
        message: 'For each needs an array output from start, but no typed array output is available.',
      },
    ]);
  });

  it('includes target tool input schemas in edge inspection details', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'config', type: 'set', values: { owner: 'tkhq', repo: 'valet' } },
        { id: 'fetch_prs', type: 'tool', service: 'github', action: 'github.list_pull_requests', params: {} },
      ],
      edges: [{ from: 'config', to: 'fetch_prs' }],
    };

    const inspection = buildWorkflowEdgeInspection(definition, { from: 'config', to: 'fetch_prs' }, [
      {
        service: 'github',
        serviceDisplayName: 'GitHub',
        actionId: 'github.list_pull_requests',
        name: 'List Pull Requests',
        description: 'List pull requests',
        riskLevel: 'low',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
          },
        },
      },
    ]);

    expect(inspection?.targetInputSchema).toEqual({
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
    });
  });

  it('formats template paths with bracket notation for unsafe path segments', () => {
    expect(formatWorkflowTemplatePath(['nodes', 'tool-1', 'data', 'pull_requests'])).toBe(
      '{{nodes["tool-1"].data.pull_requests}}',
    );
  });
});
