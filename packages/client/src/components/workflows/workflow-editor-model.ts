import type {
  ApprovalNode,
  ForeachBodyNode,
  ForeachNode,
  IfCondition,
  IfNode,
  LlmNode,
  OrchestratorNode,
  SessionNode,
  SetNode,
  StopNode,
  ToolNode,
  TriggerNode,
  WaitNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEditorState,
  WorkflowInputDefinition,
  WorkflowNode,
} from '@valet/shared';

export type DagNodeType = WorkflowNode['type'];
export type AddableDagNodeType = Exclude<DagNodeType, 'trigger'>;

export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkflowFlowNodeData {
  [key: string]: unknown;
  node: WorkflowNode;
  nodeType: DagNodeType;
  label: string;
  description: string;
  summary: string;
  handles: {
    target: boolean;
    source: boolean;
    sourceOutputs?: Array<'true' | 'false'>;
  };
}

export interface WorkflowFlowNode {
  id: string;
  type: 'workflow';
  position: { x: number; y: number };
  deletable?: boolean;
  data: WorkflowFlowNodeData;
}

export interface WorkflowFlowEdge {
  id: string;
  source: string;
  sourceHandle?: 'true' | 'false';
  target: string;
  type: 'animated' | 'temporary';
  label?: string;
  style?: {
    stroke: string;
    strokeWidth: number;
  };
  data: {
    fromOutput?: 'true' | 'false';
    when?: string;
  };
}

export interface WorkflowFlowState {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  viewport?: FlowViewport;
}

export interface ToolCatalogAction {
  service: string;
  serviceDisplayName: string;
  actionId: string;
  name: string;
  description: string;
  riskLevel: string;
  inputSchema?: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
}

export interface ToolCatalogService {
  service: string;
  serviceDisplayName: string;
  actionCount: number;
}

export interface WorkflowOutputSource {
  nodeId: string;
  nodeLabel: string;
  actionName: string;
  path: string[];
  expression: string;
  label: string;
  valueType: 'array' | 'object' | 'scalar';
  itemFields?: WorkflowSchemaField[];
}

export interface WorkflowSchemaField {
  name: string;
  path: string[];
  valueType: string;
  description?: string;
}

export interface WorkflowDataFlowWarning {
  edgeId: string;
  nodeId: string;
  severity: 'warning' | 'error';
  message: string;
}

export interface WorkflowDataFlowValidationOptions {
  toolCatalogLoaded?: boolean;
}

export interface WorkflowEdgeTargetExpectation {
  label: string;
  description: string;
  valueType: WorkflowOutputSource['valueType'];
}

export interface WorkflowEdgeInspection {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  fromOutput?: 'true' | 'false';
  sourceOutputs: WorkflowOutputSource[];
  configuredExpression?: string;
  matchedSource?: WorkflowOutputSource;
  targetExpectation?: WorkflowEdgeTargetExpectation;
  targetInputSchema?: JsonSchemaLike;
  warnings: WorkflowDataFlowWarning[];
}

export interface JsonSchemaLike {
  [key: string]: unknown;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike | JsonSchemaLike[];
}

const WORKFLOW_SCHEMA_FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const satisfies readonly WorkflowInputDefinition['type'][];

export function buildToolCatalogIndex(actions: ToolCatalogAction[]): {
  services: ToolCatalogService[];
  actionsByService: Map<string, ToolCatalogAction[]>;
  actionsByKey: Map<string, ToolCatalogAction>;
} {
  const actionsByService = new Map<string, ToolCatalogAction[]>();
  const actionsByKey = new Map<string, ToolCatalogAction>();
  const displayNames = new Map<string, string>();

  for (const action of actions) {
    actionsByKey.set(createToolCatalogActionKey(action.service, action.actionId), action);
    displayNames.set(action.service, action.serviceDisplayName || action.service);
    const list = actionsByService.get(action.service) ?? [];
    list.push(action);
    actionsByService.set(action.service, list);
  }

  for (const [service, list] of actionsByService) {
    actionsByService.set(
      service,
      [...list].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  const services = [...actionsByService.entries()]
    .map(([service, list]) => ({
      service,
      serviceDisplayName: displayNames.get(service) ?? service,
      actionCount: list.length,
    }))
    .sort((left, right) => left.serviceDisplayName.localeCompare(right.serviceDisplayName));

  return { services, actionsByService, actionsByKey };
}

export function deriveWorkflowOutputSources(
  definition: Pick<WorkflowDefinition, 'nodes'>,
  actions: ToolCatalogAction[],
): WorkflowOutputSource[] {
  const catalogIndex = buildToolCatalogIndex(actions);
  const sources: WorkflowOutputSource[] = deriveTriggerOutputSources(definition);

  for (const node of definition.nodes) {
    if (node.type === 'set') {
      sources.push(...deriveSetOutputSources(node));
      continue;
    }

    if (node.type === 'llm') {
      sources.push(...deriveLlmOutputSources(node));
      continue;
    }

    if (node.type === 'orchestrator') {
      sources.push(...deriveOrchestratorOutputSources(node));
      continue;
    }

    if (node.type === 'session') {
      sources.push(...deriveSessionOutputSources(node));
      continue;
    }

    if (node.type === 'foreach') {
      sources.push(...deriveForeachOutputSources(node, catalogIndex.actionsByKey));
      continue;
    }

    if (node.type !== 'tool') continue;
    const action = catalogIndex.actionsByKey.get(createToolCatalogActionKey(node.service, node.action));
    if (!action?.outputSchema) continue;

    sources.push(...deriveSchemaOutputSources({
      schema: action.outputSchema,
      basePath: ['nodes', node.id, 'data'],
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: action.name,
    }));
  }

  return sources;
}

export function deriveWorkflowTemplateSources(
  definition: WorkflowDefinition,
  actions: ToolCatalogAction[],
  nodeId: string,
): WorkflowOutputSource[] {
  const upstreamNodeIds = deriveTransitiveUpstreamNodeIds(definition, nodeId);
  return deriveWorkflowOutputSources(definition, actions).filter((source) =>
    source.nodeId === 'trigger' || upstreamNodeIds.has(source.nodeId),
  );
}

export function formatWorkflowTemplatePath(path: string[]): string {
  return `{{${formatWorkflowPath(path)}}}`;
}

export function applyDefaultDataFlowForConnection(
  definition: WorkflowDefinition,
  edge: Pick<WorkflowEdge, 'from' | 'to'>,
  actions: ToolCatalogAction[],
): WorkflowDefinition {
  const target = definition.nodes.find((node) => node.id === edge.to);
  if (target?.type !== 'foreach' || target.items.trim().length > 0) return definition;

  const sources = deriveWorkflowOutputSources(definition, actions)
    .filter((source) => source.nodeId === edge.from && source.valueType === 'array');
  if (sources.length !== 1) return definition;

  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.id === target.id && node.type === 'foreach'
        ? { ...node, items: sources[0]!.expression }
        : node,
    ),
  };
}

