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
import { createDefaultWorkflowNode, NODE_DOCS } from '@valet/shared';
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
  getSourceHandleTopPercent,
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
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { NodeDocsDrawer } from './node-docs-drawer';
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
import { usePersonas } from '@/api/personas';
import { useAuthStore } from '@/stores/auth';
import {
  applyDefaultDataFlowForConnection,
  buildWorkflowEdgeInspection,
  buildToolCatalogIndex,
  createDefaultWorkflowDefinition,
  createEdgeId,
  createFlowNodeData,
  createWorkflowInputPatchForNode,
  createNodeId,
  deriveWorkflowTemplateSources,
  deriveWorkflowOutputSources,
  definitionToFlow,
  filterNodePaletteOptions,
  flowToDefinition,
  jsonSchemaToWorkflowInputDefinitions,
  LAYOUT_COLUMN_GAP,
  NODE_DESCRIPTIONS,
  NODE_LABELS,
  NODE_PALETTE_LIST_CLASSNAME,
  NODE_PALETTE_PANEL_CLASSNAME,
  removeWorkflowFlowNode,
  updateWorkflowNode,
  validateWorkflowDataFlowEdges,
  workflowInputDefinitionsToJsonSchema,
  workflowInputDefinitionsToJsonSchemaProperties,
  type AddableDagNodeType,
  type JsonSchemaLike,
  type ToolCatalogAction,
  type ToolCatalogService,
  type WorkflowOutputSource,
  type WorkflowSchemaField,
  type WorkflowEdgeInspection,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
  type WorkflowFlowNodeData,
} from './workflow-editor-model';
import {
  filterTemplateSuggestions,
  getTemplateCompletionContext,
  insertTemplateExpression,
  TEMPLATE_SUGGESTION_EXPRESSION_CLASS,
  TEMPLATE_SUGGESTION_LABEL_CLASS,
  TEMPLATE_SUGGESTION_POPOVER_CLASS,
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

interface WorkflowNodeDeleteContextValue {
  armedNodeId: string | null;
  nodeValidationSeverities: ReadonlyMap<string, WorkflowNodeValidationSeverity>;
  requestDelete: (nodeId: string) => void;
}

const WorkflowNodeDeleteContext = React.createContext<WorkflowNodeDeleteContextValue | null>(null);

// Source handle keys: 'default' for the single source most nodes have, or
// 'true'/'false' for the two branches of an if-node.
type SourceHandleKey = 'default' | 'true' | 'false';

interface WorkflowAddNextContextValue {
  // For each node, which source handles are unconnected (and therefore eligible
  // for a "+ what happens next" affordance).
  unconnectedSources: ReadonlyMap<string, ReadonlySet<SourceHandleKey>>;
  onAddNext: (sourceNodeId: string, sourceHandle: SourceHandleKey) => void;
  // One-click variant: skip the palette entirely and immediately wire a new
  // node of the given type downstream of the source. Used by the inspector's
  // "Add next step" buttons so creating a node downstream of the currently-
  // selected one is a single click.
  onAddNextDirect: (
    sourceNodeId: string,
    sourceHandle: SourceHandleKey,
    type: AddableDagNodeType,
  ) => void;
}

const WorkflowAddNextContext = React.createContext<WorkflowAddNextContextValue | null>(null);

// Vertical nudge applied when the computed position would collide with an
// existing node (within this many flow-units in either axis).
const NEW_NODE_COLLISION_NUDGE = 140;
const NEW_NODE_COLLISION_THRESHOLD = 200;

// Pick a sensible (x, y) for a newly-added node.
// 1. Prefer placement adjacent to the user's anchor (selection at the moment
//    the picker opened) — they're usually adding a downstream step.
// 2. Otherwise, place to the right of the rightmost node so new nodes
//    extend the canvas in the natural left-to-right direction.
// 3. Empty graph (only trigger): drop near origin.
// If the chosen spot collides with an existing node, nudge down until clear.
function computeNextNodePosition(
  existing: WorkflowFlowNode[],
  anchorNodeId: string | null,
): { x: number; y: number } {
  const others = existing.filter((n) => n.id !== 'trigger');
  const anchor = anchorNodeId ? existing.find((n) => n.id === anchorNodeId) : null;

  let base: { x: number; y: number };
  if (anchor) {
    base = { x: anchor.position.x + LAYOUT_COLUMN_GAP, y: anchor.position.y };
  } else if (others.length > 0) {
    const rightmost = others.reduce((best, n) => (n.position.x > best.position.x ? n : best));
    base = { x: rightmost.position.x + LAYOUT_COLUMN_GAP, y: rightmost.position.y };
  } else {
    base = { x: 0, y: 0 };
  }

  while (
    existing.some(
      (n) =>
        Math.abs(n.position.x - base.x) < NEW_NODE_COLLISION_THRESHOLD &&
        Math.abs(n.position.y - base.y) < NEW_NODE_COLLISION_THRESHOLD,
    )
  ) {
    base = { x: base.x, y: base.y + NEW_NODE_COLLISION_NUDGE };
  }
  return base;
}

type WorkflowNodeValidationSeverity = 'warning' | 'error';

// After adding a node, briefly fit-view onto it so the user always sees
// where it landed — protects against the "I clicked add and nothing
// happened" case when the canvas is panned far from the placement anchor.
// rAF defers the call until React has committed the new node into the
// React Flow store, otherwise the id is unknown to fitView.
function scheduleFitViewToNode(instance: ReactFlowInstance | null, nodeId: string) {
  if (!instance) return;
  requestAnimationFrame(() => {
    instance.fitView({ nodes: [{ id: nodeId }], duration: 250, padding: 0.3 });
  });
}

// Build a WorkflowFlowEdge from a source/target/handle triple. Shared by
// the user-drag path (handleConnect) and the wire-on-add path
// (handleAddNode), which must agree on edge shape: branch handles get
// type='temporary' + a label, default sources get type='animated'.
function createWorkflowFlowEdge(
  source: string,
  target: string,
  sourceHandle: 'true' | 'false' | undefined,
): WorkflowFlowEdge {
  return {
    id: createEdgeId(source, target, sourceHandle),
    source,
    ...(sourceHandle ? { sourceHandle } : {}),
    target,
    type: sourceHandle ? 'temporary' : 'animated',
    ...(sourceHandle ? { label: sourceHandle } : {}),
    data: {
      ...(sourceHandle ? { fromOutput: sourceHandle } : {}),
    },
  };
}

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
  const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | null>(null);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [nodePaletteOpen, setNodePaletteOpen] = React.useState(false);
  const [docsOpen, setDocsOpen] = React.useState(false);
  const [nodePaletteQuery, setNodePaletteQuery] = React.useState('');
  const [rawJson, setRawJson] = React.useState('');
  const [rawJsonError, setRawJsonError] = React.useState<string | null>(null);
  const [armedDeleteNodeId, setArmedDeleteNodeId] = React.useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = React.useState<ReactFlowInstance | null>(null);
  const deleteResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodePaletteSearchRef = React.useRef<HTMLInputElement | null>(null);
  // Captured at picker-open time so the new node can be placed next to
  // whatever the user had selected, even though opening the picker
  // clears the selection state.
  const lastSelectedBeforePicker = React.useRef<string | null>(null);
  // When the picker was opened via a "+" affordance on an unconnected
  // source handle, this carries the wire we should draw once the user
  // picks a node type.
  const wireOnAddSource = React.useRef<{ nodeId: string; handle: SourceHandleKey } | null>(null);
  const { getViewport } = useReactFlow();
  const { data: actionCatalog = [], isSuccess: actionCatalogLoaded } = useActionCatalog();

  React.useEffect(() => {
    const next = definitionToFlow(definition ?? createDefaultWorkflowDefinition());
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setRawOpen(false);
    setRawJson(JSON.stringify(flowToDefinition(next, definition ?? undefined), null, 2));
  }, [definition]);

  React.useEffect(() => {
    return () => {
      if (deleteResetTimer.current) clearTimeout(deleteResetTimer.current);
    };
  }, []);

  const selectedNode = React.useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );
  const selectedEdge = React.useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId],
  );
  const nodePaletteResults = React.useMemo(
    () => filterNodePaletteOptions(nodePaletteQuery),
    [nodePaletteQuery],
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
    () => validateWorkflowDataFlowEdges(currentDefinition(), actionCatalog, { toolCatalogLoaded: actionCatalogLoaded }),
    [actionCatalog, actionCatalogLoaded, currentDefinition],
  );
  const dataFlowWarningsByEdgeId = React.useMemo(() => {
    const warningsByEdgeId = new Map<string, typeof dataFlowWarnings>();
    for (const warning of dataFlowWarnings) {
      warningsByEdgeId.set(warning.edgeId, [...(warningsByEdgeId.get(warning.edgeId) ?? []), warning]);
    }
    return warningsByEdgeId;
  }, [dataFlowWarnings]);
  const dataFlowWarningNodeIds = React.useMemo(
    () => new Set(dataFlowWarnings.map((warning) => warning.nodeId)),
    [dataFlowWarnings],
  );
  const templateErrorNodeIds = React.useMemo(
    () => actionCatalogLoaded ? deriveWorkflowTemplateErrorNodeIds(currentDefinition(), actionCatalog) : new Set<string>(),
    [actionCatalog, actionCatalogLoaded, currentDefinition],
  );
  const nodeValidationSeverities = React.useMemo(() => {
    const severities = new Map<string, WorkflowNodeValidationSeverity>();
    for (const nodeId of dataFlowWarningNodeIds) {
      severities.set(nodeId, 'warning');
    }
    for (const nodeId of templateErrorNodeIds) {
      severities.set(nodeId, 'error');
    }
    return severities;
  }, [dataFlowWarningNodeIds, templateErrorNodeIds]);
  const edgeInspection = React.useMemo(() => {
    if (!selectedEdge) return null;
    return buildWorkflowEdgeInspection(
      currentDefinition(),
      { from: selectedEdge.source, to: selectedEdge.target, fromOutput: selectedEdge.data.fromOutput },
      actionCatalog,
      { toolCatalogLoaded: actionCatalogLoaded },
    );
  }, [actionCatalog, actionCatalogLoaded, currentDefinition, selectedEdge]);
  const renderedEdges = React.useMemo(
    () => edges.map((edge) => {
      const selected = edge.id === selectedEdgeId;
      const hasWarning = dataFlowWarningsByEdgeId.has(edge.id);
      if (!selected && !hasWarning) return edge;
      return {
        ...edge,
        style: {
          ...(edge.style ?? {}),
          stroke: selected ? 'var(--accent, #635bff)' : '#d97706',
          strokeWidth: selected ? 3 : 2.5,
        },
      };
    }),
    [dataFlowWarningsByEdgeId, edges, selectedEdgeId],
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

  React.useEffect(() => {
    if (!nodePaletteOpen) return;
    const frame = requestAnimationFrame(() => nodePaletteSearchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [nodePaletteOpen]);

  // Auto-collapse the node picker when the inspector opens; otherwise the
  // two side panels overlap visually.
  React.useEffect(() => {
    if (selectedNodeId && nodePaletteOpen) {
      setNodePaletteOpen(false);
    }
  }, [selectedNodeId, nodePaletteOpen]);

  // Whenever the picker closes — via Escape, the X button, the toolbar
  // toggle, or the auto-collapse Effect above — clear the wire / anchor
  // refs. Without this, dismissing the picker after clicking a node's
  // "+ what happens next" would leave a dangling wire that fires on the
  // NEXT unrelated add. handleAddNode reads-and-clears these refs into
  // locals BEFORE returning, so the success path is unaffected.
  React.useEffect(() => {
    if (!nodePaletteOpen) {
      wireOnAddSource.current = null;
      lastSelectedBeforePicker.current = null;
    }
  }, [nodePaletteOpen]);

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
    setSelectedEdgeId((current) => current === edge.id ? null : current);
  }, []);

  const clearArmedDeleteNode = React.useCallback(() => {
    if (deleteResetTimer.current) {
      clearTimeout(deleteResetTimer.current);
      deleteResetTimer.current = null;
    }
    setArmedDeleteNodeId(null);
  }, []);

  const handleEdgeClick = React.useCallback((event: React.MouseEvent, edge: ReactFlowEdge) => {
    event.preventDefault();
    event.stopPropagation();
    setRawOpen(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
    clearArmedDeleteNode();
  }, [clearArmedDeleteNode]);

  const handleRequestDeleteNode = React.useCallback((nodeId: string) => {
    if (nodeId === 'trigger') return;

    if (armedDeleteNodeId !== nodeId) {
      if (deleteResetTimer.current) clearTimeout(deleteResetTimer.current);
      setArmedDeleteNodeId(nodeId);
      deleteResetTimer.current = setTimeout(() => {
        setArmedDeleteNodeId((current) => current === nodeId ? null : current);
        deleteResetTimer.current = null;
      }, 2500);
      return;
    }

    const nextFlow = removeWorkflowFlowNode(
      {
        nodes,
        edges,
        viewport: reactFlowInstance?.getViewport() ?? getViewport(),
      },
      nodeId,
    );
    setNodes(nextFlow.nodes);
    setEdges(nextFlow.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setRawOpen(false);
    clearArmedDeleteNode();
  }, [armedDeleteNodeId, clearArmedDeleteNode, edges, getViewport, nodes, reactFlowInstance]);

  const nodeDeleteContext = React.useMemo<WorkflowNodeDeleteContextValue>(() => ({
    armedNodeId: armedDeleteNodeId,
    nodeValidationSeverities,
    requestDelete: handleRequestDeleteNode,
  }), [armedDeleteNodeId, handleRequestDeleteNode, nodeValidationSeverities]);

  const unconnectedSources = React.useMemo<ReadonlyMap<string, ReadonlySet<SourceHandleKey>>>(() => {
    const result = new Map<string, Set<SourceHandleKey>>();
    for (const node of nodes) {
      const flowHandles = node.data.handles;
      const candidates: SourceHandleKey[] = flowHandles.sourceOutputs?.length
        ? (flowHandles.sourceOutputs as SourceHandleKey[])
        : flowHandles.source
          ? ['default']
          : [];
      if (candidates.length === 0) continue;
      const used = new Set<SourceHandleKey>();
      for (const edge of edges) {
        if (edge.source !== node.id) continue;
        const handle = edge.sourceHandle === 'true' || edge.sourceHandle === 'false'
          ? edge.sourceHandle
          : 'default';
        used.add(handle);
      }
      const free = candidates.filter((h) => !used.has(h));
      if (free.length > 0) result.set(node.id, new Set(free));
    }
    return result;
  }, [edges, nodes]);

  const handleAddNext = React.useCallback((sourceNodeId: string, sourceHandle: SourceHandleKey) => {
    wireOnAddSource.current = { nodeId: sourceNodeId, handle: sourceHandle };
    lastSelectedBeforePicker.current = sourceNodeId;
    setRawOpen(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    clearArmedDeleteNode();
    setNodePaletteOpen(true);
  }, [clearArmedDeleteNode]);

  // 1-click variant: seed the wire refs and call handleAddNode immediately,
  // skipping the palette. Used by the inspector's "Add next step" buttons.
  // handleAddNode is a hoisted function declaration so referencing it
  // earlier in the component is safe; we keep this as a stable callback so
  // the context value identity doesn't churn every render.
  const handleAddNextDirect = React.useCallback(
    (sourceNodeId: string, sourceHandle: SourceHandleKey, type: AddableDagNodeType) => {
      wireOnAddSource.current = { nodeId: sourceNodeId, handle: sourceHandle };
      lastSelectedBeforePicker.current = sourceNodeId;
      setSelectedEdgeId(null);
      clearArmedDeleteNode();
      handleAddNode(type);
    },
    // handleAddNode is a function declaration inside the component; it
    // captures the latest state via closure, so we depend only on the
    // imperative helpers we call explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearArmedDeleteNode],
  );

  const addNextContext = React.useMemo<WorkflowAddNextContextValue>(() => ({
    unconnectedSources,
    onAddNext: handleAddNext,
    onAddNextDirect: handleAddNextDirect,
  }), [handleAddNext, handleAddNextDirect, unconnectedSources]);

  const handleConnect: OnConnect = React.useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const fromOutput = connection.sourceHandle === 'true' || connection.sourceHandle === 'false'
      ? connection.sourceHandle
      : undefined;
    const edge = createWorkflowFlowEdge(connection.source, connection.target, fromOutput);
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
    setSelectedEdgeId(edge.id);
  }, [actionCatalog, definition, edges, getViewport, nodes, reactFlowInstance]);

  function handleAddNode(type: AddableDagNodeType) {
    const wire = wireOnAddSource.current;
    const anchor = lastSelectedBeforePicker.current;
    // Read both refs into locals NOW so the picker-close Effect (which
    // clears them when nodePaletteOpen goes false) can't race the
    // functional state updaters below.
    lastSelectedBeforePicker.current = null;
    wireOnAddSource.current = null;

    if (wire) {
      // Wire-on-add: nodes and edges must be updated together because
      // the round-trip through flowToDefinition needs both. We do the
      // work inside a setNodes functional updater so currentNodes is
      // fresh, then use the same captured edges to keep the two arrays
      // in agreement. setEdges follows with the recomputed flow.
      let computedEdges: WorkflowFlowEdge[] | null = null;
      let computedId: string | null = null;
      setNodes((currentNodes) => {
        const id = createNodeId(type, currentNodes.map((n) => n.id));
        computedId = id;
        const node = createDefaultWorkflowNode(type, id);
        const position = computeNextNodePosition(currentNodes, anchor);
        const flowNode: WorkflowFlowNode = {
          id,
          type: 'workflow',
          position,
          data: createFlowNodeData(node),
        };
        const fromOutput = wire.handle === 'true' || wire.handle === 'false'
          ? wire.handle
          : undefined;
        const newEdge = createWorkflowFlowEdge(wire.nodeId, id, fromOutput);
        const nextDefinition = applyDefaultDataFlowForConnection(
          flowToDefinition(
            {
              nodes: [...currentNodes, flowNode],
              edges: [...edges, newEdge],
              viewport: reactFlowInstance?.getViewport() ?? getViewport(),
            },
            definition ?? undefined,
          ),
          { from: newEdge.source, to: newEdge.target },
          actionCatalog,
        );
        const nextFlow = definitionToFlow(nextDefinition);
        computedEdges = nextFlow.edges;
        return nextFlow.nodes;
      });
      if (computedEdges) setEdges(computedEdges);
      if (computedId) {
        setSelectedNodeId(computedId);
        scheduleFitViewToNode(reactFlowInstance, computedId);
      }
    } else {
      // Non-wire: simple append. Functional updater avoids any stale
      // closure on `nodes` if a concurrent change lands first.
      let computedId: string | null = null;
      setNodes((currentNodes) => {
        const id = createNodeId(type, currentNodes.map((n) => n.id));
        computedId = id;
        const node = createDefaultWorkflowNode(type, id);
        const position = computeNextNodePosition(currentNodes, anchor);
        const flowNode: WorkflowFlowNode = {
          id,
          type: 'workflow',
          position,
          data: createFlowNodeData(node),
        };
        return [...currentNodes, flowNode];
      });
      if (computedId) {
        setSelectedNodeId(computedId);
        scheduleFitViewToNode(reactFlowInstance, computedId);
      }
    }

    setSelectedEdgeId(null);
    clearArmedDeleteNode();
    setRawOpen(false);
    setNodePaletteOpen(false);
    setNodePaletteQuery('');
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
    setSelectedEdgeId(null);
    clearArmedDeleteNode();
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
      <WorkflowNodeDeleteContext.Provider value={nodeDeleteContext}>
        <WorkflowAddNextContext.Provider value={addNextContext}>
        <Canvas
          className="bg-neutral-50 dark:bg-neutral-950"
          connectionLineComponent={ConnectionLine}
          edges={renderedEdges}
          edgeTypes={edgeTypes}
          fitView
          nodes={nodes}
          nodeTypes={nodeTypes}
          onConnect={handleConnect}
          onEdgeClick={handleEdgeClick}
          onEdgeDoubleClick={handleEdgeDoubleClick}
          onEdgesChange={handleEdgesChange}
          onInit={setReactFlowInstance}
          onNodeClick={(_, node) => {
            setRawOpen(false);
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
            if (node.id !== armedDeleteNodeId) clearArmedDeleteNode();
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
            setRawOpen(false);
            setNodePaletteOpen(false);
            clearArmedDeleteNode();
          }}
          onNodesChange={handleNodesChange}
        >
        <Controls className="border-neutral-200 bg-white text-neutral-900 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 [&>button]:text-neutral-700 [&>button]:hover:bg-neutral-100 dark:[&>button]:text-neutral-100 dark:[&>button]:hover:bg-neutral-800" />
        <Panel position="top-right" className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 p-2 shadow-lg backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(
              'h-10 w-10 border border-neutral-200 bg-white p-0 text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800',
              docsOpen && 'border-accent text-accent ring-2 ring-accent/20 dark:border-red-400 dark:text-red-300 dark:ring-red-400/25',
            )}
            title="Node reference"
            aria-pressed={docsOpen}
            onClick={() => setDocsOpen((open) => !open)}
          >
            <span className="font-serif text-base font-semibold leading-none">i</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              clearArmedDeleteNode();
              setRawOpen(true);
            }}
            className="border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            JSON
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(
              'h-10 w-10 border border-neutral-200 bg-white p-0 text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800',
              nodePaletteOpen && 'border-accent text-accent ring-2 ring-accent/20 dark:border-red-400 dark:text-red-300 dark:ring-red-400/25',
            )}
            title="Add node"
            aria-pressed={nodePaletteOpen}
            onClick={() => {
              setRawOpen(false);
              lastSelectedBeforePicker.current = selectedNodeId;
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              clearArmedDeleteNode();
              setNodePaletteOpen((open) => !open);
            }}
          >
            <PlusIcon className="h-5 w-5" />
          </Button>
        </Panel>
        {nodePaletteOpen && (
          <Panel
            position="top-right"
            className={NODE_PALETTE_PANEL_CLASSNAME}
          >
            <div
              className="nodrag nopan flex min-h-0 flex-1 flex-col"
              role="dialog"
              aria-label="Add node"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setNodePaletteOpen(false);
                }
              }}
            >
              <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
                <div>
                  <h2 className="text-base font-semibold text-neutral-950 dark:text-neutral-50">What happens next?</h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Choose a node to add to the workflow.</p>
                </div>
                <button
                  type="button"
                  className="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                  aria-label="Close add node panel"
                  onClick={() => setNodePaletteOpen(false)}
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
              <div className="border-b border-neutral-100 p-4 dark:border-neutral-800">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400 dark:text-neutral-500" />
                  <Input
                    ref={nodePaletteSearchRef}
                    value={nodePaletteQuery}
                    onChange={(event) => setNodePaletteQuery(event.target.value)}
                    placeholder="Search nodes..."
                    className="h-11 pl-9 text-sm"
                  />
                </div>
              </div>
              <div className={NODE_PALETTE_LIST_CLASSNAME}>
                {nodePaletteResults.length > 0 ? (
                  nodePaletteResults.map((result) => (
                    <div key={result.section.id} className="py-1">
                      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                        {result.section.label}
                      </div>
                      <div className="space-y-1">
                        {result.options.map((option) => (
                          <button
                            key={option.type}
                            type="button"
                            className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none dark:hover:bg-neutral-900 dark:focus:bg-neutral-900"
                            onClick={() => handleAddNode(option.type)}
                          >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-500 group-hover:border-neutral-300 group-hover:text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:group-hover:border-neutral-700 dark:group-hover:text-neutral-100">
                              <NodePaletteIcon icon={result.section.icon} className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-neutral-950 dark:text-neutral-50">{option.label}</span>
                              <span className="mt-0.5 block text-xs leading-5 text-neutral-500 dark:text-neutral-400">{option.description}</span>
                            </span>
                            <ChevronRightIcon className="h-4 w-4 shrink-0 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-neutral-500 dark:text-neutral-700 dark:group-hover:text-neutral-400" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-4 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    No nodes match "{nodePaletteQuery}".
                  </div>
                )}
              </div>
            </div>
          </Panel>
        )}
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
          <Panel position="bottom-left" className="max-w-sm space-y-1 p-3">
            {dataFlowWarnings.map((warning) => (
              <button
                key={`${warning.edgeId}:${warning.message}`}
                type="button"
                className="block w-full rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-left text-xs text-amber-900 shadow-sm hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400 dark:border-amber-500/40 dark:bg-amber-950/90 dark:text-amber-100 dark:hover:bg-amber-900"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(warning.edgeId);
                  setRawOpen(false);
                }}
              >
                {warning.message}
              </button>
            ))}
          </Panel>
        )}
        {edgeInspection && (
          <Panel position="bottom-right" className="p-3">
            <DataFlowInspector
              inspection={edgeInspection}
              onClose={() => setSelectedEdgeId(null)}
            />
          </Panel>
        )}
        </Canvas>
        </WorkflowAddNextContext.Provider>
      </WorkflowNodeDeleteContext.Provider>

      <NodeDocsDrawer
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
        focusType={selectedNode?.data.node.type}
      />

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
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    clearArmedDeleteNode();
                    setRawOpen(true);
                  }}
                >
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
                  clearArmedDeleteNode();
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

