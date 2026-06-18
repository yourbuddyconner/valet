import * as React from 'react';
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
  WorkflowInputDefinition,
  WorkflowNode,
} from '@valet/shared';
import type {
  Connection,
  Edge as ReactFlowEdge,
  EdgeChange,
  NodeChange,
  NodeProps,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  ReactFlowInstance,
} from '@xyflow/react';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { Canvas } from '@/components/ai-elements/canvas';
import { Connection as ConnectionLine } from '@/components/ai-elements/connection';
import { Controls } from '@/components/ai-elements/controls';
import { Edge } from '@/components/ai-elements/edge';
import {
  Node,
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
} from '@/components/ai-elements/node';
import { Panel } from '@/components/ai-elements/panel';
import { useActionCatalog } from '@/api/action-catalog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
import { buildModelSelectorGroups } from '@/components/ui/model-selector-utils';
import { cn } from '@/lib/cn';
import { useAvailableModels } from '@/api/sessions';
import { useAuthStore } from '@/stores/auth';
import {
  applyDefaultDataFlowForConnection,
  NODE_TYPE_OPTIONS,
  buildToolCatalogIndex,
  createDefaultWorkflowDefinition,
  createEdgeId,
  createFlowNodeData,
  createWorkflowInputPatchForNode,
  createNodeId,
  deriveWorkflowTemplateSources,
  deriveWorkflowOutputSources,
  definitionToFlow,
  flowToDefinition,
  getDefaultNodeForType,
  updateWorkflowNode,
  validateWorkflowDataFlowEdges,
  type AddableDagNodeType,
  type JsonSchemaLike,
  type ToolCatalogAction,
  type ToolCatalogService,
  type WorkflowOutputSource,
  type WorkflowSchemaField,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
  type WorkflowFlowNodeData,
} from './workflow-editor-model';
import {
  filterTemplateSuggestions,
  getTemplateCompletionContext,
  insertTemplateExpression,
  validateTemplateTags,
} from './workflow-template-tags';

type ForeachBodyNodeType = ForeachBodyNode['type'];

const FOREACH_BODY_NODE_TYPES: ForeachBodyNodeType[] = ['llm', 'tool', 'set', 'stop', 'orchestrator', 'session'];

interface VisualWorkflowEditorProps {
  definition: WorkflowDefinition | null;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  onTestRun?: () => void;
  isTesting?: boolean;
  className?: string;
}

const nodeTypes = {
  workflow: WorkflowNodeCard as React.ComponentType<NodeProps>,
};

const edgeTypes = {
  animated: Edge.Animated,
  temporary: Edge.Temporary,
};