export function validateWorkflowDataFlowEdges(
  definition: WorkflowDefinition,
  actions: ToolCatalogAction[],
  options: WorkflowDataFlowValidationOptions = {},
): WorkflowDataFlowWarning[] {
  const toolCatalogLoaded = options.toolCatalogLoaded ?? true;
  const sources = deriveWorkflowOutputSources(definition, actions);
  const warnings: WorkflowDataFlowWarning[] = [];
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));

  for (const edge of definition.edges) {
    const target = nodesById.get(edge.to);
    if (target?.type !== 'foreach') continue;

    const configuredItems = normalizeTemplateReference(target.items);
    if (configuredItems.length > 0) {
      const configuredArraySource = sources.find((source) =>
        source.valueType === 'array' && normalizeTemplateReference(source.expression) === configuredItems,
      );
      if (configuredArraySource) continue;
      if (!toolCatalogLoaded && configuredItems.startsWith('nodes.')) continue;
      warnings.push({
        edgeId: createEdgeId(edge.from, edge.to, edge.fromOutput),
        nodeId: target.id,
        severity: 'warning',
        message: `For each uses ${target.items}, but it is not a typed array output.`,
      });
      continue;
    }

    const upstreamArraySources = sources.filter((source) =>
      source.nodeId === edge.from && source.valueType === 'array',
    );
    if (upstreamArraySources.length === 0) {
      warnings.push({
        edgeId: createEdgeId(edge.from, edge.to, edge.fromOutput),
        nodeId: target.id,
        severity: 'warning',
        message: `For each needs an array output from ${edge.from}, but no typed array output is available.`,
      });
    }
  }

  return warnings;
}

export function buildWorkflowEdgeInspection(
  definition: WorkflowDefinition,
  edge: Pick<WorkflowEdge, 'from' | 'to' | 'fromOutput'>,
  actions: ToolCatalogAction[],
  options: WorkflowDataFlowValidationOptions = {},
): WorkflowEdgeInspection | null {
  const edgeId = createEdgeId(edge.from, edge.to, edge.fromOutput);
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const target = nodesById.get(edge.to);
  if (!nodesById.has(edge.from) || !target) return null;

  const catalogIndex = buildToolCatalogIndex(actions);
  const sources = deriveWorkflowOutputSources(definition, actions);
  const sourceOutputs = sources.filter((source) => source.nodeId === edge.from);
  const warnings = validateWorkflowDataFlowEdges(definition, actions, options)
    .filter((warning) => warning.edgeId === edgeId);
  const configuredExpression = getTargetConfiguredInputExpression(target);
  const matchedSource = configuredExpression
    ? sourceOutputs.find((source) => normalizeTemplateReference(source.expression) === normalizeTemplateReference(configuredExpression))
    : undefined;
  const targetExpectation = getTargetExpectation(target);
  const targetInputSchema = getTargetInputSchema(target, catalogIndex.actionsByKey);

  return {
    edgeId,
    fromNodeId: edge.from,
    toNodeId: edge.to,
    ...(edge.fromOutput ? { fromOutput: edge.fromOutput } : {}),
    sourceOutputs,
    ...(configuredExpression ? { configuredExpression } : {}),
    ...(matchedSource ? { matchedSource } : {}),
    ...(targetExpectation ? { targetExpectation } : {}),
    ...(targetInputSchema ? { targetInputSchema } : {}),
    warnings,
  };
}

export const NODE_LABELS: Record<DagNodeType, string> = {
  trigger: 'Trigger',
  llm: 'LLM',
  tool: 'Tool',
  if: 'If',
  foreach: 'For each',
  approval: 'Approval',
  wait: 'Wait',
  set: 'Set values',
  stop: 'Stop',
  orchestrator: 'Orchestrator',
  session: 'Session',
};

export const NODE_DESCRIPTIONS: Record<DagNodeType, string> = {
  trigger: 'Where the workflow starts and what data it receives',
  llm: 'Generate or transform text with a model',
  tool: 'Call an integration action',
  if: 'Branch based on conditions',
  foreach: 'Run one body node for every item',
  approval: 'Pause for human approval',
  wait: 'Pause for a fixed duration',
  set: 'Create values for downstream nodes',
  stop: 'Finish the workflow',
  orchestrator: 'Ask the user orchestrator to do work',
  session: 'Start or prompt a coding session',
};