function SearchIcon({ className }: { className?: string }) {
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
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
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
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function NodePaletteIcon({
  icon,
  className,
}: {
  icon: 'ai' | 'app' | 'data' | 'flow' | 'human';
  className?: string;
}) {
  switch (icon) {
    case 'ai':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2v4" />
          <path d="M12 18v4" />
          <path d="m4.93 4.93 2.83 2.83" />
          <path d="m16.24 16.24 2.83 2.83" />
          <path d="M2 12h4" />
          <path d="M18 12h4" />
          <path d="m4.93 19.07 2.83-2.83" />
          <path d="m16.24 7.76 2.83-2.83" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'app':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'data':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
          <path d="M8 4v16" />
          <path d="M16 4v16" />
        </svg>
      );
    case 'flow':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <path d="M8.5 6H12a4 4 0 0 1 4 4v5.5" />
          <path d="M12 10a4 4 0 0 1 4-4" />
        </svg>
      );
    case 'human':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
          <circle cx="12" cy="7" r="4" />
          <path d="m16.5 11.5 1.5 1.5 3-3" />
        </svg>
      );
  }
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

function deriveWorkflowTemplateErrorNodeIds(
  definition: WorkflowDefinition,
  actionCatalog: ToolCatalogAction[],
): Set<string> {
  const nodeIds = new Set<string>();

  for (const node of definition.nodes) {
    const templateSources = deriveWorkflowTemplateSources(definition, actionCatalog, node.id);
    if (getNodeTemplateValidationIssues(node, templateSources)) {
      nodeIds.add(node.id);
    }
  }

  return nodeIds;
}