export function VisualWorkflowEditor(props: VisualWorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <VisualWorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function VisualWorkflowEditorInner({
  definition,
  onDefinitionChange,
  onTestRun,
  isTesting = false,
  className,
}: VisualWorkflowEditorProps) {
  const initialDefinition = definition ?? createDefaultWorkflowDefinition();
  const initialFlow = React.useMemo(() => definitionToFlow(initialDefinition), [initialDefinition]);
  const [nodes, setNodes] = React.useState<WorkflowFlowNode[]>(initialFlow.nodes);
  const [edges, setEdges] = React.useState<WorkflowFlowEdge[]>(initialFlow.edges);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [nodePaletteOpen, setNodePaletteOpen] = React.useState(false);
  const [rawJson, setRawJson] = React.useState('');
  const [rawJsonError, setRawJsonError] = React.useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = React.useState<ReactFlowInstance | null>(null);
  const { getViewport } = useReactFlow();
  const { data: actionCatalog = [] } = useActionCatalog();

  React.useEffect(() => {
    const next = definitionToFlow(definition ?? createDefaultWorkflowDefinition());
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(null);
    setRawOpen(false);
    setRawJson(JSON.stringify(flowToDefinition(next, definition ?? undefined), null, 2));
  }, [definition]);

  const selectedNode = React.useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const currentDefinition = React.useCallback(() => {
    return flowToDefinition(
      {
        nodes,
        edges,
        viewport: reactFlowInstance?.getViewport() ?? getViewport(),
      },
      definition ?? undefined,
    );
  }, [definition, edges, getViewport, nodes, reactFlowInstance]);

  const dataFlowWarnings = React.useMemo(
    () => validateWorkflowDataFlowEdges(currentDefinition(), actionCatalog),
    [actionCatalog, currentDefinition],
  );

  const syncRawJson = React.useCallback(() => {
    setRawJson(JSON.stringify(currentDefinition(), null, 2));
  }, [currentDefinition]);

  React.useEffect(() => {
    syncRawJson();
  }, [syncRawJson]);

  React.useEffect(() => {
    onDefinitionChange?.(currentDefinition());
  }, [currentDefinition, onDefinitionChange]);

  const handleNodesChange: OnNodesChange = React.useCallback((changes: NodeChange[]) => {
    const safeChanges = changes.filter((change) => !(change.type === 'remove' && change.id === 'trigger'));
    setNodes((current) => applyNodeChanges(safeChanges, current) as WorkflowFlowNode[]);
  }, []);

  const handleEdgesChange: OnEdgesChange = React.useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current) as WorkflowFlowEdge[]);
  }, []);

  const handleEdgeDoubleClick = React.useCallback((event: React.MouseEvent, edge: ReactFlowEdge) => {
    event.preventDefault();
    event.stopPropagation();
    setEdges((current) => current.filter((currentEdge) => currentEdge.id !== edge.id));
  }, []);

  const handleConnect: OnConnect = React.useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const fromOutput = connection.sourceHandle === 'true' || connection.sourceHandle === 'false'
      ? connection.sourceHandle
      : undefined;
    const edge: WorkflowFlowEdge = {
      id: createEdgeId(connection.source, connection.target, fromOutput),
      source: connection.source,
      ...(fromOutput ? { sourceHandle: fromOutput } : {}),
      target: connection.target,
      type: fromOutput ? 'temporary' : 'animated',
      ...(fromOutput ? { label: fromOutput } : {}),
      data: {
        ...(fromOutput ? { fromOutput } : {}),
      },
    };
    const nextEdges = addEdge(edge, edges) as WorkflowFlowEdge[];
    const nextDefinition = applyDefaultDataFlowForConnection(
      flowToDefinition(
        {
          nodes,
          edges: nextEdges,
          viewport: reactFlowInstance?.getViewport() ?? getViewport(),
        },
        definition ?? undefined,
      ),
      { from: edge.source, to: edge.target },
      actionCatalog,
    );
    const nextFlow = definitionToFlow(nextDefinition);
    setNodes(nextFlow.nodes);
    setEdges(nextFlow.edges);
  }, [actionCatalog, definition, edges, getViewport, nodes, reactFlowInstance]);

  function handleAddNode(type: AddableDagNodeType) {
    const id = createNodeId(type, nodes.map((node) => node.id));
    const node = getDefaultNodeForType(type, id);
    const position = reactFlowInstance?.screenToFlowPosition({ x: 360, y: 240 }) ?? {
      x: nodes.length * 320,
      y: 0,
    };
    const flowNode: WorkflowFlowNode = {
      id,
      type: 'workflow',
      position,
      data: createFlowNodeData(node),
    };
    setNodes((current) => [...current, flowNode]);
    setSelectedNodeId(id);
    setRawOpen(false);
    setNodePaletteOpen(false);
  }

  function handleApplyRawJson() {
    setRawJsonError(null);
    let parsed: WorkflowDefinition;
    try {
      parsed = JSON.parse(rawJson) as WorkflowDefinition;
    } catch (err) {
      setRawJsonError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }
    if (!parsed || parsed.version !== 'dag/v1' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      setRawJsonError('Raw JSON must be a dag/v1 definition with nodes and edges.');
      return;
    }
    const flow = definitionToFlow(parsed);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedNodeId(null);
    setRawOpen(false);
  }

  function handleUpdateNode(patch: Partial<WorkflowNode>) {
    if (!selectedNode) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNode.id ? updateWorkflowNode(node, patch) : node,
      ),
    );
  }

  return (
    <div
      className={cn(
        'relative h-full min-h-[680px] overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-950 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100',
        '[--surface-1:#f8fafc] [--workflow-edge-branch-stroke:#94a3b8] [--workflow-edge-stroke:#525252]',
        'dark:[--surface-1:#0a0a0a] dark:[--workflow-edge-branch-stroke:#64748b] dark:[--workflow-edge-stroke:#cbd5e1]',
        className,
      )}
    >
      <Canvas
        className="bg-neutral-50 dark:bg-neutral-950"
        connectionLineComponent={ConnectionLine}
        edges={edges}
        edgeTypes={edgeTypes}
        fitView
        nodes={nodes}
        nodeTypes={nodeTypes}
        onConnect={handleConnect}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onEdgesChange={handleEdgesChange}
        onInit={setReactFlowInstance}
        onNodeClick={(_, node) => {
          setRawOpen(false);
          setSelectedNodeId(node.id);
        }}
        onPaneClick={() => {
          setSelectedNodeId(null);
          setRawOpen(false);
        }}
        onNodesChange={handleNodesChange}
      >
        <Controls className="border-neutral-200 bg-white text-neutral-900 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 [&>button]:text-neutral-700 [&>button]:hover:bg-neutral-100 dark:[&>button]:text-neutral-100 dark:[&>button]:hover:bg-neutral-800" />
        <Panel position="top-right" className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 p-2 shadow-lg backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedNodeId(null);
              setRawOpen(true);
            }}
            className="border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            JSON
          </Button>
          <Dialog open={nodePaletteOpen} onOpenChange={setNodePaletteOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-10 w-10 border border-neutral-200 bg-white p-0 text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
                title="Add node"
              >
                <PlusIcon className="h-5 w-5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm">
              <DialogTitle>Add node</DialogTitle>
              <div className="grid gap-2">
                {NODE_TYPE_OPTIONS.map((option) => (
                  <Button
                    key={option.type}
                    type="button"
                    variant="secondary"
                    className="justify-start"
                    onClick={() => handleAddNode(option.type)}
                    title={option.description}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </Panel>
        {onTestRun && (
          <Panel position="bottom-center" className="p-4">
            <Button
              type="button"
              onClick={onTestRun}
              disabled={isTesting}
              className="h-11 bg-red-500 px-6 text-white shadow-lg hover:bg-red-600"
            >
              <FlaskIcon className="mr-2 h-4 w-4" />
              {isTesting ? 'Starting...' : 'Test workflow'}
            </Button>
          </Panel>
        )}
        {dataFlowWarnings.length > 0 && (
          <Panel position="bottom-right" className="max-w-sm space-y-1 p-3">
            {dataFlowWarnings.map((warning) => (
              <div
                key={warning.edgeId}
                className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 shadow-sm dark:border-amber-500/40 dark:bg-amber-950/90 dark:text-amber-100"
              >
                {warning.message}
              </div>
            ))}
          </Panel>
        )}
      </Canvas>

      {(rawOpen || selectedNode) && (
        <aside className="absolute bottom-3 right-3 top-3 z-10 flex w-[380px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white/95 shadow-2xl backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
          <div className="flex items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-800">
            <div>
              <h2 className="text-sm font-medium text-neutral-950 dark:text-neutral-100">
                {rawOpen ? 'JSON' : 'Editor'}
              </h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {rawOpen ? 'Raw workflow definition' : selectedNode?.data.label}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!rawOpen && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setRawOpen(true)}>
                  JSON
                </Button>
              )}
              {rawOpen && selectedNode && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setRawOpen(false)}>
                  Node
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRawOpen(false);
                  setSelectedNodeId(null);
                }}
                title="Close"
              >
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {rawOpen ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
              <textarea
                value={rawJson}
                onChange={(event) => setRawJson(event.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-md border border-neutral-200 bg-white p-3 font-mono text-xs text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500"
              />
              {rawJsonError && <p className="text-xs text-red-400">{rawJsonError}</p>}
              <Button type="button" variant="secondary" onClick={handleApplyRawJson}>
                Apply JSON to canvas
              </Button>
            </div>
          ) : selectedNode ? (
            <NodeInspector
              definition={currentDefinition()}
              node={selectedNode}
              onUpdate={handleUpdateNode}
            />
          ) : null}
        </aside>
      )}
    </div>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function FlaskIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M9 3h6" />
      <path d="M10 3v6.2L4.4 18.7A2 2 0 0 0 6.1 22h11.8a2 2 0 0 0 1.7-3.3L14 9.2V3" />
      <path d="M8 15h8" />
    </svg>
  );
}

function WorkflowNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as WorkflowFlowNodeData;
  return (
    <Node
      handles={nodeData.handles}
      className={cn(
        'border-neutral-200 bg-white text-neutral-950 shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-100 dark:shadow-black/20',
        '[&_.react-flow__handle]:border-white [&_.react-flow__handle]:bg-neutral-700 dark:[&_.react-flow__handle]:border-neutral-950 dark:[&_.react-flow__handle]:bg-neutral-300',
        selected && 'border-accent ring-2 ring-accent/30 dark:border-red-400 dark:ring-red-400/35',
      )}
    >
      <NodeHeader className="border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <NodeTitle className="truncate text-neutral-950 dark:text-neutral-100">{nodeData.label}</NodeTitle>
            <NodeDescription className="truncate text-neutral-500 dark:text-neutral-500">{nodeData.node.id}</NodeDescription>
          </div>
          <Badge variant="secondary">{nodeData.nodeType}</Badge>
        </div>
      </NodeHeader>
      <NodeContent>
        <p className="line-clamp-3 text-xs text-neutral-700 dark:text-neutral-300">
          {nodeData.summary}
        </p>
      </NodeContent>
      <NodeFooter className="border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="truncate text-xs text-neutral-500 dark:text-neutral-500">{nodeData.description}</p>
      </NodeFooter>
    </Node>
  );
}