export const NODE_TYPE_OPTIONS: Array<{ type: AddableDagNodeType; label: string; description: string }> = [
  { type: 'llm', label: NODE_LABELS.llm, description: NODE_DESCRIPTIONS.llm },
  { type: 'tool', label: NODE_LABELS.tool, description: NODE_DESCRIPTIONS.tool },
  { type: 'if', label: NODE_LABELS.if, description: NODE_DESCRIPTIONS.if },
  { type: 'foreach', label: NODE_LABELS.foreach, description: NODE_DESCRIPTIONS.foreach },
  { type: 'approval', label: NODE_LABELS.approval, description: NODE_DESCRIPTIONS.approval },
  { type: 'wait', label: NODE_LABELS.wait, description: NODE_DESCRIPTIONS.wait },
  { type: 'set', label: NODE_LABELS.set, description: NODE_DESCRIPTIONS.set },
  { type: 'orchestrator', label: NODE_LABELS.orchestrator, description: NODE_DESCRIPTIONS.orchestrator },
  { type: 'session', label: NODE_LABELS.session, description: NODE_DESCRIPTIONS.session },
  { type: 'stop', label: NODE_LABELS.stop, description: NODE_DESCRIPTIONS.stop },
];

export interface NodePaletteSection {
  id: string;
  label: string;
  description: string;
  icon: 'ai' | 'app' | 'data' | 'flow' | 'human';
  types: AddableDagNodeType[];
}

export const NODE_PALETTE_SECTIONS: NodePaletteSection[] = [
  {
    id: 'ai',
    label: 'AI',
    description: 'Build autonomous agents, summarize, or search documents.',
    icon: 'ai',
    types: ['llm', 'orchestrator', 'session'],
  },
  {
    id: 'app',
    label: 'Action in an app',
    description: 'Do something in an app or service like GitHub or Slack.',
    icon: 'app',
    types: ['tool'],
  },
  {
    id: 'data',
    label: 'Data transformation',
    description: 'Manipulate, filter, or convert data.',
    icon: 'data',
    types: ['set'],
  },
  {
    id: 'flow',
    label: 'Flow',
    description: 'Branch, loop, pause, or finish the workflow.',
    icon: 'flow',
    types: ['if', 'foreach', 'wait', 'stop'],
  },
  {
    id: 'human',
    label: 'Human in the loop',
    description: 'Wait for approval or human input before continuing.',
    icon: 'human',
    types: ['approval'],
  },
];

export interface NodePaletteResult {
  section: NodePaletteSection;
  options: Array<{ type: AddableDagNodeType; label: string; description: string }>;
}

export const NODE_PALETTE_PANEL_CLASSNAME =
  'mt-16 flex max-h-[calc(100dvh-10rem)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-950/15 dark:border-neutral-800 dark:bg-neutral-950 dark:shadow-black/40';

export const NODE_PALETTE_LIST_CLASSNAME = 'min-h-0 flex-1 overflow-y-auto p-2';

export function filterNodePaletteOptions(query: string): NodePaletteResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const optionsByType = new Map(NODE_TYPE_OPTIONS.map((option) => [option.type, option]));

  return NODE_PALETTE_SECTIONS
    .map((section) => {
      const options = section.types
        .map((type) => optionsByType.get(type))
        .filter((option): option is { type: AddableDagNodeType; label: string; description: string } => {
          if (!option) return false;
          if (!normalizedQuery) return true;
          const searchable = `${section.label} ${section.description} ${option.label} ${option.description} ${option.type}`.toLowerCase();
          return searchable.includes(normalizedQuery);
        });
      return { section, options };
    })
    .filter((result) => result.options.length > 0);
}

export function createDefaultWorkflowDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
      },
      {
        id: 'start',
        type: 'set',
        values: {},
      },
    ],
    edges: [{ from: 'trigger', to: 'start' }],
    ui: {
      nodes: {
        trigger: { position: { x: -320, y: 0 } },
        start: { position: { x: 0, y: 0 } },
      },
    },
  };
}

export function getDefaultNodeForType(type: DagNodeType, id: string): WorkflowNode {
  switch (type) {
    case 'trigger':
      return { id, type } satisfies TriggerNode;
    case 'llm':
      return { id, type, prompt: '' } satisfies LlmNode;
    case 'tool':
      return { id, type, service: '', action: '', params: {} } satisfies ToolNode;
    case 'if':
      return { id, type, conditions: [] } satisfies IfNode;
    case 'foreach':
      return {
        id,
        type,
        items: '',
        body: { id: `${id}-body`, type: 'set', values: {} } satisfies ForeachBodyNode,
      } satisfies ForeachNode;
    case 'approval':
      return { id, type, prompt: '' } satisfies ApprovalNode;
    case 'wait':
      return { id, type, mode: 'duration', duration: '5m' } satisfies WaitNode;
    case 'set':
      return { id, type, values: {} } satisfies SetNode;
    case 'orchestrator':
      return { id, type, prompt: '' } satisfies OrchestratorNode;
    case 'session':
      return { id, type, mode: 'start', prompt: '', workspace: '' } satisfies SessionNode;
    case 'stop':
      return { id, type, outcome: 'success' } satisfies StopNode;
  }
}