function getNodeTemplateValidationIssues(
  node: WorkflowNode,
  templateSources: WorkflowOutputSource[],
): boolean {
  return getNodeTemplateValues(node).some((value) =>
    validateTemplateTags(value, templateSources).length > 0,
  );
}

function getNodeTemplateValues(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'llm':
      return compactStrings([node.prompt, node.system]);
    case 'tool':
      return [
        ...compactStrings([node.summary]),
        ...collectTemplateStrings(node.params),
      ];
    case 'set':
      return collectTemplateStrings(node.values);
    case 'foreach':
      return [node.items];
    case 'approval':
      return [
        ...compactStrings([node.prompt, node.summary]),
        ...collectTemplateStrings(node.details),
      ];
    case 'stop':
      return [
        ...compactStrings([node.message]),
        ...collectTemplateStrings(node.output),
      ];
    case 'orchestrator':
      return compactStrings([node.prompt]);
    case 'session':
      return node.mode === 'start'
        ? compactStrings([node.prompt, node.workspace, node.title])
        : compactStrings([node.prompt, node.sessionId, node.threadId]);
    case 'trigger':
    case 'if':
    case 'wait':
      return [];
  }
}

function collectTemplateStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectTemplateStrings(item));
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap((item) => collectTemplateStrings(item));
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string');
}