interface NodeInspectorProps {
  definition: WorkflowDefinition;
  node: WorkflowFlowNode;
  onUpdate: (patch: Partial<WorkflowNode>) => void;
}

function NodeInspector({ definition, node, onUpdate }: NodeInspectorProps) {
  const workflowNode = node.data.node;
  const { data: actionCatalog = [] } = useActionCatalog();
  const incomingNodeIds = React.useMemo(
    () => new Set(definition.edges.filter((edge) => edge.to === workflowNode.id).map((edge) => edge.from)),
    [definition.edges, workflowNode.id],
  );
  const availableInputs = React.useMemo(
    () => deriveWorkflowOutputSources(definition, actionCatalog)
      .filter((source) => incomingNodeIds.has(source.nodeId)),
    [actionCatalog, definition, incomingNodeIds],
  );
  const templateSources = React.useMemo(
    () => deriveWorkflowTemplateSources(definition, actionCatalog, workflowNode.id),
    [actionCatalog, definition, workflowNode.id],
  );
  const handleUseInput = React.useCallback((source: WorkflowOutputSource) => {
    const patch = createWorkflowInputPatchForNode(workflowNode, source);
    if (patch) onUpdate(patch);
  }, [onUpdate, workflowNode]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Selected node
        </label>
        <Input value={node.id} readOnly className="font-mono text-xs" />
      </div>
      <NodeParameterFields
        definition={definition}
        node={workflowNode}
        templateSources={templateSources}
        onUpdate={onUpdate}
      />
      {availableInputs.length > 0 && (
        <AvailableInputs sources={availableInputs} onUseInput={handleUseInput} />
      )}
    </div>
  );
}