export function normalizeWorkflowDefinitionForEditor(definition: WorkflowDefinition): WorkflowDefinition {
  if (definition.nodes.some((node) => node.type === 'trigger')) return definition;

  const incomingCount = countIncomingEdges(definition.edges);
  const rootNodes = definition.nodes.filter((node) => (incomingCount.get(node.id) ?? 0) === 0);
  const firstRoot = rootNodes[0] ?? definition.nodes[0];
  const rootY = firstRoot ? definition.ui?.nodes?.[firstRoot.id]?.position.y ?? 0 : 0;
  const rootX = firstRoot ? definition.ui?.nodes?.[firstRoot.id]?.position.x ?? 0 : 0;

  return {
    ...definition,
    nodes: [
      { id: 'trigger', type: 'trigger' } satisfies TriggerNode,
      ...definition.nodes,
    ],
    edges: [
      ...definition.edges,
      ...rootNodes.map((node) => ({ from: 'trigger', to: node.id })),
    ],
    ui: {
      ...definition.ui,
      nodes: {
        trigger: { position: { x: rootX - 340, y: rootY } },
        ...(definition.ui?.nodes ?? {}),
      },
    },
  };
}

export function definitionToFlow(definition: WorkflowDefinition): WorkflowFlowState {
  const normalized = normalizeWorkflowDefinitionForEditor(definition);
  const incomingCount = countIncomingEdges(normalized.edges);
  const outgoingCount = countOutgoingEdges(normalized.edges);
  const defaultPositions = layoutWorkflowNodes(normalized);
  return {
    nodes: normalized.nodes.map((node, index) => {
      const savedPosition = normalized.ui?.nodes?.[node.id]?.position;
      return {
        id: node.id,
        type: 'workflow',
        position: savedPosition ?? defaultPositions.get(node.id) ?? { x: index * LAYOUT_COLUMN_GAP, y: 0 },
        ...(node.type === 'trigger' ? { deletable: false } : {}),
        data: createFlowNodeData(node, {
          hasIncoming: (incomingCount.get(node.id) ?? 0) > 0,
          hasOutgoing: (outgoingCount.get(node.id) ?? 0) > 0,
        }),
      };
    }),
    edges: normalized.edges.map(workflowEdgeToFlowEdge),
    viewport: normalized.ui?.viewport,
  };
}

export function flowToDefinition(
  flow: WorkflowFlowState,
  previous?: Pick<WorkflowDefinition, 'policy'>,
): WorkflowDefinition {
  const ui: WorkflowEditorState = {
    nodes: Object.fromEntries(
      flow.nodes.map((node) => [node.id, { position: node.position }]),
    ),
    ...(flow.viewport ? { viewport: flow.viewport } : {}),
  };

  return {
    version: 'dag/v1',
    nodes: flow.nodes.map((node) => ({ ...node.data.node, id: node.id })),
    edges: flow.edges.map(flowEdgeToWorkflowEdge),
    ...(previous?.policy ? { policy: previous.policy } : {}),
    ui,
  };
}

export function removeWorkflowFlowNode(
  flow: WorkflowFlowState,
  nodeId: string,
): WorkflowFlowState {
  if (nodeId === 'trigger' || !flow.nodes.some((node) => node.id === nodeId)) return flow;

  return {
    ...flow,
    nodes: flow.nodes.filter((node) => node.id !== nodeId),
    edges: flow.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  };
}

export function createFlowNodeData(
  node: WorkflowNode,
  connectivity: { hasIncoming: boolean; hasOutgoing: boolean } = { hasIncoming: true, hasOutgoing: true },
): WorkflowFlowNodeData {
  return {
    node,
    nodeType: node.type,
    label: NODE_LABELS[node.type],
    description: NODE_DESCRIPTIONS[node.type],
    summary: summarizeNode(node),
    handles: {
      target: node.type === 'trigger' ? false : connectivity.hasIncoming || node.id !== 'start',
      source: node.type !== 'stop',
      ...(node.type === 'if' ? { sourceOutputs: ['true', 'false'] as Array<'true' | 'false'> } : {}),
    },
  };
}

export function updateWorkflowNode(
  flowNode: WorkflowFlowNode,
  patch: Partial<WorkflowNode>,
): WorkflowFlowNode {
  const nextNode = {
    ...flowNode.data.node,
    ...patch,
    id: flowNode.id,
    type: flowNode.data.node.type,
  } as WorkflowNode;

  return {
    ...flowNode,
    data: createFlowNodeData(nextNode, {
      hasIncoming: flowNode.data.handles.target,
      hasOutgoing: flowNode.data.handles.source,
    }),
  };
}

export function createWorkflowInputPatchForNode(
  node: WorkflowNode,
  source: WorkflowOutputSource,
): Partial<WorkflowNode> | null {
  switch (node.type) {
    case 'set':
      return {
        values: {
          ...asRecord(node.values),
          [createUniqueRecordKey(source.label, asRecord(node.values))]: source.expression,
        },
      } satisfies Partial<SetNode>;
    case 'tool':
      return {
        params: {
          ...node.params,
          [createUniqueRecordKey(source.label, node.params)]: source.expression,
        },
      } satisfies Partial<ToolNode>;
    case 'if': {
      const nextCondition = {
        left: source.expression,
        dataType: sourceToConditionDataType(source),
        operation: 'equals',
        right: '',
      } satisfies IfCondition;
      const blankIndex = node.conditions.findIndex((condition) => condition.left.trim().length === 0);
      return {
        conditions: blankIndex >= 0
          ? node.conditions.map((condition, index) => index === blankIndex ? { ...condition, ...nextCondition } : condition)
          : [...node.conditions, nextCondition],
      } satisfies Partial<IfNode>;
    }
    case 'foreach':
      return source.valueType === 'array'
        ? ({ items: source.expression } satisfies Partial<ForeachNode>)
        : null;
    case 'llm':
      return { prompt: appendExpression(node.prompt, source.expression) } satisfies Partial<LlmNode>;
    case 'approval':
      return { prompt: appendExpression(node.prompt, source.expression) } satisfies Partial<ApprovalNode>;
    case 'orchestrator':
      return { prompt: appendExpression(node.prompt, source.expression) } satisfies Partial<OrchestratorNode>;
    case 'session':
      return { prompt: appendExpression(node.prompt, source.expression) } satisfies Partial<SessionNode>;
    case 'stop':
      return { output: source.expression } satisfies Partial<StopNode>;
    case 'wait':
    case 'trigger':
      return null;
  }
}

