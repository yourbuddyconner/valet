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
  WorkflowNode,
} from '@valet/shared';
import type {
  Connection,
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
import { cn } from '@/lib/cn';
import {
  applyDefaultDataFlowForConnection,
  NODE_TYPE_OPTIONS,
  buildToolCatalogIndex,
  createDefaultWorkflowDefinition,
  createEdgeId,
  createFlowNodeData,
  createWorkflowInputPatchForNode,
  createNodeId,
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

type ForeachBodyNodeType = ForeachBodyNode['type'];

const FOREACH_BODY_NODE_TYPES: ForeachBodyNodeType[] = ['llm', 'tool', 'set', 'stop', 'orchestrator', 'session'];

interface VisualWorkflowEditorProps {
  definition: WorkflowDefinition | null;
  onSave: (definition: WorkflowDefinition) => void;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  isSaving?: boolean;
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
  onSave,
  onDefinitionChange,
  isSaving = false,
}: VisualWorkflowEditorProps) {
  const initialDefinition = definition ?? createDefaultWorkflowDefinition();
  const initialFlow = React.useMemo(() => definitionToFlow(initialDefinition), [initialDefinition]);
  const [nodes, setNodes] = React.useState<WorkflowFlowNode[]>(initialFlow.nodes);
  const [edges, setEdges] = React.useState<WorkflowFlowEdge[]>(initialFlow.edges);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(initialFlow.nodes[0]?.id ?? null);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [rawJson, setRawJson] = React.useState('');
  const [rawJsonError, setRawJsonError] = React.useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = React.useState<ReactFlowInstance | null>(null);
  const { getViewport } = useReactFlow();
  const { data: actionCatalog = [] } = useActionCatalog();

  React.useEffect(() => {
    const next = definitionToFlow(definition ?? createDefaultWorkflowDefinition());
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(next.nodes[0]?.id ?? null);
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
    setNodes((current) => applyNodeChanges(safeChanges, current) as unknown as WorkflowFlowNode[]);
  }, []);

  const handleEdgesChange: OnEdgesChange = React.useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current) as WorkflowFlowEdge[]);
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
    setSelectedNodeId(flow.nodes[0]?.id ?? null);
  }

  function handleSave() {
    onSave(currentDefinition());
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
    <div className="grid min-h-[680px] grid-cols-[minmax(0,1fr)_360px] overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
      <div className="relative min-h-[680px]">
        <Canvas
          connectionLineComponent={ConnectionLine}
          edges={edges}
          edgeTypes={edgeTypes}
          fitView
          nodes={nodes}
          nodeTypes={nodeTypes}
          onConnect={handleConnect}
          onEdgesChange={handleEdgesChange}
          onInit={setReactFlowInstance}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onNodesChange={handleNodesChange}
        >
          <Controls />
          <Panel position="top-left" className="flex max-w-[680px] flex-wrap gap-1.5 p-2">
            {NODE_TYPE_OPTIONS.map((option) => (
              <Button
                key={option.type}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => handleAddNode(option.type)}
                title={option.description}
              >
                {option.label}
              </Button>
            ))}
          </Panel>
          <Panel position="bottom-left" className="flex items-center gap-2 px-2 py-1.5">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Drag nodes, connect handles, select items, press Delete to remove.
            </span>
          </Panel>
          {dataFlowWarnings.length > 0 && (
            <Panel position="bottom-right" className="max-w-sm space-y-1 p-2">
              {dataFlowWarnings.map((warning) => (
                <div
                  key={warning.edgeId}
                  className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-100"
                >
                  {warning.message}
                </div>
              ))}
            </Panel>
          )}
        </Canvas>
      </div>

      <aside className="flex min-h-[680px] flex-col border-l border-neutral-200 bg-surface-0 dark:border-neutral-700 dark:bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-700">
          <div>
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Editor
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Configure selected node or raw definition.
            </p>
          </div>
          <Button type="button" onClick={handleSave} disabled={isSaving} size="sm">
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>

        <div className="flex gap-1 border-b border-neutral-200 p-2 dark:border-neutral-700">
          <Button
            type="button"
            variant={!rawOpen ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setRawOpen(false)}
          >
            Node
          </Button>
          <Button
            type="button"
            variant={rawOpen ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setRawOpen(true)}
          >
            JSON
          </Button>
        </div>

        {rawOpen ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <textarea
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded-md border border-neutral-200 bg-white p-3 font-mono text-xs text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            {rawJsonError && <p className="text-xs text-red-600 dark:text-red-400">{rawJsonError}</p>}
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
        ) : (
          <div className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            Select a node to edit its configuration.
          </div>
        )}
      </aside>
    </div>
  );
}

function WorkflowNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as WorkflowFlowNodeData;
  return (
    <Node handles={nodeData.handles} className={cn(selected && 'ring-2 ring-accent/40')}>
      <NodeHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <NodeTitle className="truncate">{nodeData.label}</NodeTitle>
            <NodeDescription className="truncate">{nodeData.node.id}</NodeDescription>
          </div>
          <Badge variant="secondary">{nodeData.nodeType}</Badge>
        </div>
      </NodeHeader>
      <NodeContent>
        <p className="line-clamp-3 text-xs text-neutral-600 dark:text-neutral-300">
          {nodeData.summary}
        </p>
      </NodeContent>
      <NodeFooter>
        <p className="truncate text-xs text-neutral-400">{nodeData.description}</p>
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
      <NodeParameterFields definition={definition} node={workflowNode} onUpdate={onUpdate} />
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
  onUpdate,
}: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  onUpdate: (patch: Partial<WorkflowNode>) => void;
}) {
  switch (node.type) {
    case 'trigger':
      return <TriggerFields node={node} />;
    case 'llm':
      return <LlmFields node={node} onUpdate={onUpdate} />;
    case 'tool':
      return <ToolFields node={node} onUpdate={onUpdate} />;
    case 'if':
      return <IfFields node={node} onUpdate={onUpdate} />;
    case 'foreach':
      return <ForeachFields definition={definition} node={node} onUpdate={onUpdate} />;
    case 'approval':
      return <ApprovalFields node={node} onUpdate={onUpdate} />;
    case 'wait':
      return <WaitFields node={node} onUpdate={onUpdate} />;
    case 'set':
      return <SetFields node={node} onUpdate={onUpdate} />;
    case 'orchestrator':
      return <OrchestratorFields node={node} onUpdate={onUpdate} />;
    case 'session':
      return <SessionFields node={node} onUpdate={onUpdate} />;
    case 'stop':
      return <StopFields node={node} onUpdate={onUpdate} />;
  }
}

function TriggerFields({ node }: { node: TriggerNode }) {
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
      <ToolSchemaContract
        title="Outputs"
        schema={{
          type: 'object',
          properties: {
            type: { type: 'string', description: 'manual, schedule, or webhook' },
            timestamp: { type: 'string', description: 'Invocation timestamp' },
            data: { type: 'object', description: 'Trigger-specific payload' },
            metadata: { type: 'object', description: 'System metadata for the trigger delivery' },
          },
        }}
      />
    </>
  );
}

function LlmFields({ node, onUpdate }: NodeFieldProps<LlmNode>) {
  return (
    <>
      <TextAreaField label="Prompt" value={node.prompt} onChange={(prompt) => onUpdate({ prompt })} minRows={6} />
      <TextAreaField label="System" value={node.system ?? ''} onChange={(system) => onUpdate({ system: optionalString(system) })} minRows={3} />
      <Field label="Model">
        <Input value={node.model ?? ''} onChange={(event) => onUpdate({ model: optionalString(event.target.value) })} placeholder="Default model" />
      </Field>
      <NumberField label="Temperature" value={node.temperature} min={0} max={2} step={0.1} onChange={(temperature) => onUpdate({ temperature })} />
      <NumberField label="Max output tokens" value={node.maxOutputTokens} min={1} step={1} onChange={(maxOutputTokens) => onUpdate({ maxOutputTokens })} />
      <JsonValueField label="Output schema" value={node.outputSchema} onChange={(outputSchema) => onUpdate({ outputSchema })} />
    </>
  );
}

