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
  severity: 'warning' | 'error';
  message: string;
}

export interface JsonSchemaLike {
  [key: string]: unknown;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike | JsonSchemaLike[];
}

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
  definition: Pick<WorkflowDefinition, 'nodes' | 'inputs'>,
  actions: ToolCatalogAction[],
): WorkflowOutputSource[] {
  const catalogIndex = buildToolCatalogIndex(actions);
  const sources: WorkflowOutputSource[] = deriveTriggerOutputSources(definition);

  for (const node of definition.nodes) {
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
): WorkflowDataFlowWarning[] {
  const sources = deriveWorkflowOutputSources(definition, actions);
  const warnings: WorkflowDataFlowWarning[] = [];
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));

  for (const edge of definition.edges) {
    const target = nodesById.get(edge.to);
    if (target?.type !== 'foreach') continue;

    const upstreamArraySources = sources.filter((source) =>
      source.nodeId === edge.from && source.valueType === 'array',
    );
    if (upstreamArraySources.length === 0) {
      warnings.push({
        edgeId: createEdgeId(edge.from, edge.to, edge.fromOutput),
        severity: 'warning',
        message: `For each needs an array output from ${edge.from}, but no typed array output is available.`,
      });
    }
  }

  return warnings;
}

const NODE_LABELS: Record<DagNodeType, string> = {
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

const NODE_DESCRIPTIONS: Record<DagNodeType, string> = {
  trigger: 'Workflow invocation payload',
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
  return {
    nodes: normalized.nodes.map((node, index) => {
      const savedPosition = normalized.ui?.nodes?.[node.id]?.position;
      return {
        id: node.id,
        type: 'workflow',
        position: savedPosition ?? { x: index * 320, y: 0 },
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
  previous?: Pick<WorkflowDefinition, 'inputs' | 'policy'>,
): WorkflowDefinition {
  const ui: WorkflowEditorState = {
    nodes: Object.fromEntries(
      flow.nodes.map((node) => [node.id, { position: node.position }]),
    ),
    ...(flow.viewport ? { viewport: flow.viewport } : {}),
  };

  return {
    version: 'dag/v1',
    ...(previous?.inputs ? { inputs: previous.inputs } : {}),
    nodes: flow.nodes.map((node) => ({ ...node.data.node, id: node.id })),
    edges: flow.edges.map(flowEdgeToWorkflowEdge),
    ...(previous?.policy ? { policy: previous.policy } : {}),
    ui,
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
      return 'Runtime trigger payload and declared workflow inputs';
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

function deriveTriggerOutputSources(definition: Pick<WorkflowDefinition, 'nodes' | 'inputs'>): WorkflowOutputSource[] {
  if (!definition.nodes.some((node) => node.type === 'trigger')) return [];

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

  for (const [name, input] of Object.entries(definition.inputs ?? {})) {
    sources.push(createManualWorkflowOutputSource({
      nodeId: 'trigger',
      nodeLabel: 'Trigger',
      actionName: 'Workflow input',
      path: ['inputs', name],
      label: `Trigger input ${name}`,
      valueType: workflowInputTypeToOutputType(input.type),
    }));
  }

  return sources;
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