export function createNodeId(type: DagNodeType, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let index = 1;
  let candidate = `${type}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${type}-${index}`;
  }
  return candidate;
}

export function workflowEdgeToFlowEdge(edge: WorkflowEdge): WorkflowFlowEdge {
  const conditional = edge.fromOutput === 'true' || edge.fromOutput === 'false';
  return {
    id: createEdgeId(edge.from, edge.to, edge.fromOutput),
    source: edge.from,
    ...(edge.fromOutput ? { sourceHandle: edge.fromOutput } : {}),
    target: edge.to,
    type: conditional || edge.when ? 'temporary' : 'animated',
    style: {
      stroke: conditional || edge.when ? 'var(--workflow-edge-branch-stroke)' : 'var(--workflow-edge-stroke)',
      strokeWidth: 2,
    },
    ...(edge.fromOutput ? { label: edge.fromOutput } : edge.when ? { label: 'when' } : {}),
    data: {
      ...(edge.fromOutput ? { fromOutput: edge.fromOutput } : {}),
      ...(edge.when ? { when: edge.when } : {}),
    },
  };
}

export function flowEdgeToWorkflowEdge(edge: WorkflowFlowEdge): WorkflowEdge {
  const fromOutput = edge.data.fromOutput ?? edge.sourceHandle;
  return {
    from: edge.source,
    to: edge.target,
    ...(fromOutput ? { fromOutput } : {}),
    ...(edge.data.when ? { when: edge.data.when } : {}),
  };
}

export function createEdgeId(from: string, to: string, fromOutput?: 'true' | 'false'): string {
  return `${from}${fromOutput ? `:${fromOutput}` : ''}->${to}`;
}

export const LAYOUT_COLUMN_GAP = 340;
export const LAYOUT_ROW_GAP = 140;

function layoutWorkflowNodes(definition: WorkflowDefinition): Map<string, { x: number; y: number }> {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const nodeOrder = new Map(definition.nodes.map((node, index) => [node.id, index]));
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();

  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  const depths = computeLayoutDepths(definition.nodes, incoming, outgoing);
  const rawPositions = new Map<string, { x: number; y: number }>();
  const maxDepth = Math.max(0, ...depths.values());

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const depthNodes = definition.nodes
      .filter((node) => (depths.get(node.id) ?? 0) === depth)
      .sort((left, right) => (nodeOrder.get(left.id) ?? 0) - (nodeOrder.get(right.id) ?? 0));

    for (const node of depthNodes) {
      const inbound = incoming.get(node.id) ?? [];
      const y = inbound.length > 0
        ? average(inbound.map((edge) => {
            const parent = rawPositions.get(edge.from);
            const parentY = parent?.y ?? 0;
            if (edge.fromOutput === 'true') return parentY - LAYOUT_ROW_GAP;
            if (edge.fromOutput === 'false') return parentY + LAYOUT_ROW_GAP;
            return parentY;
          }))
        : 0;

      rawPositions.set(node.id, { x: depth * LAYOUT_COLUMN_GAP, y });
    }

    spreadOverlappingDepthNodes(rawPositions, depthNodes.map((node) => node.id));
  }

  return rawPositions;
}

function computeLayoutDepths(
  nodes: WorkflowNode[],
  incoming: Map<string, WorkflowEdge[]>,
  outgoing: Map<string, WorkflowEdge[]>,
): Map<string, number> {
  const depths = new Map<string, number>();
  const remainingIncoming = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue = nodes.filter((node) => (remainingIncoming.get(node.id) ?? 0) === 0).map((node) => node.id);

  for (const id of queue) depths.set(id, 0);

  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const nextDepth = (depths.get(id) ?? 0) + 1;
    for (const edge of outgoing.get(id) ?? []) {
      depths.set(edge.to, Math.max(depths.get(edge.to) ?? 0, nextDepth));
      const nextRemaining = (remainingIncoming.get(edge.to) ?? 0) - 1;
      remainingIncoming.set(edge.to, nextRemaining);
      if (nextRemaining === 0) queue.push(edge.to);
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (depths.has(node.id)) continue;
    const parentDepths = (incoming.get(node.id) ?? [])
      .map((edge) => depths.get(edge.from))
      .filter((depth): depth is number => depth !== undefined);
    depths.set(node.id, parentDepths.length > 0 ? Math.max(...parentDepths) + 1 : index);
  }

  return depths;
}