function ToolFields({ node, onUpdate }: NodeFieldProps<ToolNode>) {
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
        <Input value={node.summary ?? ''} onChange={(event) => onUpdate({ summary: optionalString(event.target.value) })} />
      </Field>
      <KeyValueEditor label="Params" value={node.params} onChange={(params) => onUpdate({ params })} />
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

function IfFields({ node, onUpdate }: NodeFieldProps<IfNode>) {
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
              <Input value={condition.left} onChange={(event) => updateCondition(index, { left: event.target.value })} placeholder="{{nodes.start.data.value}}" />
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
          <Input
            value={node.items}
            readOnly={Boolean(selectedSource)}
            onChange={(event) => onUpdate({ items: event.target.value })}
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

function ApprovalFields({ node, onUpdate }: NodeFieldProps<ApprovalNode>) {
  return (
    <>
      <TextAreaField label="Prompt" value={node.prompt} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
      <Field label="Summary">
        <Input value={node.summary ?? ''} onChange={(event) => onUpdate({ summary: optionalString(event.target.value) })} />
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

function SetFields({ node, onUpdate }: NodeFieldProps<SetNode>) {
  return <KeyValueEditor label="Values" value={asRecord(node.values)} onChange={(values) => onUpdate({ values })} />;
}

function OrchestratorFields({ node, onUpdate }: NodeFieldProps<OrchestratorNode>) {
  return (
    <>
      <TextAreaField label="Prompt" value={node.prompt} onChange={(prompt) => onUpdate({ prompt })} minRows={6} />
      <CheckboxField label="Force new thread" checked={Boolean(node.forceNewThread)} onChange={(forceNewThread) => onUpdate({ forceNewThread })} />
      <WaitPolicyFields value={node.wait} onChange={(wait) => onUpdate({ wait })} />
    </>
  );
}

function SessionFields({ node, onUpdate }: NodeFieldProps<SessionNode>) {
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
          <TextAreaField label="Prompt" value={node.prompt} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
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
            <Input value={node.model ?? ''} onChange={(event) => onUpdate({ model: optionalString(event.target.value) })} />
          </Field>
          <RepoFields value={node.repo} onChange={(repo) => onUpdate({ repo })} />
        </>
      ) : (
        <>
          <TextAreaField label="Prompt" value={node.prompt} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
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

function StopFields({ node, onUpdate }: NodeFieldProps<StopNode>) {
  return (
    <>
      <SelectField
        label="Outcome"
        value={node.outcome ?? 'success'}
        options={['success', 'failure']}
        onChange={(outcome) => onUpdate({ outcome })}
      />
      <Field label="Message">
        <Input value={node.message ?? ''} onChange={(event) => onUpdate({ message: optionalString(event.target.value) })} />
      </Field>
      <JsonValueField label="Output" value={node.output} onChange={(output) => onUpdate({ output })} />
    </>
  );
}

interface NodeFieldProps<TNode extends WorkflowNode> {
  node: TNode;
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

function TextAreaField({
  label,
  value,
  onChange,
  minRows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
}) {
  return (
    <Field label={label}>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        rows={minRows}
        className="w-full resize-y rounded-md border border-neutral-200 bg-white p-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
    </Field>
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
  onChange,
}: {
  label: string;
  value: Record<string, unknown>;
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
            <Input value={stringifyEditableValue(currentValue)} onChange={(event) => setEntry(index, key, event.target.value)} placeholder="Value" />
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

function isForeachBodyNode(node: WorkflowNode): node is ForeachBodyNode {
  return ['llm', 'tool', 'set', 'stop', 'orchestrator', 'session'].includes(node.type);
}