function AvailableInputs({
  onUseInput,
  sources,
}: {
  onUseInput: (source: WorkflowOutputSource) => void;
  sources: WorkflowOutputSource[];
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <div className="font-medium text-neutral-700 dark:text-neutral-300">Available inputs</div>
      <div className="mt-2 space-y-2">
        {sources.map((source) => (
          <button
            key={source.expression}
            type="button"
            className="block w-full space-y-1 rounded-md border border-transparent p-1 text-left hover:border-neutral-200 hover:bg-white focus:border-accent focus:outline-none dark:hover:border-neutral-700 dark:hover:bg-neutral-950"
            onClick={() => onUseInput(source)}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate">{source.label}</span>
              <Badge variant="secondary">{source.valueType}</Badge>
            </div>
            <div className="truncate font-mono text-neutral-500">{source.expression}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeParameterFields({
  definition,
  node,
  templateSources,
  onUpdate,
}: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  templateSources: WorkflowOutputSource[];
  onUpdate: (patch: Partial<WorkflowNode>) => void;
}) {
  switch (node.type) {
    case 'trigger':
      return <TriggerFields node={node} onUpdate={onUpdate} />;
    case 'llm':
      return <LlmFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'tool':
      return <ToolFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'if':
      return <IfFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'foreach':
      return <ForeachFields definition={definition} node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'approval':
      return <ApprovalFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'wait':
      return <WaitFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'set':
      return <SetFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'orchestrator':
      return <OrchestratorFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'session':
      return <SessionFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
    case 'stop':
      return <StopFields node={node} templateSources={templateSources} onUpdate={onUpdate} />;
  }
}

function TriggerFields({
  node,
  onUpdate,
}: {
  node: TriggerNode;
  onUpdate: (patch: Partial<TriggerNode>) => void;
}) {
  return (
    <>
      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Workflow entrypoint</span>
          <Badge variant="secondary">{node.id}</Badge>
        </div>
        <p className="mt-2 text-neutral-500 dark:text-neutral-400">
          This source provides the payload from the trigger that invoked the workflow.
        </p>
      </div>
      <TriggerDataSchemaFields
        value={node.dataSchema ?? {}}
        onChange={(dataSchema) => onUpdate({ dataSchema: Object.keys(dataSchema).length > 0 ? dataSchema : undefined })}
      />
      <ToolSchemaContract
        title="Outputs"
        schema={{
          type: 'object',
          properties: {
            type: { type: 'string', description: 'manual, schedule, or webhook' },
            timestamp: { type: 'string', description: 'Invocation timestamp' },
            data: {
              type: 'object',
              description: 'Trigger-specific payload',
              properties: workflowInputDefinitionsToJsonSchemaProperties(node.dataSchema ?? {}),
            },
            metadata: { type: 'object', description: 'System metadata for the trigger delivery' },
          },
        }}
      />
    </>
  );
}

function TriggerDataSchemaFields({
  value,
  onChange,
}: {
  value: Record<string, WorkflowInputDefinition>;
  onChange: (value: Record<string, WorkflowInputDefinition>) => void;
}) {
  const entries = Object.entries(value);

  function setEntry(index: number, nextName: string, patch: Partial<WorkflowInputDefinition>) {
    const nextEntries = entries.map(([name, spec], currentIndex) => {
      if (currentIndex !== index) return [name, spec] as const;
      return [nextName, { ...spec, ...patch }] as const;
    });
    onChange(Object.fromEntries(nextEntries.filter(([name]) => name.trim().length > 0)));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <LabelText>Trigger data schema</LabelText>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange({ ...value, [createSchemaFieldKey(value)]: { type: 'string' } })}
        >
          Add
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          Add fields here to render typed manual trigger inputs and template suggestions.
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map(([name, spec], index) => (
            <div key={`${name}-${index}`} className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] gap-2">
                <Input
                  value={name}
                  onChange={(event) => setEntry(index, event.target.value, {})}
                  placeholder="field_name"
                />
                <NativeSelect
                  value={spec.type}
                  options={['string', 'number', 'boolean', 'object', 'array']}
                  onChange={(type) => setEntry(index, name, { type, default: undefined })}
                />
              </div>
              <Input
                value={spec.description ?? ''}
                onChange={(event) => setEntry(index, name, { description: optionalString(event.target.value) })}
                placeholder="Description"
              />
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={Boolean(spec.required)}
                    onChange={(event) => setEntry(index, name, { required: event.target.checked || undefined })}
                  />
                  Required
                </label>
                <Input
                  value={stringifyEditableValue(spec.default)}
                  onChange={(event) => setEntry(index, name, { default: parseWorkflowInputDefault(event.target.value, spec.type) })}
                  placeholder="Default"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onChange(Object.fromEntries(entries.filter((_, currentIndex) => currentIndex !== index)))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LlmFields({ node, onUpdate, templateSources }: NodeFieldProps<LlmNode>) {
  return (
    <>
      <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={6} />
      <TemplateTextAreaField label="System" value={node.system ?? ''} templateSources={templateSources} onChange={(system) => onUpdate({ system: optionalString(system) })} minRows={3} />
      <Field label="Model">
        <WorkflowModelPicker value={node.model} onChange={(model) => onUpdate({ model })} />
      </Field>
      <NumberField label="Temperature" value={node.temperature} min={0} max={2} step={0.1} onChange={(temperature) => onUpdate({ temperature })} />
      <NumberField label="Max output tokens" value={node.maxOutputTokens} min={1} step={1} onChange={(maxOutputTokens) => onUpdate({ maxOutputTokens })} />
      <JsonValueField label="Output schema" value={node.outputSchema} onChange={(outputSchema) => onUpdate({ outputSchema })} />
    </>
  );
}

function WorkflowModelPicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const user = useAuthStore((state) => state.user);
  const orgModelPreferences = useAuthStore((state) => state.orgModelPreferences);
  const { data: availableModels = [] } = useAvailableModels();
  const modelGroups = React.useMemo(
    () =>
      buildModelSelectorGroups({
        availableModels,
        userModelPreferences: user?.modelPreferences,
        orgModelPreferences,
      }),
    [availableModels, orgModelPreferences, user?.modelPreferences],
  );
  const selectedModel = React.useMemo(() => {
    for (const provider of availableModels) {
      const model = provider.models.find((candidate) => candidate.id === value);
      if (model) return { ...model, provider: provider.provider };
    }
    return null;
  }, [availableModels, value]);

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          className="flex h-10 w-full items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:border-neutral-600 dark:focus:ring-neutral-600"
        >
          {selectedModel ? (
            <>
              <ModelSelectorLogo provider={selectedModel.provider} />
              <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
            </>
          ) : value ? (
            <ModelSelectorName>{value}</ModelSelectorName>
          ) : (
            <ModelSelectorName className="text-neutral-500">Default model</ModelSelectorName>
          )}
          <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-neutral-400" />
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          <ModelSelectorItem
            value="__default__"
            onSelect={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <ModelSelectorName className="text-neutral-500">Default model</ModelSelectorName>
            {!value && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
          </ModelSelectorItem>
          <ModelSelectorSeparator />
          {modelGroups.preferredGroup && (
            <>
              <ModelSelectorGroup heading={modelGroups.preferredGroup.heading}>
                {modelGroups.preferredGroup.models.map((model) => (
                  <ModelSelectorItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                  >
                    <ModelSelectorLogo provider={model.provider} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    {value === model.id && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
              <ModelSelectorSeparator />
            </>
          )}
          {modelGroups.providerGroups.map((provider) => (
            <ModelSelectorGroup key={provider.provider} heading={provider.provider}>
              {provider.models.map((model) => (
                <ModelSelectorItem
                  key={model.id}
                  value={model.id}
                  onSelect={() => {
                    onChange(model.id);
                    setOpen(false);
                  }}
                >
                  <ModelSelectorLogo provider={provider.provider} />
                  <ModelSelectorName>{model.name}</ModelSelectorName>
                  {value === model.id && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

function ToolFields({ node, onUpdate, templateSources }: NodeFieldProps<ToolNode>) {
  const { data: actionCatalog = [], isLoading } = useActionCatalog();
  const catalogIndex = React.useMemo(() => buildToolCatalogIndex(actionCatalog), [actionCatalog]);
  const actions = catalogIndex.actionsByService.get(node.service) ?? [];
  const selectedService = catalogIndex.services.find((service) => service.service === node.service);
  const selectedAction = actions.find((action) => action.actionId === node.action);

  return (
    <>
      <ToolServicePicker
        isLoading={isLoading}
        selectedService={selectedService}
        services={catalogIndex.services}
        value={node.service}
        onCustomSelect={(service) => onUpdate({ service, action: '' })}
        onSelect={(service) => {
          const nextActions = catalogIndex.actionsByService.get(service.service) ?? [];
          const actionStillValid = nextActions.some((action) => action.actionId === node.action);
          onUpdate({
            service: service.service,
            ...(actionStillValid ? {} : { action: '' }),
          });
        }}
      />
      <ToolActionPicker
        actions={actions}
        disabled={!node.service}
        isLoading={isLoading}
        selectedAction={selectedAction}
        service={node.service}
        value={node.action}
        onCustomSelect={(action) => onUpdate({ action })}
        onSelect={(action) => onUpdate({ action: action.actionId })}
      />
      {selectedAction?.inputSchema && (
        <ToolSchemaContract title="Input parameters" schema={selectedAction.inputSchema} />
      )}
      {selectedAction?.outputSchema && (
        <ToolSchemaContract title="Outputs" schema={selectedAction.outputSchema} />
      )}
      <Field label="Summary">
        <TemplateTextInput value={node.summary ?? ''} templateSources={templateSources} onChange={(summary) => onUpdate({ summary: optionalString(summary) })} />
      </Field>
      <KeyValueEditor label="Params" value={node.params} templateSources={templateSources} onChange={(params) => onUpdate({ params })} />
      <SelectField
        label="Policy deny"
        value={node.onPolicyDeny ?? 'fail'}
        options={['fail', 'skip']}
        onChange={(onPolicyDeny) => onUpdate({ onPolicyDeny })}
      />
      <NumberField label="Retries" value={node.retries} min={0} step={1} onChange={(retries) => onUpdate({ retries })} />
    </>
  );
}

function ToolSchemaContract({
  schema,
  title,
}: {
  schema: JsonSchemaLike;
  title: string;
}) {
  const type = describeSchemaType(schema);
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-neutral-700 dark:text-neutral-300">{title}</span>
        <Badge variant="secondary">{type}</Badge>
      </div>
      <SchemaTree schema={schema} />
    </div>
  );
}

function SchemaTree({
  name,
  schema,
  depth = 0,
}: {
  name?: string;
  schema: JsonSchemaLike;
  depth?: number;
}) {
  const type = describeSchemaType(schema);
  const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  const properties = schema.properties ? Object.entries(schema.properties) : [];

  return (
    <div className={cn('mt-1 space-y-1', depth > 0 && 'ml-3 border-l border-neutral-200 pl-2 dark:border-neutral-700')}>
      {name && (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate font-mono text-neutral-700 dark:text-neutral-300">{name}</span>
          <span className="shrink-0 text-neutral-500">{type}</span>
        </div>
      )}
      {schema.description && (
        <p className="text-neutral-500 dark:text-neutral-400">{schema.description}</p>
      )}
      {type === 'array' && itemSchema && (
        <SchemaTree name="item" schema={itemSchema} depth={depth + 1} />
      )}
      {properties.map(([propertyName, propertySchema]) => (
        <SchemaTree
          key={propertyName}
          name={propertyName}
          schema={propertySchema}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function ToolServicePicker({
  isLoading,
  selectedService,
  services,
  value,
  onCustomSelect,
  onSelect,
}: {
  isLoading: boolean;
  selectedService?: ToolCatalogService;
  services: ToolCatalogService[];
  value: string;
  onCustomSelect: (service: string) => void;
  onSelect: (service: ToolCatalogService) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const customCandidate = query.trim();
  const canUseCustom =
    customCandidate.length > 0 && !services.some((service) => service.service === customCandidate);

  return (
    <Field label="Service">
      <ToolPickerDialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full justify-between px-3 text-left text-sm"
          >
            <span className={cn('truncate', !value && 'text-neutral-400')}>
              {selectedService?.serviceDisplayName ?? (value || (isLoading ? 'Loading services...' : 'Select service'))}
            </span>
            <span className="ml-2 text-xs text-neutral-400">Service</span>
          </Button>
        </DialogTrigger>
        <ToolPickerContent title="Select service">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search services or enter a service slug..."
          />
          <CommandList>
            <CommandEmpty>No services found.</CommandEmpty>
            <CommandGroup heading="Services">
              {services.map((service) => (
                <CommandItem
                  key={service.service}
                  value={`${service.serviceDisplayName} ${service.service}`}
                  onSelect={() => {
                    onSelect(service);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <ToolPickerItemText>
                    <span className="block truncate">{service.serviceDisplayName}</span>
                    <span className="block truncate font-mono text-xs text-neutral-500">
                      {service.service} · {service.actionCount} actions
                    </span>
                  </ToolPickerItemText>
                </CommandItem>
              ))}
            </CommandGroup>
            {canUseCustom && (
              <CommandItem
                value={customCandidate}
                onSelect={() => {
                  onCustomSelect(customCandidate);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <ToolPickerItemText>
                  <span className="text-neutral-500">Use </span>
                  <span className="font-mono">{customCandidate}</span>
                </ToolPickerItemText>
              </CommandItem>
            )}
          </CommandList>
        </ToolPickerContent>
      </ToolPickerDialog>
    </Field>
  );
}

function ToolActionPicker({
  actions,
  disabled,
  isLoading,
  selectedAction,
  service,
  value,
  onCustomSelect,
  onSelect,
}: {
  actions: ToolCatalogAction[];
  disabled: boolean;
  isLoading: boolean;
  selectedAction?: ToolCatalogAction;
  service: string;
  value: string;
  onCustomSelect: (action: string) => void;
  onSelect: (action: ToolCatalogAction) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const customCandidate = query.trim();
  const canUseCustom =
    customCandidate.length > 0 && !actions.some((action) => action.actionId === customCandidate);

  return (
    <Field label="Action">
      <ToolPickerDialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full justify-between px-3 text-left text-sm"
            disabled={disabled}
          >
            <span className={cn('truncate', !value && 'text-neutral-400')}>
              {selectedAction?.name ?? (value || (disabled ? 'Select service first' : isLoading ? 'Loading actions...' : 'Select action'))}
            </span>
            <span className="ml-2 text-xs text-neutral-400">Action</span>
          </Button>
        </DialogTrigger>
        <ToolPickerContent title="Select action">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search actions or enter an action id..."
          />
          <CommandList>
            <CommandEmpty>No actions found.</CommandEmpty>
            <CommandGroup heading={service || 'Actions'}>
              {actions.map((action) => (
                <CommandItem
                  key={action.actionId}
                  value={`${action.name} ${action.actionId} ${action.description}`}
                  onSelect={() => {
                    onSelect(action);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <ToolPickerItemText>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{action.name}</span>
                      <Badge variant="secondary">{action.riskLevel}</Badge>
                    </span>
                    <span className="block truncate font-mono text-xs text-neutral-500">
                      {action.actionId}
                    </span>
                    {action.description && (
                      <span className="block truncate text-xs text-neutral-500">
                        {action.description}
                      </span>
                    )}
                  </ToolPickerItemText>
                </CommandItem>
              ))}
            </CommandGroup>
            {canUseCustom && (
              <CommandItem
                value={customCandidate}
                onSelect={() => {
                  onCustomSelect(customCandidate);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <ToolPickerItemText>
                  <span className="text-neutral-500">Use </span>
                  <span className="font-mono">{customCandidate}</span>
                </ToolPickerItemText>
              </CommandItem>
            )}
          </CommandList>
        </ToolPickerContent>
      </ToolPickerDialog>
    </Field>
  );
}

function ToolPickerDialog({
  children,
  onOpenChange,
  open,
}: {
  children: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
    </Dialog>
  );
}

function ToolPickerContent({
  children,
  title = 'Select tool option',
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <DialogContent className="overflow-hidden p-0">
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <Command>{children}</Command>
    </DialogContent>
  );
}

function ToolPickerItemText({ children }: { children: React.ReactNode }) {
  return <span className="min-w-0 flex-1 truncate text-left">{children}</span>;
}

function IfFields({ node, onUpdate, templateSources }: NodeFieldProps<IfNode>) {
  function updateCondition(index: number, patch: Partial<IfCondition>) {
    onUpdate({
      conditions: node.conditions.map((condition, currentIndex) =>
        currentIndex === index ? { ...condition, ...patch } : condition,
      ),
    });
  }

  return (
    <>
      <SelectField
        label="Combinator"
        value={node.combinator ?? 'and'}
        options={['and', 'or']}
        onChange={(combinator) => onUpdate({ combinator })}
      />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <LabelText>Conditions</LabelText>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              onUpdate({
                conditions: [
                  ...node.conditions,
                  { left: '', dataType: 'string', operation: 'equals', right: '' },
                ],
              })
            }
          >
            Add
          </Button>
        </div>
        {node.conditions.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            Add a condition to route true/false edges.
          </p>
        ) : (
          node.conditions.map((condition, index) => (
            <div key={index} className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
              <TemplateTextInput
                value={condition.left}
                templateSources={templateSources}
                onChange={(left) => updateCondition(index, { left })}
                placeholder="{{nodes.start.data.value}}"
              />
              <div className="grid grid-cols-2 gap-2">
                <NativeSelect
                  value={condition.dataType}
                  onChange={(value) => updateCondition(index, { dataType: value as IfCondition['dataType'] })}
                  options={['string', 'number', 'date', 'boolean', 'array', 'object']}
                />
                <Input value={condition.operation} onChange={(event) => updateCondition(index, { operation: event.target.value })} placeholder="equals" />
              </div>
              <Input
                value={stringifyPrimitive(condition.right)}
                onChange={(event) => updateCondition(index, { right: parseConditionRight(event.target.value, condition.dataType) })}
                placeholder="Comparison value"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onUpdate({ conditions: node.conditions.filter((_, currentIndex) => currentIndex !== index) })}
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function ForeachFields({
  definition,
  node,
  onUpdate,
}: NodeFieldProps<ForeachNode> & { definition: WorkflowDefinition }) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const { data: actionCatalog = [] } = useActionCatalog();
  const outputSources = React.useMemo(
    () => deriveWorkflowOutputSources(definition, actionCatalog).filter((source) => source.valueType === 'array'),
    [actionCatalog, definition],
  );
  const selectedSource = outputSources.find((source) => source.expression === node.items);
  const itemAlias = node.itemAlias ?? 'item';

  return (
    <>
      <ForeachSourcePicker
        selectedSource={selectedSource}
        sources={outputSources}
        value={node.items}
        onSelect={(source) => onUpdate({ items: source.expression })}
      />
      {selectedSource?.itemFields && selectedSource.itemFields.length > 0 && (
        <ForeachItemFields
          fields={selectedSource.itemFields}
          itemAlias={itemAlias}
        />
      )}
      <ForeachBodyField value={node.body} onChange={(body) => onUpdate({ body })} />
      <DisclosureSection
        open={advancedOpen}
        title="Advanced"
        onOpenChange={setAdvancedOpen}
      >
        <Field label={selectedSource ? 'Generated expression' : 'Items expression'}>
          <TemplateTextInput
            value={node.items}
            readOnly={Boolean(selectedSource)}
            templateSources={outputSources}
            onChange={(items) => onUpdate({ items })}
            placeholder="{{nodes.fetch.data.items}}"
            className={cn(selectedSource && 'bg-neutral-50 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400')}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Item alias">
            <Input value={node.itemAlias ?? ''} onChange={(event) => onUpdate({ itemAlias: optionalString(event.target.value) })} placeholder="item" />
          </Field>
          <Field label="Index alias">
            <Input value={node.indexAlias ?? ''} onChange={(event) => onUpdate({ indexAlias: optionalString(event.target.value) })} placeholder="index" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Max items" value={node.maxItems} min={1} step={1} onChange={(maxItems) => onUpdate({ maxItems })} />
          <NumberField label="Concurrency" value={node.concurrency} min={1} step={1} onChange={(concurrency) => onUpdate({ concurrency })} />
        </div>
        <SelectField
          label="Item error"
          value={node.onItemError ?? 'fail'}
          options={['fail', 'skip', 'collect']}
          onChange={(onItemError) => onUpdate({ onItemError })}
        />
      </DisclosureSection>
    </>
  );
}

function DisclosureSection({
  children,
  onOpenChange,
  open,
  title,
}: {
  children: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-700">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="flex w-full justify-between rounded-none border-0 bg-transparent px-2 py-2 text-left"
        onClick={() => onOpenChange(!open)}
      >
        <span>{title}</span>
        <span className="text-neutral-500">{open ? 'Hide' : 'Show'}</span>
      </Button>
      {open && (
        <div className="space-y-3 border-t border-neutral-200 p-2 dark:border-neutral-700">
          {children}
        </div>
      )}
    </div>
  );
}

function ForeachItemFields({
  fields,
  itemAlias,
}: {
  fields: WorkflowSchemaField[];
  itemAlias: string;
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-neutral-700 dark:text-neutral-300">Item fields</span>
        <Badge variant="secondary">{itemAlias}</Badge>
      </div>
      <div className="mt-2 space-y-1">
        {fields.map((field) => (
          <div key={field.name} className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate font-mono text-neutral-700 dark:text-neutral-300">
              {itemAlias}.{field.name}
            </span>
            <span className="shrink-0 text-neutral-500">{field.valueType}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ForeachSourcePicker({
  selectedSource,
  sources,
  value,
  onSelect,
}: {
  selectedSource?: WorkflowOutputSource;
  sources: WorkflowOutputSource[];
  value: string;
  onSelect: (source: WorkflowOutputSource) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Field label="Source">
      <ToolPickerDialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full justify-between px-3 text-left text-sm"
          >
            <span className={cn('truncate', !value && 'text-neutral-400')}>
              {selectedSource?.label ?? (value || 'Select array output')}
            </span>
            <span className="ml-2 text-xs text-neutral-400">Array</span>
          </Button>
        </DialogTrigger>
        <ToolPickerContent title="Select foreach source">
          <CommandInput placeholder="Search array outputs..." />
          <CommandList>
            <CommandEmpty>No typed array outputs found.</CommandEmpty>
            <CommandGroup heading="Array outputs">
              {sources.map((source) => (
                <CommandItem
                  key={source.expression}
                  value={`${source.nodeId} ${source.actionName} ${source.label} ${source.expression}`}
                  onSelect={() => {
                    onSelect(source);
                    setOpen(false);
                  }}
                >
                  <ToolPickerItemText>
                    <span className="block truncate">{source.label}</span>
                    <span className="block truncate text-xs text-neutral-500">
                      {source.actionName}
                    </span>
                    <span className="block truncate font-mono text-xs text-neutral-500">
                      {source.expression}
                    </span>
                  </ToolPickerItemText>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </ToolPickerContent>
      </ToolPickerDialog>
    </Field>
  );
}

function ApprovalFields({ node, onUpdate, templateSources }: NodeFieldProps<ApprovalNode>) {
  return (
    <>
      <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
      <Field label="Summary">
        <TemplateTextInput value={node.summary ?? ''} templateSources={templateSources} onChange={(summary) => onUpdate({ summary: optionalString(summary) })} />
      </Field>
      <JsonValueField label="Details" value={node.details} onChange={(details) => onUpdate({ details })} />
      <Field label="Timeout">
        <Input value={node.timeout ?? ''} onChange={(event) => onUpdate({ timeout: optionalString(event.target.value) })} placeholder="24h" />
      </Field>
      <SelectField
        label="On deny"
        value={node.onDeny ?? 'fail'}
        options={['fail', 'skip']}
        onChange={(onDeny) => onUpdate({ onDeny })}
      />
    </>
  );
}

function WaitFields({ node, onUpdate }: NodeFieldProps<WaitNode>) {
  return (
    <>
      <Field label="Mode">
        <Input value={node.mode} readOnly />
      </Field>
      <Field label="Duration">
        <Input value={node.duration} onChange={(event) => onUpdate({ duration: event.target.value })} placeholder="5m" />
      </Field>
    </>
  );
}

function SetFields({ node, onUpdate, templateSources }: NodeFieldProps<SetNode>) {
  return <KeyValueEditor label="Values" value={asRecord(node.values)} templateSources={templateSources} onChange={(values) => onUpdate({ values })} />;
}

function OrchestratorFields({ node, onUpdate, templateSources }: NodeFieldProps<OrchestratorNode>) {
  return (
    <>
      <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={6} />
      <CheckboxField label="Force new thread" checked={Boolean(node.forceNewThread)} onChange={(forceNewThread) => onUpdate({ forceNewThread })} />
      <WaitPolicyFields value={node.wait} onChange={(wait) => onUpdate({ wait })} />
    </>
  );
}

function SessionFields({ node, onUpdate, templateSources }: NodeFieldProps<SessionNode>) {
  const wait = node.wait;
  return (
    <>
      <SelectField
        label="Mode"
        value={node.mode}
        options={['start', 'prompt']}
        onChange={(mode) => {
          if (mode === 'start') {
            onUpdate({ mode, workspace: '', prompt: node.prompt });
          } else {
            onUpdate({ mode, sessionId: '', prompt: node.prompt });
          }
        }}
      />
      {node.mode === 'start' ? (
        <>
          <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
          <Field label="Workspace">
            <Input value={node.workspace} onChange={(event) => onUpdate({ workspace: event.target.value })} placeholder="repo or workspace" />
          </Field>
          <Field label="Title">
            <Input value={node.title ?? ''} onChange={(event) => onUpdate({ title: optionalString(event.target.value) })} />
          </Field>
          <Field label="Persona">
            <Input value={node.personaId ?? ''} onChange={(event) => onUpdate({ personaId: optionalString(event.target.value) })} />
          </Field>
          <Field label="Model">
            <WorkflowModelPicker value={node.model} onChange={(model) => onUpdate({ model })} />
          </Field>
          <RepoFields value={node.repo} onChange={(repo) => onUpdate({ repo })} />
        </>
      ) : (
        <>
          <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
          <Field label="Session ID">
            <Input value={node.sessionId} onChange={(event) => onUpdate({ sessionId: event.target.value })} />
          </Field>
          <Field label="Thread ID">
            <Input value={node.threadId ?? ''} onChange={(event) => onUpdate({ threadId: optionalString(event.target.value) })} />
          </Field>
          <CheckboxField label="Force new thread" checked={Boolean(node.forceNewThread)} onChange={(forceNewThread) => onUpdate({ forceNewThread })} />
        </>
      )}
      <WaitPolicyFields value={wait} onChange={(nextWait) => onUpdate({ wait: nextWait })} />
    </>
  );
}

function StopFields({ node, onUpdate, templateSources }: NodeFieldProps<StopNode>) {
  return (
    <>
      <SelectField
        label="Outcome"
        value={node.outcome ?? 'success'}
        options={['success', 'failure']}
        onChange={(outcome) => onUpdate({ outcome })}
      />
      <Field label="Message">
        <TemplateTextInput value={node.message ?? ''} templateSources={templateSources} onChange={(message) => onUpdate({ message: optionalString(message) })} />
      </Field>
      <JsonValueField label="Output" value={node.output} onChange={(output) => onUpdate({ output })} />
    </>
  );
}

interface NodeFieldProps<TNode extends WorkflowNode> {
  node: TNode;
  templateSources: WorkflowOutputSource[];
  onUpdate: (patch: Partial<TNode>) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <LabelText>{label}</LabelText>
      {children}
    </div>
  );
}

function LabelText({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
      {children}
    </label>
  );
}

function TemplateTextAreaField({
  label,
  value,
  onChange,
  templateSources,
  minRows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  templateSources: WorkflowOutputSource[];
  minRows?: number;
}) {
  return (
    <Field label={label}>
      <TemplateTextInput
        value={value}
        multiline
        minRows={minRows}
        templateSources={templateSources}
        onChange={onChange}
      />
    </Field>
  );
}

function TemplateTextInput({
  className,
  minRows = 3,
  multiline = false,
  onChange,
  placeholder,
  readOnly = false,
  templateSources,
  value,
}: {
  className?: string;
  minRows?: number;
  multiline?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  templateSources: WorkflowOutputSource[];
  value: string;
}) {
  const fieldRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [completion, setCompletion] = React.useState<ReturnType<typeof getTemplateCompletionContext>>(null);
  const suggestions = React.useMemo(
    () => completion ? filterTemplateSuggestions(templateSources, completion.query).slice(0, 8) : [],
    [completion, templateSources],
  );
  const issues = React.useMemo(
    () => validateTemplateTags(value, templateSources),
    [templateSources, value],
  );
  const showSuggestions = focused && !readOnly && Boolean(completion);

  function updateCompletion(element: HTMLInputElement | HTMLTextAreaElement) {
    const cursor = element.selectionStart ?? value.length;
    setCompletion(getTemplateCompletionContext(element.value, cursor));
  }

  function insertSuggestion(source: WorkflowOutputSource) {
    const element = fieldRef.current;
    const selectionStart = element?.selectionStart ?? value.length;
    const selectionEnd = element?.selectionEnd ?? selectionStart;
    const next = insertTemplateExpression({
      value,
      selectionStart,
      selectionEnd,
      expression: source.expression,
    });
    onChange(next.value);
    setCompletion(null);
    window.requestAnimationFrame(() => {
      fieldRef.current?.focus();
      fieldRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  const sharedProps = {
    value,
    readOnly,
    placeholder,
    spellCheck: false,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
      updateCompletion(event.currentTarget);
    },
    onClick: (event: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      updateCompletion(event.currentTarget);
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      updateCompletion(event.currentTarget);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Tab' && showSuggestions && suggestions[0]) {
        event.preventDefault();
        insertSuggestion(suggestions[0]);
      }
    },
    onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFocused(true);
      updateCompletion(event.currentTarget);
    },
    onBlur: () => setFocused(false),
  };

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          ref={fieldRef as React.RefObject<HTMLTextAreaElement>}
          rows={minRows}
          className={cn(
            'w-full resize-y rounded-md border border-neutral-200 bg-white p-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100',
            issues.length > 0 && 'border-red-300 focus:border-red-400 dark:border-red-800',
            className,
          )}
          {...sharedProps}
        />
      ) : (
        <input
          ref={fieldRef as React.RefObject<HTMLInputElement>}
          className={cn(
            'h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100',
            issues.length > 0 && 'border-red-300 focus:border-red-400 dark:border-red-800',
            className,
          )}
          {...sharedProps}
        />
      )}
      {showSuggestions && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-md border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-950">
          {suggestions.length > 0 ? (
            suggestions.map((source) => (
              <button
                key={source.expression}
                type="button"
                className="block w-full rounded-sm px-2 py-1.5 text-left text-xs hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none dark:hover:bg-neutral-900 dark:focus:bg-neutral-900"
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertSuggestion(source);
                }}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-medium text-neutral-800 dark:text-neutral-100">
                    {source.label}
                  </span>
                  <Badge variant="secondary">{source.valueType}</Badge>
                </span>
                <span className="mt-0.5 block truncate font-mono text-neutral-500">
                  {source.expression}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1.5 text-xs text-neutral-500">
              No matching template variables.
            </p>
          )}
        </div>
      )}
      {issues[0] && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{issues[0].message}</p>
      )}
    </div>
  );
}

function SelectField<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TValue;
  options: TValue[];
  onChange: (value: TValue) => void;
}) {
  return (
    <Field label={label}>
      <NativeSelect value={value} options={options} onChange={onChange} />
    </Field>
  );
}

function NativeSelect<TValue extends string>({
  value,
  options,
  onChange,
}: {
  value: TValue;
  options: TValue[];
  onChange: (value: TValue) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as TValue)}
      className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    </Field>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-neutral-300"
      />
      {label}
    </label>
  );
}

function KeyValueEditor({
  label,
  value,
  templateSources,
  onChange,
}: {
  label: string;
  value: Record<string, unknown>;
  templateSources: WorkflowOutputSource[];
  onChange: (value: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(value);

  function setEntry(index: number, key: string, nextValue: string) {
    const nextEntries = entries.map(([currentKey, currentValue], currentIndex) =>
      currentIndex === index ? [key, nextValue] : [currentKey, stringifyEditableValue(currentValue)],
    );
    onChange(entriesToRecord(nextEntries));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <LabelText>{label}</LabelText>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange({ ...value, [`key${entries.length + 1}`]: '' })}
        >
          Add
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No values configured.
        </p>
      ) : (
        entries.map(([key, currentValue], index) => (
          <div key={`${key}-${index}`} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] gap-2">
            <Input value={key} onChange={(event) => setEntry(index, event.target.value, stringifyEditableValue(currentValue))} placeholder="Key" />
            <TemplateTextInput
              value={stringifyEditableValue(currentValue)}
              templateSources={templateSources}
              onChange={(nextValue) => setEntry(index, key, nextValue)}
              placeholder="Value"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onChange(Object.fromEntries(entries.filter((_, currentIndex) => currentIndex !== index)))}
            >
              Remove
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

function JsonValueField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: Record<string, unknown> | undefined) => void;
}) {
  const [text, setText] = React.useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  function apply() {
    setError(null);
    if (text.trim() === '') {
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Value must be a JSON object.');
        return;
      }
      onChange(parsed as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }

  return (
    <Field label={label}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={apply}
        spellCheck={false}
        rows={4}
        className="w-full resize-y rounded-md border border-neutral-200 bg-white p-2 font-mono text-xs text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Field>
  );
}

function ForeachBodyField({
  value,
  onChange,
}: {
  value: ForeachBodyNode;
  onChange: (value: ForeachBodyNode) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [text, setText] = React.useState(JSON.stringify(value, null, 2));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  function apply() {
    setError(null);
    try {
      const parsed = JSON.parse(text) as WorkflowNode;
      if (!isForeachBodyNode(parsed)) {
        setError('Body must be an llm, tool, set, stop, orchestrator, or session node.');
        return;
      }
      onChange(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }

  function updateBody(patch: Partial<WorkflowNode>) {
    onChange({
      ...value,
      ...patch,
      id: value.id,
      type: value.type,
    } as ForeachBodyNode);
  }

  function updateBodyType(type: ForeachBodyNodeType) {
    if (type === value.type) return;
    const next = getDefaultNodeForType(type, value.id || 'body');
    if (isForeachBodyNode(next)) onChange(next);
  }

  return (
    <div className="space-y-3 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <div className="flex items-center justify-between gap-2">
        <LabelText>Step to run for each item</LabelText>
        <Badge variant="secondary">{value.type}</Badge>
      </div>
      <SelectField
        label="Type"
        value={value.type}
        options={FOREACH_BODY_NODE_TYPES}
        onChange={updateBodyType}
      />
      <NodeParameterFields
        definition={{ version: 'dag/v1', nodes: [value], edges: [] }}
        node={value}
        templateSources={[]}
        onUpdate={updateBody}
      />
      <DisclosureSection
        open={advancedOpen}
        title="Body JSON"
        onOpenChange={setAdvancedOpen}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={apply}
          spellCheck={false}
          rows={8}
          className="w-full resize-y rounded-md border border-neutral-200 bg-white p-2 font-mono text-xs text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </DisclosureSection>
    </div>
  );
}

function WaitPolicyFields({
  value,
  onChange,
}: {
  value?: { mode: 'none' | 'until_idle'; timeout?: string };
  onChange: (value: { mode: 'none' | 'until_idle'; timeout?: string } | undefined) => void;
}) {
  const mode = value?.mode ?? 'none';
  return (
    <>
      <SelectField
        label="Wait mode"
        value={mode}
        options={['none', 'until_idle']}
        onChange={(nextMode) => onChange(nextMode === 'none' ? undefined : { mode: nextMode, timeout: value?.timeout })}
      />
      {mode === 'until_idle' && (
        <Field label="Wait timeout">
          <Input value={value?.timeout ?? ''} onChange={(event) => onChange({ mode: 'until_idle', timeout: optionalString(event.target.value) })} placeholder="30m" />
        </Field>
      )}
    </>
  );
}

function RepoFields({
  value,
  onChange,
}: {
  value?: { url?: string; branch?: string; ref?: string; sourceRepoFullName?: string };
  onChange: (value: { url?: string; branch?: string; ref?: string; sourceRepoFullName?: string } | undefined) => void;
}) {
  function updateRepo(patch: { url?: string; branch?: string; ref?: string; sourceRepoFullName?: string }) {
    const next = { ...(value ?? {}), ...patch };
    const compact = Object.fromEntries(Object.entries(next).filter(([, fieldValue]) => fieldValue)) as {
      url?: string;
      branch?: string;
      ref?: string;
      sourceRepoFullName?: string;
    };
    onChange(Object.keys(compact).length > 0 ? compact : undefined);
  }

  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <LabelText>Repo</LabelText>
      <Input value={value?.url ?? ''} onChange={(event) => updateRepo({ url: event.target.value })} placeholder="URL" />
      <Input value={value?.branch ?? ''} onChange={(event) => updateRepo({ branch: event.target.value })} placeholder="Branch" />
      <Input value={value?.ref ?? ''} onChange={(event) => updateRepo({ ref: event.target.value })} placeholder="Ref" />
      <Input value={value?.sourceRepoFullName ?? ''} onChange={(event) => updateRepo({ sourceRepoFullName: event.target.value })} placeholder="owner/repo" />
    </div>
  );
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function parseWorkflowInputDefault(value: string, type: WorkflowInputDefinition['type']): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (type === 'number') return Number(trimmed);
  if (type === 'boolean') return trimmed === 'true';
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function createSchemaFieldKey(existing: Record<string, WorkflowInputDefinition>): string {
  let index = 1;
  let candidate = 'field';
  while (existing[candidate] !== undefined) {
    index += 1;
    candidate = `field${index}`;
  }
  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringifyEditableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function stringifyPrimitive(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function describeSchemaType(schema: { type?: unknown } | undefined): string {
  if (!schema) return 'unknown';
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type) => type !== 'null').join(' | ') || 'unknown';
  }
  return typeof schema.type === 'string' ? schema.type : 'unknown';
}

function workflowInputDefinitionsToJsonSchemaProperties(
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

function parseConditionRight(value: string, dataType: IfCondition['dataType']): unknown {
  if (value === '') return undefined;
  if (dataType === 'number') return Number(value);
  if (dataType === 'boolean') return value === 'true';
  if (dataType === 'array' || dataType === 'object') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function entriesToRecord(entries: string[][]): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([key]) => key.trim().length > 0));
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.25 7.313a1 1 0 0 1-1.42.001L3.29 9.218a1 1 0 1 1 1.42-1.407l4.04 4.08 6.54-6.595a1 1 0 0 1 1.414-.006Z" clipRule="evenodd" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
    </svg>
  );
}

function isForeachBodyNode(node: WorkflowNode): node is ForeachBodyNode {
  return ['llm', 'tool', 'set', 'stop', 'orchestrator', 'session'].includes(node.type);
}