function spreadOverlappingDepthNodes(positions: Map<string, { x: number; y: number }>, nodeIds: string[]): void {
  const groups = new Map<number, string[]>();
  for (const id of nodeIds) {
    const position = positions.get(id);
    if (!position) continue;
    groups.set(position.y, [...(groups.get(position.y) ?? []), id]);
  }

  for (const [y, ids] of groups) {
    if (ids.length <= 1) continue;
    const start = y - ((ids.length - 1) * LAYOUT_ROW_GAP) / 2;
    ids.forEach((id, index) => {
      const position = positions.get(id);
      if (!position) return;
      positions.set(id, { ...position, y: start + index * LAYOUT_ROW_GAP });
    });
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countIncomingEdges(edges: WorkflowEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  return counts;
}

function countOutgoingEdges(edges: WorkflowEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
  return counts;
}

function summarizeNode(node: WorkflowNode): string {
  switch (node.type) {
    case 'llm':
      return trimSummary(node.prompt || node.model || 'No prompt configured');
    case 'trigger':
      return 'Where the workflow starts and what data it receives';
    case 'tool':
      return trimSummary(node.service && node.action ? `${node.service}.${node.action}` : 'No action configured');
    case 'if':
      return `${node.conditions.length} condition${node.conditions.length === 1 ? '' : 's'}`;
    case 'foreach':
      return trimSummary(node.items || 'No item expression configured');
    case 'approval':
      return trimSummary(node.summary || node.prompt || 'No prompt configured');
    case 'wait':
      return node.duration;
    case 'set':
      return `${Object.keys(asRecord(node.values)).length} value${Object.keys(asRecord(node.values)).length === 1 ? '' : 's'}`;
    case 'orchestrator':
      return trimSummary(node.prompt || 'No prompt configured');
    case 'session':
      return trimSummary(node.prompt || (node.mode === 'prompt' ? node.sessionId : node.workspace) || 'No prompt configured');
    case 'stop':
      return trimSummary(node.message || node.outcome || 'success');
  }
}

function deriveTriggerOutputSources(definition: Pick<WorkflowDefinition, 'nodes'>): WorkflowOutputSource[] {
  const triggerNode = definition.nodes.find((node) => node.type === 'trigger');
  if (!triggerNode) return [];

  const sources: WorkflowOutputSource[] = [
    createManualWorkflowOutputSource({
      nodeId: 'trigger',
      nodeLabel: 'Trigger',
      actionName: 'Workflow trigger',
      path: ['trigger', 'data'],
      label: 'Trigger data',
      valueType: 'object',
    }),
    createManualWorkflowOutputSource({
      nodeId: 'trigger',
      nodeLabel: 'Trigger',
      actionName: 'Workflow trigger',
      path: ['trigger', 'metadata'],
      label: 'Trigger metadata',
      valueType: 'object',
    }),
    createManualWorkflowOutputSource({
      nodeId: 'trigger',
      nodeLabel: 'Trigger',
      actionName: 'Workflow trigger',
      path: ['trigger', 'type'],
      label: 'Trigger type',
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: 'trigger',
      nodeLabel: 'Trigger',
      actionName: 'Workflow trigger',
      path: ['trigger', 'timestamp'],
      label: 'Trigger timestamp',
      valueType: 'scalar',
    }),
  ];

  for (const [name, field] of Object.entries(triggerNode.dataSchema ?? {})) {
    sources.push(createManualWorkflowOutputSource({
      nodeId: 'trigger',
      nodeLabel: 'Trigger',
      actionName: 'Trigger data',
      path: ['trigger', 'data', name],
      label: `Trigger data ${name}`,
      valueType: workflowInputTypeToOutputType(field.type),
    }));
  }

  return sources;
}

function deriveSetOutputSources(node: SetNode): WorkflowOutputSource[] {
  return Object.entries(asRecord(node.values)).map(([key, value]) =>
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Set value',
      path: ['nodes', node.id, 'data', key],
      label: `${node.id} ${key}`,
      valueType: unknownToOutputType(value),
    }),
  );
}

function deriveLlmOutputSources(node: LlmNode): WorkflowOutputSource[] {
  if (node.outputSchema) {
    const schema = node.outputSchema as JsonSchemaLike;
    const schemaSources = deriveLlmSchemaOutputSources({
      schema,
      basePath: ['nodes', node.id, 'data'],
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'LLM response',
    });
    if (schemaSources.length > 0) return schemaSources;
  }

  return [
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'LLM response',
      path: ['nodes', node.id, 'data', 'response'],
      label: `${node.id} response`,
      valueType: 'scalar',
    }),
  ];
}

export function workflowInputDefinitionsToJsonSchema(
  definitions: Record<string, WorkflowInputDefinition>,
): JsonSchemaLike | undefined {
  const properties = workflowInputDefinitionsToJsonSchemaProperties(definitions);
  const required = Object.entries(definitions)
    .filter(([, definition]) => definition.required)
    .map(([name]) => name);

  if (Object.keys(properties).length === 0) return undefined;

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function workflowInputDefinitionsToJsonSchemaProperties(
  definitions: Record<string, WorkflowInputDefinition>,
): Record<string, JsonSchemaLike> {
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [
    name,
    {
      type: definition.type,
      ...(definition.description ? { description: definition.description } : {}),
    } satisfies JsonSchemaLike,
  ]));
}

export function jsonSchemaToWorkflowInputDefinitions(
  schema: Record<string, unknown> | JsonSchemaLike | undefined,
): Record<string, WorkflowInputDefinition> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};

  const properties = asRecord(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : []);

  return Object.fromEntries(Object.entries(properties).flatMap(([name, rawField]) => {
    const field = asRecord(rawField);
    const type = normalizeJsonSchemaFieldType(field.type);
    if (!type) return [];

    return [[
      name,
      {
        type,
        ...(required.has(name) ? { required: true } : {}),
        ...(typeof field.description === 'string' && field.description.trim().length > 0 ? { description: field.description } : {}),
      } satisfies WorkflowInputDefinition,
    ]];
  }));
}

function deriveOrchestratorOutputSources(node: OrchestratorNode): WorkflowOutputSource[] {
  if (node.wait?.mode !== 'until_idle') return [];

  const sources = [
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Orchestrator result',
      path: ['nodes', node.id, 'data', 'lastMessage'],
      label: `${node.id} last message`,
      valueType: 'object',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Orchestrator result',
      path: ['nodes', node.id, 'data', 'lastMessage', 'content'],
      label: `${node.id} last message content`,
      valueType: 'scalar',
    }),
  ];

  if (node.resultMode === 'transcript') {
    sources.push(createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Orchestrator result',
      path: ['nodes', node.id, 'data', 'transcript'],
      label: `${node.id} transcript`,
      valueType: 'array',
    }));
  }

  return sources;
}