function DataFlowInspector({
  inspection,
  onClose,
}: {
  inspection: WorkflowEdgeInspection;
  onClose: () => void;
}) {
  return (
    <div
      className="nodrag nopan flex max-h-[min(32rem,calc(100dvh-12rem))] w-[min(34rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white/95 shadow-2xl backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95"
      role="dialog"
      aria-label="Data flow"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-neutral-950 dark:text-neutral-100">Data flow</h2>
          <p className="mt-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
            {inspection.fromNodeId}
            {inspection.fromOutput ? `:${inspection.fromOutput}` : ''}
            {' -> '}
            {inspection.toNodeId}
          </p>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
          aria-label="Close data flow inspector"
          onClick={onClose}
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {inspection.warnings.length > 0 && (
          <div className="space-y-2">
            {inspection.warnings.map((warning) => (
              <div
                key={warning.message}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/80 dark:text-amber-100"
              >
                {warning.message}
              </div>
            ))}
          </div>
        )}

        <DataFlowSection title="Target input">
          {inspection.targetInputSchema ? (
            <ToolSchemaContract title="Expected inputs" schema={inspection.targetInputSchema} />
          ) : inspection.targetExpectation ? (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">{inspection.targetExpectation.label}</span>
                <Badge variant="secondary">{inspection.targetExpectation.valueType}</Badge>
              </div>
              <p className="mt-2 text-neutral-500 dark:text-neutral-400">{inspection.targetExpectation.description}</p>
              {inspection.configuredExpression && (
                <div className="mt-2 rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
                  {inspection.configuredExpression}
                </div>
              )}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              This node does not declare a typed input contract yet.
            </p>
          )}
        </DataFlowSection>

        <DataFlowSection title="Source outputs">
          {inspection.sourceOutputs.length > 0 ? (
            <div className="space-y-2">
              {inspection.sourceOutputs.map((source) => (
                <WorkflowOutputSourcePreview
                  key={source.expression}
                  source={source}
                  selected={source.expression === inspection.matchedSource?.expression}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              No typed outputs are available from this source node.
            </p>
          )}
        </DataFlowSection>
      </div>
    </div>
  );
}

function DataFlowSection({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{title}</h3>
      {children}
    </section>
  );
}

function WorkflowOutputSourcePreview({
  selected,
  source,
}: {
  selected: boolean;
  source: WorkflowOutputSource;
}) {
  return (
    <div
      className={cn(
        'rounded-md border bg-neutral-50 p-2 text-xs dark:bg-neutral-900',
        selected
          ? 'border-accent ring-2 ring-accent/15 dark:border-red-400 dark:ring-red-400/20'
          : 'border-neutral-200 dark:border-neutral-700',
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-medium text-neutral-800 dark:text-neutral-200">{source.label}</span>
        <Badge variant={selected ? 'default' : 'secondary'}>{source.valueType}</Badge>
      </div>
      <div className="mt-2 rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
        {source.expression}
      </div>
      {source.itemFields && source.itemFields.length > 0 && (
        <div className="mt-2">
          <ForeachItemFields fields={source.itemFields} itemAlias="item" />
        </div>
      )}
    </div>
  );
}

function WorkflowNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as WorkflowFlowNodeData;
  const deleteContext = React.useContext(WorkflowNodeDeleteContext);
  const addNextContext = React.useContext(WorkflowAddNextContext);
  const isDeleteArmed = deleteContext?.armedNodeId === nodeData.node.id;
  const validationSeverity = deleteContext?.nodeValidationSeverities.get(nodeData.node.id) ?? null;
  const hasWarning = validationSeverity === 'warning';
  const hasError = validationSeverity === 'error';
  const canDelete = selected && nodeData.node.type !== 'trigger' && Boolean(deleteContext);
  const unconnectedHandles = addNextContext?.unconnectedSources.get(nodeData.node.id);
  return (
    <Node
      handles={nodeData.handles}
      className={cn(
        'border-neutral-200 bg-white text-neutral-950 shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-100 dark:shadow-black/20',
        // Anchor handles: bumped from React Flow's ~7px default to 14px for an
        // easier hit target when dragging connections between nodes.
        '[&_.react-flow__handle]:h-3.5 [&_.react-flow__handle]:w-3.5',
        '[&_.react-flow__handle]:border-white [&_.react-flow__handle]:bg-neutral-700 dark:[&_.react-flow__handle]:border-neutral-950 dark:[&_.react-flow__handle]:bg-neutral-300',
        hasWarning && 'border-amber-400 ring-2 ring-amber-300/60 dark:border-amber-400 dark:ring-amber-400/40',
        hasError && 'border-red-500 ring-2 ring-red-300/70 dark:border-red-400 dark:ring-red-400/40',
        selected && !validationSeverity && 'border-accent ring-2 ring-accent/30 dark:border-red-400 dark:ring-red-400/35',
        selected && hasWarning && 'border-amber-500 ring-2 ring-amber-400/70 dark:border-amber-300 dark:ring-amber-300/55',
        selected && hasError && 'border-red-500 ring-2 ring-red-400/80 dark:border-red-300 dark:ring-red-300/60',
      )}
    >
      {canDelete && (
        <button
          type="button"
          className={cn(
            'nodrag nopan absolute -right-2 -top-2 z-20 flex h-7 items-center justify-center rounded-full border text-xs font-medium shadow-lg transition',
            isDeleteArmed
              ? 'w-auto gap-1 border-red-500 bg-red-500 px-2 text-white hover:bg-red-600'
              : 'w-7 border-neutral-200 bg-white text-neutral-600 hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-red-500/50 dark:hover:bg-red-950 dark:hover:text-red-300',
          )}
          title={isDeleteArmed ? 'Click again to delete node' : 'Delete node'}
          aria-label={isDeleteArmed ? `Confirm delete ${nodeData.node.id}` : `Delete ${nodeData.node.id}`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteContext?.requestDelete(nodeData.node.id);
          }}
        >
          <CloseIcon className="h-3.5 w-3.5" />
          {isDeleteArmed && <span>Delete</span>}
        </button>
      )}
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
      {unconnectedHandles && addNextContext && Array.from(unconnectedHandles).map((handle) => {
        // Position computed by the same helper ai-elements/node.tsx uses
        // for its Handle layout, so the plus button never drifts off the
        // handle if those positions change.
        const isBranch = handle === 'true' || handle === 'false';
        const top = isBranch
          ? getSourceHandleTopPercent(handle === 'true' ? 0 : 1, 2)
          : getSourceHandleTopPercent(0, 1);
        // Branch handles have a ~28px label to the right of the card; push
        // the plus past it. Default sources have no label.
        const rightOffsetPx = isBranch ? 56 : 26;
        return (
          <button
            key={handle}
            type="button"
            className="nodrag nopan absolute z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-accent bg-white text-accent shadow-sm transition hover:scale-110 hover:bg-accent hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:border-red-400 dark:bg-neutral-900 dark:text-red-300 dark:hover:bg-red-400 dark:hover:text-white"
            style={{ right: -rightOffsetPx, top: `${top}%` }}
            title="What happens next?"
            aria-label={`Add next node${isBranch ? ` for ${handle} branch` : ''}`}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              addNextContext.onAddNext(nodeData.node.id, handle);
            }}
          >
            <PlusIcon className="h-3 w-3" />
          </button>
        );
      })}
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
  const typeLabel = NODE_LABELS[workflowNode.type];
  const typeDescription = NODE_DESCRIPTIONS[workflowNode.type];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <div className="space-y-1">
        <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {typeLabel} node
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{typeDescription}</p>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Node ID
        </label>
        <Input value={node.id} readOnly className="font-mono text-xs" />
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Reference this node's output from another node with{' '}
          <code className="font-mono">{`\${nodes.${node.id}.output}`}</code>.
        </p>
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
      <InspectorAddNextStep nodeId={workflowNode.id} />
    </div>
  );
}

// 1-click downstream-add affordance. Renders inside the inspector when the
// selected node has at least one unconnected source handle. Click a quick-add
// icon → the node lands wired to the selected node's source. No palette
// roundtrip.
function InspectorAddNextStep({ nodeId }: { nodeId: string }) {
  const ctx = React.useContext(WorkflowAddNextContext);
  const handles = ctx?.unconnectedSources.get(nodeId);
  if (!ctx || !handles || handles.size === 0) return null;
  // Prefer 'default'; if only branch handles remain (if-node), fall back to
  // 'true' as the primary quick-add target.
  const targetHandle: SourceHandleKey = handles.has('default')
    ? 'default'
    : handles.has('true')
      ? 'true'
      : 'false';
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <div className="font-medium text-neutral-700 dark:text-neutral-300">Add next step</div>
      <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
        Wires from this node's {targetHandle === 'default' ? 'output' : `${targetHandle} branch`}.
      </p>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {INSPECTOR_QUICK_ADD_TYPES.map((entry) => (
          <button
            key={entry.type}
            type="button"
            className="flex flex-col items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-2 text-[11px] text-neutral-700 transition hover:border-accent hover:bg-accent/5 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:border-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-200"
            title={entry.title}
            onClick={() => ctx.onAddNextDirect(nodeId, targetHandle, entry.type)}
          >
            <NodePaletteIcon icon={entry.icon} className="h-4 w-4" />
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type NodePaletteIconKey = 'ai' | 'app' | 'data' | 'flow' | 'human';

// Quick-add lineup — the high-frequency types from the palette. Keeping it
// tight (3×2 grid) so the inspector doesn't grow unbounded.
const INSPECTOR_QUICK_ADD_TYPES: Array<{
  type: AddableDagNodeType;
  label: string;
  icon: NodePaletteIconKey;
  title: string;
}> = [
  { type: 'llm', label: 'LLM', icon: 'ai', title: 'Add LLM step downstream' },
  { type: 'tool', label: 'Tool', icon: 'app', title: 'Add tool call downstream' },
  { type: 'if', label: 'If', icon: 'flow', title: 'Add conditional branch downstream' },
  { type: 'set', label: 'Set', icon: 'data', title: 'Add set/derive step downstream' },
  { type: 'foreach', label: 'For each', icon: 'flow', title: 'Add for-each loop downstream' },
  { type: 'stop', label: 'Stop', icon: 'flow', title: 'Add stop step downstream' },
];

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
          <span className="font-medium text-neutral-700 dark:text-neutral-300">How the workflow starts</span>
          <Badge variant="secondary">{node.id}</Badge>
        </div>
        <p className="mt-2 text-neutral-500 dark:text-neutral-400">
          Every run begins here. Whatever data the trigger sends becomes this node's output —
          downstream nodes can read it with{' '}
          <code className="font-mono">{`\${nodes.${node.id}.output.data.<field>}`}</code>.
        </p>
      </div>
      <WorkflowSchemaFields
        title="Expected input fields"
        emptyMessage="Declare the fields this workflow expects. Manual runs prompt for these; other nodes can reference them in templates."
        value={node.dataSchema ?? {}}
        onChange={(dataSchema) => onUpdate({ dataSchema: Object.keys(dataSchema).length > 0 ? dataSchema : undefined })}
        help={NODE_DOCS.trigger.fields?.dataSchema?.help}
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

function WorkflowSchemaFields({
  title,
  emptyMessage,
  value,
  onChange,
  showDefault = true,
  help,
}: {
  title: string;
  emptyMessage: string;
  value: Record<string, WorkflowInputDefinition>;
  onChange: (value: Record<string, WorkflowInputDefinition>) => void;
  showDefault?: boolean;
  help?: string;
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
        <LabelText help={help}>{title}</LabelText>
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
          {emptyMessage}
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map(([name, spec], index) => (
            <div key={index} className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
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
              <div className={cn('grid items-center gap-2', showDefault ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)]')}>
                <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={Boolean(spec.required)}
                    onChange={(event) => setEntry(index, name, { required: event.target.checked || undefined })}
                  />
                  Required
                </label>
                {showDefault && (
                  <Input
                    value={stringifyEditableValue(spec.default)}
                    onChange={(event) => setEntry(index, name, { default: parseWorkflowInputDefault(event.target.value, spec.type) })}
                    placeholder="Default"
                  />
                )}
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
  const outputSchemaFields = React.useMemo(
    () => jsonSchemaToWorkflowInputDefinitions(node.outputSchema),
    [node.outputSchema],
  );
  // Open by default when any advanced value is already set so the user
  // doesn't think their saved tuning vanished.
  const hasAdvanced =
    Boolean(node.system) || node.temperature !== undefined || node.maxOutputTokens !== undefined;
  const [advancedOpen, setAdvancedOpen] = React.useState(hasAdvanced);

  return (
    <>
      <TemplateTextAreaField label="User prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={6} />
      <Field label="Model" help={NODE_DOCS.llm.fields?.model?.help}>
        <WorkflowModelPicker value={node.model} onChange={(model) => onUpdate({ model })} />
      </Field>
      <WorkflowSchemaFields
        title="Output schema"
        emptyMessage="Add fields when the model should return structured data instead of a text response."
        value={outputSchemaFields}
        showDefault={false}
        onChange={(definitions) => onUpdate({ outputSchema: workflowInputDefinitionsToJsonSchema(definitions) })}
        help={NODE_DOCS.llm.fields?.outputSchema?.help}
      />
      {node.outputSchema && (
        <ToolSchemaContract title="Outputs" schema={node.outputSchema} />
      )}
      <DisclosureSection open={advancedOpen} onOpenChange={setAdvancedOpen} title="Advanced">
        <TemplateTextAreaField label="System prompt" value={node.system ?? ''} templateSources={templateSources} onChange={(system) => onUpdate({ system: optionalString(system) })} minRows={3} />
        <NumberField label="Temperature" value={node.temperature} min={0} max={2} step={0.1} onChange={(temperature) => onUpdate({ temperature })} help={NODE_DOCS.llm.fields?.temperature?.help} />
        <NumberField label="Max output tokens" value={node.maxOutputTokens} min={1} step={1} onChange={(maxOutputTokens) => onUpdate({ maxOutputTokens })} help={NODE_DOCS.llm.fields?.maxOutputTokens?.help} />
      </DisclosureSection>
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

function WorkflowPersonaPicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const { data: personas = [], isLoading } = usePersonas();
  const selected = personas.find((p) => p.id === value);
  return (
    <select
      value={value ?? ''}
      onChange={(event) => onChange(optionalString(event.target.value))}
      disabled={isLoading}
      className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <option value="">Default persona</option>
      {personas.map((persona) => (
        <option key={persona.id} value={persona.id}>
          {persona.name}
          {persona.isDefault ? ' (default)' : ''}
        </option>
      ))}
      {/* Preserve a previously-saved value that no longer exists in the list so
          we don't silently clear it on the user. */}
      {value && !selected && !isLoading && (
        <option value={value}>{value} (not found)</option>
      )}
    </select>
  );
}

function ToolFields({ node, onUpdate, templateSources }: NodeFieldProps<ToolNode>) {
  const { data: actionCatalog = [], isLoading } = useActionCatalog();
  const catalogIndex = React.useMemo(() => buildToolCatalogIndex(actionCatalog), [actionCatalog]);
  const actions = catalogIndex.actionsByService.get(node.service) ?? [];
  const selectedService = catalogIndex.services.find((service) => service.service === node.service);
  const selectedAction = actions.find((action) => action.actionId === node.action);
  const hasAdvanced = node.retries !== undefined;
  const [advancedOpen, setAdvancedOpen] = React.useState(hasAdvanced);

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
        help={NODE_DOCS.tool.fields?.service?.help}
      />
      <ToolActionPicker
        actions={actions}
        disabled={!node.service}
        isLoading={isLoading}
        selectedAction={selectedAction}
        service={node.service}
        value={node.action}
        onCustomSelect={(action) => onUpdate({ action })}
        onSelect={(action) => {
          // Auto-populate params with the action's declared input keys
          // (preserving any the user has already filled in). Skips the
          // back-and-forth of "select action → copy schema keys by hand".
          const seeded = seedToolParamsFromSchema(action.inputSchema, node.params);
          onUpdate({
            action: action.actionId,
            ...(seeded !== node.params ? { params: seeded } : {}),
          });
        }}
        help={NODE_DOCS.tool.fields?.action?.help}
      />
      {selectedAction?.inputSchema && (
        <ToolSchemaContract title="Input parameters" schema={selectedAction.inputSchema} />
      )}
      {selectedAction?.outputSchema && (
        <ToolSchemaContract title="Outputs" schema={selectedAction.outputSchema} />
      )}
      <Field label="Summary" help={NODE_DOCS.tool.fields?.summary?.help}>
        <TemplateTextInput value={node.summary ?? ''} templateSources={templateSources} onChange={(summary) => onUpdate({ summary: optionalString(summary) })} />
      </Field>
      <KeyValueEditor label="Params" value={node.params} templateSources={templateSources} onChange={(params) => onUpdate({ params })} help={NODE_DOCS.tool.fields?.params?.help} />
      <SelectField
        label="Policy deny"
        value={node.onPolicyDeny ?? 'fail'}
        options={['fail', 'skip']}
        onChange={(onPolicyDeny) => onUpdate({ onPolicyDeny })}
        help={NODE_DOCS.tool.fields?.onPolicyDeny?.help}
      />
      <DisclosureSection open={advancedOpen} onOpenChange={setAdvancedOpen} title="Advanced">
        <NumberField label="Retries" value={node.retries} min={0} step={1} onChange={(retries) => onUpdate({ retries })} help={NODE_DOCS.tool.fields?.retries?.help} />
      </DisclosureSection>
    </>
  );
}

// Seed tool params from an action's input schema. Returns the same object
// reference if no new keys would be added so we can skip an onUpdate. Only
// adds keys that aren't already present — never overwrites a user-provided
// value.
function seedToolParamsFromSchema(
  schema: JsonSchemaLike | undefined,
  current: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || schema.type !== 'object' || !schema.properties) return current;
  const keys = Object.keys(schema.properties);
  const missing = keys.filter((k) => !(k in current));
  if (missing.length === 0) return current;
  const next: Record<string, unknown> = { ...current };
  for (const k of missing) next[k] = '';
  return next;
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
  help,
}: {
  isLoading: boolean;
  selectedService?: ToolCatalogService;
  services: ToolCatalogService[];
  value: string;
  onCustomSelect: (service: string) => void;
  onSelect: (service: ToolCatalogService) => void;
  help?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const customCandidate = query.trim();
  const canUseCustom =
    customCandidate.length > 0 && !services.some((service) => service.service === customCandidate);

  return (
    <Field label="Service" help={help}>
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
  help,
}: {
  actions: ToolCatalogAction[];
  disabled: boolean;
  isLoading: boolean;
  selectedAction?: ToolCatalogAction;
  service: string;
  value: string;
  onCustomSelect: (action: string) => void;
  onSelect: (action: ToolCatalogAction) => void;
  help?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const customCandidate = query.trim();
  const canUseCustom =
    customCandidate.length > 0 && !actions.some((action) => action.actionId === customCandidate);

  return (
    <Field label="Action" help={help}>
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
        help={NODE_DOCS.if.fields?.combinator?.help}
      />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <LabelText help={NODE_DOCS.if.fields?.conditions?.help}>Conditions</LabelText>
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
        help={NODE_DOCS.foreach.fields?.items?.help}
      />
      {selectedSource?.itemFields && selectedSource.itemFields.length > 0 && (
        <ForeachItemFields
          fields={selectedSource.itemFields}
          itemAlias={itemAlias}
        />
      )}
      <ForeachBodyField value={node.body} onChange={(body) => onUpdate({ body })} help={NODE_DOCS.foreach.fields?.body?.help} />
      <DisclosureSection
        open={advancedOpen}
        title="Advanced"
        onOpenChange={setAdvancedOpen}
      >
        <Field label={selectedSource ? 'Generated expression' : 'Items expression'} help={NODE_DOCS.foreach.fields?.items?.help}>
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
          <Field label="Item alias" help={NODE_DOCS.foreach.fields?.itemAlias?.help}>
            <Input value={node.itemAlias ?? ''} onChange={(event) => onUpdate({ itemAlias: optionalString(event.target.value) })} placeholder="item" />
          </Field>
          <Field label="Index alias" help={NODE_DOCS.foreach.fields?.indexAlias?.help}>
            <Input value={node.indexAlias ?? ''} onChange={(event) => onUpdate({ indexAlias: optionalString(event.target.value) })} placeholder="index" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Process limit" value={node.maxItems} min={1} step={1} onChange={(maxItems) => onUpdate({ maxItems })} help={NODE_DOCS.foreach.fields?.maxItems?.help} />
          <NumberField label="Concurrency" value={node.concurrency} min={1} step={1} onChange={(concurrency) => onUpdate({ concurrency })} help={NODE_DOCS.foreach.fields?.concurrency?.help} />
        </div>
        <SelectField
          label="Item error"
          value={node.onItemError ?? 'fail'}
          options={['fail', 'skip', 'collect']}
          onChange={(onItemError) => onUpdate({ onItemError })}
          help={NODE_DOCS.foreach.fields?.onItemError?.help}
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
  help,
}: {
  selectedSource?: WorkflowOutputSource;
  sources: WorkflowOutputSource[];
  value: string;
  onSelect: (source: WorkflowOutputSource) => void;
  help?: string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Field label="Source" help={help}>
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
      <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={5} help={NODE_DOCS.approval.fields?.prompt?.help} />
      <Field label="Summary" help={NODE_DOCS.approval.fields?.summary?.help}>
        <TemplateTextInput value={node.summary ?? ''} templateSources={templateSources} onChange={(summary) => onUpdate({ summary: optionalString(summary) })} />
      </Field>
      <JsonValueField label="Details" value={node.details} onChange={(details) => onUpdate({ details })} help={NODE_DOCS.approval.fields?.details?.help} />
      <Field label="Timeout" help={NODE_DOCS.approval.fields?.timeout?.help}>
        <Input value={node.timeout ?? ''} onChange={(event) => onUpdate({ timeout: optionalString(event.target.value) })} placeholder="24h" />
      </Field>
      <SelectField
        label="On deny"
        value={node.onDeny ?? 'fail'}
        options={['fail', 'skip']}
        onChange={(onDeny) => onUpdate({ onDeny })}
        help={NODE_DOCS.approval.fields?.onDeny?.help}
      />
    </>
  );
}

function WaitFields({ node, onUpdate }: NodeFieldProps<WaitNode>) {
  const durationError = validateWaitDuration(node.duration);
  return (
    <>
      <Field label="Duration" help={NODE_DOCS.wait.fields?.duration?.help}>
        <Input
          value={node.duration}
          onChange={(event) => onUpdate({ duration: event.target.value })}
          placeholder="5m"
          aria-invalid={durationError ? true : undefined}
          className={cn(durationError && 'border-red-500 focus:border-red-500 dark:border-red-500')}
        />
        {durationError && (
          <p className="text-xs text-red-600 dark:text-red-400">{durationError}</p>
        )}
      </Field>
    </>
  );
}

// Surface obvious mistakes (bare numbers, empty, junk) in the inspector
// without trying to match the full parser. The runtime parser in
// duration.ts is the source of truth; this is a guard so the editor flags
// "30" → expects "30s" before the user saves.
function validateWaitDuration(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Duration is required (e.g. "5m", "2h", "1d").';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return 'Missing unit. Use a suffix like "30s", "5m", "2h", "1d".';
  }
  // Permissive shape check — matches "<number><unit>" with optional decimals,
  // or an ISO-8601 duration starting with P/PT. The runtime is the final word.
  const shape = /^(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w)|P[T\d].*)$/i;
  if (!shape.test(trimmed)) {
    return 'Expected a duration like "30s", "5m", "2h", "1d" or an ISO-8601 duration (P1D).';
  }
  return null;
}

function SetFields({ node, onUpdate, templateSources }: NodeFieldProps<SetNode>) {
  return <KeyValueEditor label="Values" value={asRecord(node.values)} templateSources={templateSources} onChange={(values) => onUpdate({ values })} help={NODE_DOCS.set.fields?.values?.help} />;
}

function OrchestratorFields({ node, onUpdate, templateSources }: NodeFieldProps<OrchestratorNode>) {
  const waitMode = node.wait?.mode ?? 'none';
  return (
    <>
      <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={6} help={NODE_DOCS.orchestrator.fields?.prompt?.help} />
      <CheckboxField label="Force new thread" checked={Boolean(node.forceNewThread)} onChange={(forceNewThread) => onUpdate({ forceNewThread })} help={NODE_DOCS.orchestrator.fields?.forceNewThread?.help} />
      <WaitPolicyFields value={node.wait} onChange={(wait) => onUpdate({ wait })} help={NODE_DOCS.orchestrator.fields?.wait?.help} />
      {waitMode === 'until_idle' && (
        <SelectField
          label="Result"
          value={node.resultMode ?? 'last_message'}
          options={['last_message', 'transcript']}
          onChange={(resultMode) => onUpdate({ resultMode })}
          help={NODE_DOCS.orchestrator.fields?.resultMode?.help}
        />
      )}
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
        help={NODE_DOCS.session.fields?.mode?.help}
      />
      {node.mode === 'start' ? (
        <>
          <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
          <Field label="Workspace" help={NODE_DOCS.session.fields?.workspace?.help}>
            <Input value={node.workspace} onChange={(event) => onUpdate({ workspace: event.target.value })} placeholder="repo or workspace" />
          </Field>
          <Field label="Title">
            <Input value={node.title ?? ''} onChange={(event) => onUpdate({ title: optionalString(event.target.value) })} />
          </Field>
          <Field label="Persona" help={NODE_DOCS.session.fields?.personaId?.help}>
            <WorkflowPersonaPicker value={node.personaId} onChange={(personaId) => onUpdate({ personaId })} />
          </Field>
          <Field label="Model">
            <WorkflowModelPicker value={node.model} onChange={(model) => onUpdate({ model })} />
          </Field>
          <RepoFields value={node.repo} onChange={(repo) => onUpdate({ repo })} help={NODE_DOCS.session.fields?.repo?.help} />
        </>
      ) : (
        <>
          <TemplateTextAreaField label="Prompt" value={node.prompt} templateSources={templateSources} onChange={(prompt) => onUpdate({ prompt })} minRows={5} />
          <Field label="Session ID" help={NODE_DOCS.session.fields?.sessionId?.help}>
            <Input value={node.sessionId} onChange={(event) => onUpdate({ sessionId: event.target.value })} />
          </Field>
          <Field label="Thread ID" help={NODE_DOCS.session.fields?.threadId?.help}>
            <Input value={node.threadId ?? ''} onChange={(event) => onUpdate({ threadId: optionalString(event.target.value) })} />
          </Field>
          <CheckboxField label="Force new thread" checked={Boolean(node.forceNewThread)} onChange={(forceNewThread) => onUpdate({ forceNewThread })} help={NODE_DOCS.session.fields?.forceNewThread?.help} />
        </>
      )}
      <WaitPolicyFields value={wait} onChange={(nextWait) => onUpdate({ wait: nextWait })} help={NODE_DOCS.session.fields?.wait?.help} />
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
        help={NODE_DOCS.stop.fields?.outcome?.help}
      />
      <Field label="Message" help={NODE_DOCS.stop.fields?.message?.help}>
        <TemplateTextInput value={node.message ?? ''} templateSources={templateSources} onChange={(message) => onUpdate({ message: optionalString(message) })} />
      </Field>
      <JsonValueField label="Output" value={node.output} onChange={(output) => onUpdate({ output })} help={NODE_DOCS.stop.fields?.output?.help} />
    </>
  );
}

interface NodeFieldProps<TNode extends WorkflowNode> {
  node: TNode;
  templateSources: WorkflowOutputSource[];
  onUpdate: (patch: Partial<TNode>) => void;
}

function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    <div className="space-y-1">
      <LabelText help={help}>{label}</LabelText>
      {children}
    </div>
  );
}

function LabelText({
  children,
  help,
}: {
  children: React.ReactNode;
  /** Optional clarification rendered as an info-icon tooltip after the label. */
  help?: string;
}) {
  // Only switch to inline-flex when there's an icon to align next to the
  // text — otherwise keep the bare <label> layout so unrelated labels
  // across the inspector don't shift baseline alignment.
  return (
    <label
      className={cn(
        'text-xs font-medium text-neutral-700 dark:text-neutral-300',
        help && 'inline-flex items-center gap-1.5',
      )}
    >
      {children}
      {help && <InfoTooltip help={help} />}
    </label>
  );
}

function TemplateTextAreaField({
  label,
  value,
  onChange,
  templateSources,
  minRows = 3,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  templateSources: WorkflowOutputSource[];
  minRows?: number;
  help?: string;
}) {
  return (
    <Field label={label} help={help}>
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
        <div className={TEMPLATE_SUGGESTION_POPOVER_CLASS}>
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
                  <span className={TEMPLATE_SUGGESTION_LABEL_CLASS} title={source.label}>
                    {source.label}
                  </span>
                  <Badge variant="secondary">{source.valueType}</Badge>
                </span>
                <span className={TEMPLATE_SUGGESTION_EXPRESSION_CLASS} title={source.expression}>
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
  help,
}: {
  label: string;
  value: TValue;
  options: TValue[];
  onChange: (value: TValue) => void;
  help?: string;
}) {
  return (
    <Field label={label} help={help}>
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
  help,
}: {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number | undefined) => void;
  help?: string;
}) {
  return (
    <Field label={label} help={help}>
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
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: string;
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
      {help && <InfoTooltip help={help} />}
    </label>
  );
}

function KeyValueEditor({
  label,
  value,
  templateSources,
  onChange,
  help,
}: {
  label: string;
  value: Record<string, unknown>;
  templateSources: WorkflowOutputSource[];
  onChange: (value: Record<string, unknown>) => void;
  help?: string;
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
        <LabelText help={help}>{label}</LabelText>
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
  help,
}: {
  label: string;
  value: unknown;
  onChange: (value: Record<string, unknown> | undefined) => void;
  help?: string;
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
    <Field label={label} help={help}>
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
  help,
}: {
  value: ForeachBodyNode;
  onChange: (value: ForeachBodyNode) => void;
  help?: string;
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
    const next = createDefaultWorkflowNode(type, value.id || 'body');
    if (isForeachBodyNode(next)) onChange(next);
  }

  return (
    <div className="space-y-3 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <div className="flex items-center justify-between gap-2">
        <LabelText help={help}>Step to run for each item</LabelText>
        <Badge variant="secondary">{value.type}</Badge>
      </div>
      <SelectField
        label="Step type"
        value={value.type}
        options={FOREACH_BODY_NODE_TYPES}
        onChange={updateBodyType}
        help="The kind of step the runtime executes for each item. Switching type resets the body fields below to that step's defaults."
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
  help,
}: {
  value?: { mode: 'none' | 'until_idle'; timeout?: string };
  onChange: (value: { mode: 'none' | 'until_idle'; timeout?: string } | undefined) => void;
  help?: string;
}) {
  const mode = value?.mode ?? 'none';
  return (
    <>
      <SelectField
        label="Wait mode"
        value={mode}
        options={['none', 'until_idle']}
        onChange={(nextMode) => onChange(nextMode === 'none' ? undefined : { mode: nextMode, timeout: value?.timeout })}
        help={help}
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
  help,
}: {
  value?: { url?: string; branch?: string; ref?: string; sourceRepoFullName?: string };
  onChange: (value: { url?: string; branch?: string; ref?: string; sourceRepoFullName?: string } | undefined) => void;
  help?: string;
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
      <LabelText help={help}>Repo</LabelText>
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