function deriveSessionOutputSources(node: SessionNode): WorkflowOutputSource[] {
  const sources: WorkflowOutputSource[] = [
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Session result',
      path: ['nodes', node.id, 'data'],
      label: `${node.id} result`,
      valueType: 'object',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Session result',
      path: ['nodes', node.id, 'data', 'sessionId'],
      label: `${node.id} session ID`,
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'Session result',
      path: ['nodes', node.id, 'data', 'threadId'],
      label: `${node.id} thread ID`,
      valueType: 'scalar',
    }),
  ];

  if (node.wait?.mode === 'until_idle') {
    sources.push(
      createManualWorkflowOutputSource({
        nodeId: node.id,
        nodeLabel: NODE_LABELS[node.type],
        actionName: 'Session result',
        path: ['nodes', node.id, 'data', 'finalStatus'],
        label: `${node.id} final status`,
        valueType: 'scalar',
      }),
      createManualWorkflowOutputSource({
        nodeId: node.id,
        nodeLabel: NODE_LABELS[node.type],
        actionName: 'Session result',
        path: ['nodes', node.id, 'data', 'waitStatus'],
        label: `${node.id} wait status`,
        valueType: 'scalar',
      }),
    );
  }

  return sources;
}

function deriveForeachOutputSources(
  node: ForeachNode,
  actionsByKey: Map<string, ToolCatalogAction>,
): WorkflowOutputSource[] {
  const itemDataSchema = getForeachBodyOutputSchema(node.body, actionsByKey);
  const itemSchema: JsonSchemaLike = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Iteration status: completed, skipped, or failed.',
      },
      data: itemDataSchema ?? {
        type: 'object',
        description: 'Output produced by the foreach body node for this item.',
      },
      error: {
        type: 'string',
        description: 'Error message when the item failed or was skipped.',
      },
    },
  };
  const itemsSchema: JsonSchemaLike = {
    type: 'array',
    items: itemSchema,
  };

  return [
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data'],
      label: `${node.id} result`,
      valueType: 'object',
    }),
    createWorkflowOutputSource(
      {
        nodeId: node.id,
        nodeLabel: NODE_LABELS[node.type],
        actionName: 'For each result',
      },
      ['nodes', node.id, 'data', 'items'],
      'array',
      itemsSchema,
    ),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data', 'count'],
      label: `${node.id} count`,
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data', 'inputCount'],
      label: `${node.id} input count`,
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data', 'truncatedCount'],
      label: `${node.id} truncated count`,
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data', 'completedCount'],
      label: `${node.id} completed count`,
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data', 'skippedCount'],
      label: `${node.id} skipped count`,
      valueType: 'scalar',
    }),
    createManualWorkflowOutputSource({
      nodeId: node.id,
      nodeLabel: NODE_LABELS[node.type],
      actionName: 'For each result',
      path: ['nodes', node.id, 'data', 'failedCount'],
      label: `${node.id} failed count`,
      valueType: 'scalar',
    }),
  ];
}

function getForeachBodyOutputSchema(
  body: ForeachBodyNode,
  actionsByKey: Map<string, ToolCatalogAction>,
): JsonSchemaLike | undefined {
  if (body.type === 'tool') {
    return actionsByKey.get(createToolCatalogActionKey(body.service, body.action))?.outputSchema;
  }

  if (body.type === 'llm') {
    if (body.outputSchema) return body.outputSchema as JsonSchemaLike;
    return {
      type: 'object',
      properties: {
        response: { type: 'string' },
      },
    };
  }

  if (body.type === 'set') {
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(asRecord(body.values)).map(([key, value]) => [
        key,
        { type: outputTypeToJsonSchemaType(unknownToOutputType(value)) } satisfies JsonSchemaLike,
      ])),
    };
  }

  return undefined;
}

function deriveTransitiveUpstreamNodeIds(
  definition: Pick<WorkflowDefinition, 'edges'>,
  nodeId: string,
): Set<string> {
  const incomingByTarget = new Map<string, string[]>();
  for (const edge of definition.edges) {
    const incoming = incomingByTarget.get(edge.to) ?? [];
    incoming.push(edge.from);
    incomingByTarget.set(edge.to, incoming);
  }

  const upstream = new Set<string>();
  const stack = [...(incomingByTarget.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || upstream.has(current)) continue;
    upstream.add(current);
    stack.push(...(incomingByTarget.get(current) ?? []));
  }

  return upstream;
}

function createManualWorkflowOutputSource(input: {
  nodeId: string;
  nodeLabel: string;
  actionName: string;
  path: string[];
  label: string;
  valueType: WorkflowOutputSource['valueType'];
}): WorkflowOutputSource {
  return {
    nodeId: input.nodeId,
    nodeLabel: input.nodeLabel,
    actionName: input.actionName,
    path: input.path,
    expression: formatWorkflowTemplatePath(input.path),
    label: input.label,
    valueType: input.valueType,
  };
}

function workflowInputTypeToOutputType(type: string): WorkflowOutputSource['valueType'] {
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'scalar';
}

function unknownToOutputType(value: unknown): WorkflowOutputSource['valueType'] {
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'scalar';
}

function outputTypeToJsonSchemaType(type: WorkflowOutputSource['valueType']): string {
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'string';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function appendExpression(value: string, expression: string): string {
  const trimmed = value.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n${expression}` : expression;
}

function createUniqueRecordKey(label: string, existing: Record<string, unknown>): string {
  const base = toCamelKey(label) || 'value';
  if (existing[base] === undefined) return base;

  let index = 2;
  let candidate = `${base}${index}`;
  while (existing[candidate] !== undefined) {
    index += 1;
    candidate = `${base}${index}`;
  }
  return candidate;
}

function toCamelKey(label: string): string {
  const words = label
    .replace(/\{\{.*?\}\}/g, '')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return '';
  const [first = '', ...rest] = words;
  return [
    first.toLowerCase(),
    ...rest.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`),
  ].join('');
}

function sourceToConditionDataType(source: WorkflowOutputSource): IfCondition['dataType'] {
  if (source.valueType === 'array') return 'array';
  if (source.valueType === 'object') return 'object';
  return 'string';
}

function trimSummary(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function createToolCatalogActionKey(service: string, actionId: string): string {
  return `${service}:${actionId}`;
}

function getTargetConfiguredInputExpression(node: WorkflowNode): string | undefined {
  if (node.type === 'foreach') return node.items.trim() || undefined;
  return undefined;
}

function getTargetExpectation(node: WorkflowNode): WorkflowEdgeTargetExpectation | undefined {
  if (node.type === 'foreach') {
    return {
      label: 'For each item source',
      description: 'Requires a typed array output.',
      valueType: 'array',
    };
  }
  return undefined;
}

function getTargetInputSchema(
  node: WorkflowNode,
  actionsByKey: Map<string, ToolCatalogAction>,
): JsonSchemaLike | undefined {
  if (node.type !== 'tool') return undefined;
  return actionsByKey.get(createToolCatalogActionKey(node.service, node.action))?.inputSchema;
}

function deriveSchemaOutputSources(input: {
  schema: JsonSchemaLike;
  basePath: string[];
  nodeId: string;
  nodeLabel: string;
  actionName: string;
}): WorkflowOutputSource[] {
  const directType = getSchemaType(input.schema);
  if (directType === 'array') {
    return [createWorkflowOutputSource(input, input.basePath, 'array', input.schema)];
  }

  if (directType !== 'object' || !input.schema.properties) {
    return [];
  }

  const sources: WorkflowOutputSource[] = [];
  for (const [property, schema] of Object.entries(input.schema.properties)) {
    const propertyPath = [...input.basePath, property];
    const propertyType = getSchemaType(schema);
    if (propertyType === 'array') {
      sources.push(createWorkflowOutputSource(input, propertyPath, 'array', schema));
      continue;
    }
    if (propertyType === 'object' && schema.properties) {
      sources.push(...deriveSchemaOutputSources({
        ...input,
        schema,
        basePath: propertyPath,
      }));
    }
  }

  return sources;
}

function deriveLlmSchemaOutputSources(input: {
  schema: JsonSchemaLike;
  basePath: string[];
  nodeId: string;
  nodeLabel: string;
  actionName: string;
}): WorkflowOutputSource[] {
  const directType = getSchemaType(input.schema);
  if (directType === 'array') {
    return [createWorkflowOutputSource(input, input.basePath, 'array', input.schema)];
  }

  if (directType !== 'object' || !input.schema.properties) return [];

  return Object.entries(input.schema.properties).map(([property, schema]) => {
    const propertyPath = [...input.basePath, property];
    return createWorkflowOutputSource(
      input,
      propertyPath,
      schemaTypeToOutputSourceType(schema),
      schema,
    );
  });
}

function createWorkflowOutputSource(
  input: {
    nodeId: string;
    nodeLabel: string;
    actionName: string;
  },
  path: string[],
  valueType: WorkflowOutputSource['valueType'],
  schema?: JsonSchemaLike,
): WorkflowOutputSource {
  const suffix = path.slice(3).join('.');
  return {
    nodeId: input.nodeId,
    nodeLabel: input.nodeLabel,
    actionName: input.actionName,
    path,
    expression: formatWorkflowTemplatePath(path),
    label: suffix ? `${input.nodeId} ${suffix}` : `${input.nodeId} output`,
    valueType,
    ...(schema ? { itemFields: deriveArrayItemFields(schema, path) } : {}),
  };
}

function getSchemaType(schema: JsonSchemaLike): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type;
}

function normalizeJsonSchemaFieldType(value: unknown): WorkflowInputDefinition['type'] | undefined {
  const candidate = Array.isArray(value) ? value.find((type) => type !== 'null') : value;
  return WORKFLOW_SCHEMA_FIELD_TYPES.includes(candidate as WorkflowInputDefinition['type'])
    ? candidate as WorkflowInputDefinition['type']
    : undefined;
}

function schemaTypeToOutputSourceType(schema: JsonSchemaLike): WorkflowOutputSource['valueType'] {
  const type = getSchemaType(schema);
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'scalar';
}

function deriveArrayItemFields(schema: JsonSchemaLike, arrayPath: string[]): WorkflowSchemaField[] | undefined {
  const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (!itemSchema?.properties) return undefined;

  return Object.entries(itemSchema.properties).map(([name, fieldSchema]) => ({
    name,
    path: [...arrayPath, name],
    valueType: getSchemaType(fieldSchema) ?? 'unknown',
    ...(fieldSchema.description ? { description: fieldSchema.description } : {}),
  }));
}

function formatWorkflowPath(path: string[]): string {
  return path.map((segment, index) => {
    if (index === 0) return segment;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return `.${segment}`;
    return `[${JSON.stringify(segment)}]`;
  }).join('');
}

function normalizeTemplateReference(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('{{') && trimmed.endsWith('}}')
    ? trimmed.slice(2, -2).trim()
    : trimmed;
}
