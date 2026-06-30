import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { NodeProps } from '@xyflow/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Execution, ExecutionApproval, ExecutionNode } from '@/api/executions';
import type { WorkflowDefinition, WorkflowNode } from '@valet/shared';
import { Canvas } from '@/components/ai-elements/canvas';
import { Controls } from '@/components/ai-elements/controls';
import { Edge } from '@/components/ai-elements/edge';
import { ExecutionApprovalCard, ExecutionApprovalPanel } from '@/components/workflows/execution-approval-panel';
import {
  Node,
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
} from '@/components/ai-elements/node';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import {
  createDefaultWorkflowDefinition,
  definitionToFlow,
  type WorkflowFlowNodeData,
} from './workflow-editor-model';
import {
  buildExecutionNodeStateMap,
  buildTraceDetailSections,
  formatReadableScalar,
  formatExecutionDuration,
  getExecutionDisplayStatus,
  getNodeParametersForDisplay,
  getReadableJsonItemTitle,
  getReadableJsonSummary,
  getReadableJsonTable,
  getSelectedNodeApprovals,
  getSessionTraceLink,
  isRecord,
  parseExecutionPayload,
  type ParsedExecutionPayload,
  type ReadableJsonTable,
  type ExecutionDisplayStatus,
} from './workflow-execution-viewer-model';

interface WorkflowExecutionViewerProps {
  definition: WorkflowDefinition | null;
  execution: Execution | null;
  executions: Execution[];
  isLoadingExecution?: boolean;
  selectedExecutionId: string | null;
  selectedNodeId: string | null;
  onSelectExecution: (executionId: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  onRetryExecution?: (executionId: string) => void;
  isRetryingExecution?: boolean;
  /** Embedded mode: caller owns the page chrome (header, retry button)
   *  and is showing exactly one execution, so we hide the executions
   *  sidebar AND the top-right execution summary card. The canvas
   *  takes the full container width and switches to h-full so it can
   *  live inside a sized div rather than a flex parent. */
  embedded?: boolean;
}

interface ExecutionNodeCardData extends WorkflowFlowNodeData {
  executionTrace?: ExecutionNode;
  executionStatus: ExecutionDisplayStatus;
}

const nodeTypes = {
  workflowExecution: ExecutionNodeCard as React.ComponentType<NodeProps>,
};

const edgeTypes = {
  animated: Edge.Animated,
  temporary: Edge.Temporary,
};

export function WorkflowExecutionViewer(props: WorkflowExecutionViewerProps) {
  return (
    <ReactFlowProvider>
      <WorkflowExecutionViewerInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowExecutionViewerInner({
  definition,
  execution,
  executions,
  isLoadingExecution = false,
  selectedExecutionId,
  selectedNodeId,
  onSelectExecution,
  onSelectNode,
  onRetryExecution,
  isRetryingExecution = false,
  embedded = false,
}: WorkflowExecutionViewerProps) {
  const flow = React.useMemo(
    () => definitionToFlow(definition ?? createDefaultWorkflowDefinition()),
    [definition],
  );
  const traceByNode = React.useMemo(
    () => buildExecutionNodeStateMap(execution?.nodes ?? []),
    [execution?.nodes],
  );
  const selectedDefinitionNode = selectedNodeId
    ? definition?.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const [executionPaneOpen, setExecutionPaneOpen] = React.useState(true);
  const [nodePaneOpen, setNodePaneOpen] = React.useState(true);
  const nodes = React.useMemo(
    () =>
      flow.nodes.map((node) => {
        const trace = traceByNode.get(node.id);
        return {
          ...node,
          type: 'workflowExecution',
          draggable: false,
          selectable: true,
          data: {
            ...node.data,
            executionTrace: trace,
            executionStatus: getExecutionDisplayStatus(node.id, traceByNode),
          } satisfies ExecutionNodeCardData,
        };
      }),
    [flow.nodes, traceByNode],
  );
  const selectedTrace = selectedNodeId ? traceByNode.get(selectedNodeId) ?? null : null;

  React.useEffect(() => {
    if (execution) setExecutionPaneOpen(true);
  }, [execution?.id]);

  React.useEffect(() => {
    if (selectedNodeId) setNodePaneOpen(true);
  }, [selectedNodeId]);

  return (
    <div
      className={cn(
        'grid min-h-0 overflow-hidden bg-neutral-50 dark:bg-neutral-950',
        embedded ? 'h-full grid-cols-[minmax(0,1fr)]' : 'flex-1 grid-cols-[280px_minmax(0,1fr)]',
      )}
    >
      {!embedded && (
      <aside className="min-h-0 border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex h-12 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
          <div>
            <h2 className="text-sm font-medium text-neutral-950 dark:text-neutral-100">Executions</h2>
            <p className="text-xs text-neutral-500">{executions.length} runs</p>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          {executions.length === 0 ? (
            <p className="rounded-md border border-dashed border-neutral-200 p-3 text-sm text-neutral-500 dark:border-neutral-800">
              No executions yet.
            </p>
          ) : (
            <div className="space-y-2">
              {executions.slice(0, 40).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectExecution(item.id)}
                  className={cn(
                    'block w-full rounded-md border p-3 text-left transition',
                    item.id === selectedExecutionId
                      ? 'border-accent bg-accent/10 dark:bg-accent/15'
                      : 'border-transparent hover:border-neutral-200 hover:bg-neutral-50 dark:hover:border-neutral-800 dark:hover:bg-neutral-900',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-neutral-950 dark:text-neutral-100">
                      {formatExecutionTimestamp(item.startedAt)}
                    </span>
                    <ExecutionStatusPill status={item.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                    <span>{item.mode ?? item.triggerType}</span>
                    <span>{item.id.slice(0, 8)}</span>
                  </div>
                  {item.error && (
                    <p className="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-400">
                      {item.error}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
      )}

      <div
        className={cn(
          'relative min-h-0',
          '[--surface-1:#f8fafc] [--workflow-edge-branch-stroke:#94a3b8] [--workflow-edge-stroke:#525252]',
          'dark:[--surface-1:#0a0a0a] dark:[--workflow-edge-branch-stroke:#64748b] dark:[--workflow-edge-stroke:#cbd5e1]',
        )}
      >
        <Canvas
          // Remount the canvas when the workflow's node count changes
          // (definition transitions from placeholder to loaded), so
          // React Flow's fitView re-fits to the real graph. Without
          // this the initial fit lands on the 1-node placeholder and
          // we never re-zoom when the real nodes show up — leading
          // to giant nodes filling the viewport.
          key={`${flow.nodes.length}:${flow.edges.length}`}
          className="bg-neutral-50 dark:bg-neutral-950"
          edgeTypes={edgeTypes}
          edges={flow.edges}
          fitView
          nodes={nodes}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={(_, node) => onSelectNode(node.id)}
          onPaneClick={() => onSelectNode(null)}
          panOnDrag
        >
          <Controls className="border-neutral-200 bg-white text-neutral-900 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 [&>button]:text-neutral-700 [&>button]:hover:bg-neutral-100 dark:[&>button]:text-neutral-100 dark:[&>button]:hover:bg-neutral-800" />
          {!embedded && execution && (
            <div className="absolute left-5 top-5 rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-center gap-2">
                <ExecutionStatusPill status={execution.status} />
                <span className="font-mono text-xs text-neutral-500">{execution.id.slice(0, 8)}</span>
              </div>
              <div className="mt-1 text-sm text-neutral-950 dark:text-neutral-100">
                {formatExecutionTimestamp(execution.startedAt)}
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {execution.completedAt ? formatRelativeTime(execution.completedAt) : 'In progress'}
              </div>
            </div>
          )}
          {isLoadingExecution && (
            <div className="absolute inset-0 grid place-items-center bg-white/30 text-sm text-neutral-500 backdrop-blur-[1px] dark:bg-neutral-950/30">
              Loading execution...
            </div>
          )}
          {embedded ? null : execution && executionPaneOpen ? (
            <ExecutionSummaryPane
              execution={execution}
              onRetryExecution={onRetryExecution}
              isRetryingExecution={isRetryingExecution}
              onClose={() => setExecutionPaneOpen(false)}
            />
          ) : execution ? (
            <button
              type="button"
              onClick={() => setExecutionPaneOpen(true)}
              className="absolute right-5 top-5 z-20 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-800 shadow-lg hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
            >
              Execution
            </button>
          ) : null}
          {execution && selectedNodeId && nodePaneOpen ? (
            <SelectedNodeDetailsPane
              execution={execution}
              selectedNodeId={selectedNodeId}
              selectedDefinitionNode={selectedDefinitionNode}
              selectedTrace={selectedTrace}
              onClose={() => setNodePaneOpen(false)}
            />
          ) : execution && selectedNodeId ? (
            <button
              type="button"
              onClick={() => setNodePaneOpen(true)}
              className="absolute bottom-5 right-5 z-20 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-800 shadow-lg hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
            >
              Node details
            </button>
          ) : null}
        </Canvas>
      </div>
    </div>
  );
}

function ExecutionNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as ExecutionNodeCardData;
  const status = nodeData.executionStatus;
  return (
    <Node
      handles={nodeData.handles}
      className={cn(
        'border-neutral-200 bg-white text-neutral-950 shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-100 dark:shadow-black/20',
        '[&_.react-flow__handle]:h-3.5 [&_.react-flow__handle]:w-3.5',
        '[&_.react-flow__handle]:border-white [&_.react-flow__handle]:bg-neutral-700 dark:[&_.react-flow__handle]:border-neutral-950 dark:[&_.react-flow__handle]:bg-neutral-300',
        selected && 'border-accent ring-2 ring-accent/30',
        status === 'completed' && 'border-emerald-300 dark:border-emerald-700',
        status === 'failed' && 'border-red-400 ring-2 ring-red-400/20',
        (status === 'running' || status === 'waiting_approval' || status === 'waiting_time') && 'border-blue-400 ring-2 ring-blue-400/20',
        status === 'skipped' && 'opacity-65',
      )}
    >
      <NodeHeader className="border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <NodeTitle className="truncate text-neutral-950 dark:text-neutral-100">{nodeData.label}</NodeTitle>
            <NodeDescription className="truncate text-neutral-500">{nodeData.node.id}</NodeDescription>
          </div>
          <ExecutionNodeStatusIcon status={status} />
        </div>
      </NodeHeader>
      <NodeContent>
        <p className="line-clamp-3 text-xs text-neutral-700 dark:text-neutral-300">
          {nodeData.executionTrace?.error ?? nodeData.summary}
        </p>
      </NodeContent>
      <NodeFooter className="border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex w-full items-center justify-between gap-2 text-xs text-neutral-500">
          <span className="truncate">{formatNodeStatus(status)}</span>
          <span>{formatExecutionDuration(nodeData.executionTrace?.durationMs)}</span>
        </div>
      </NodeFooter>
    </Node>
  );
}

function ExecutionSummaryPane({
  execution,
  onRetryExecution,
  isRetryingExecution = false,
  onClose,
}: {
  execution: Execution;
  onRetryExecution?: (executionId: string) => void;
  isRetryingExecution?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="nodrag nopan nowheel absolute right-5 top-5 z-20 w-[min(360px,calc(100%-2.5rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/15 dark:border-neutral-800 dark:bg-neutral-950 dark:shadow-black/30">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-neutral-950 dark:text-neutral-100">Execution</h2>
          <p className="truncate font-mono text-xs text-neutral-500">{execution.id.slice(0, 8)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
          aria-label="Close execution details"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <ExecutionStatusPill status={execution.status} />
          {onRetryExecution && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onRetryExecution(execution.id)}
              disabled={isRetryingExecution}
              className="border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
            >
              <RetryIcon />
              {isRetryingExecution ? 'Retrying...' : 'Retry'}
            </Button>
          )}
        </div>
        <div className="space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
          <KeyValue label="Started" value={formatExecutionTimestamp(execution.startedAt)} />
          <KeyValue label="Trigger" value={execution.triggerName ?? execution.triggerType} />
          <KeyValue label="Mode" value={execution.mode ?? 'production'} />
        </div>
        {/* Pending approvals surfaced inline so users don't have to click
            into the gated node to find the approve/deny buttons. The
            panel polls /pending-approvals on its own so it picks up
            spawned-session approvals (cross-context propagation) — the
            execution-detail endpoint only knows about workflow-direct
            gates and would silently hide the propagated ones. */}
        <ExecutionApprovalPanel executionId={execution.id} />
        {execution.error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/40">
            <h3 className="text-xs font-medium text-red-700 dark:text-red-300">Error</h3>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-red-700 dark:text-red-300">
              {execution.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function SelectedNodeDetailsPane({
  execution,
  selectedNodeId,
  selectedDefinitionNode,
  selectedTrace,
  onClose,
}: {
  execution: Execution;
  selectedNodeId: string;
  selectedDefinitionNode: WorkflowNode | null;
  selectedTrace: ExecutionNode | null;
  onClose: () => void;
}) {
  const selectedApprovals = getSelectedNodeApprovals({
    selectedNodeId,
    selectedNode: selectedDefinitionNode,
    approvals: execution.approvals,
    approvalId: selectedTrace?.approvalId,
  });
  const selectedNodeParams = getNodeParametersForDisplay(selectedDefinitionNode);
  const detailSections = buildTraceDetailSections(selectedTrace);
  const nodeType = selectedDefinitionNode?.type ?? selectedTrace?.nodeType ?? 'unknown';
  const nodeStatus = selectedTrace?.status ?? 'not_run';
  const nodeDuration = formatExecutionDuration(selectedTrace?.durationMs);
  const sessionLink = getSessionTraceLink(selectedTrace);

  // Split detail sections by relevance. Output gets pride of place at
  // top (it's the answer to "what did this node do?"). Auto-approved
  // becomes inline header context, not its own block. The rest collapse
  // into a single ordered list below Output.
  const outputSection = detailSections.find((s) => s.title === 'Output');
  const autoApprovedSection = detailSections.find((s) => s.title === 'Auto-approved');
  const secondarySections = detailSections.filter(
    (s) => s.title !== 'Output' && s.title !== 'Auto-approved',
  );
  const autoApprovedText = autoApprovedSection?.payload.kind === 'text'
    ? autoApprovedSection.payload.text
    : null;
  const hasActions = selectedApprovals.length > 0 || sessionLink;
  const hasAnyContent = !!outputSection
    || !!selectedNodeParams
    || secondarySections.length > 0
    || hasActions;

  return (
    <div className="nodrag nopan nowheel absolute bottom-5 right-5 top-5 z-20 flex w-[min(440px,calc(100%-2.5rem))] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/15 dark:border-neutral-800 dark:bg-neutral-950 dark:shadow-black/30">
      {/* Header: one line of metadata, no separate title. The node id
          is the title; type + status + duration are the badge strip. */}
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-200 px-4 pt-4 pb-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-sm font-semibold text-neutral-950 dark:text-neutral-100" title={selectedNodeId}>
            {selectedNodeId}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary">{nodeType}</Badge>
            <NodeTraceStatusPill status={nodeStatus} />
            {selectedTrace?.durationMs !== undefined && selectedTrace?.durationMs !== null && (
              <span className="text-neutral-500 tabular-nums dark:text-neutral-400">{nodeDuration}</span>
            )}
            {autoApprovedText && (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                title={autoApprovedText}
              >
                auto-approved
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
          aria-label="Close node details"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!hasAnyContent ? (
          <div className="p-4">
            <p className="rounded-lg border border-dashed border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
              This node has not recorded parameters or trace payloads for this execution.
            </p>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {/* Output first — for a finished node, this is the answer. */}
            {outputSection && (
              <StructuredPayloadBlock
                title="Output"
                payload={outputSection.payload}
                tone={outputSection.tone}
                truncated={outputSection.truncated}
              />
            )}
            {/* Secondary trace sections (Input / Error / Reason). */}
            {secondarySections.map((section) => (
              <StructuredPayloadBlock
                key={section.title}
                title={section.title}
                payload={section.payload}
                tone={section.tone}
                truncated={section.truncated}
              />
            ))}
            {/* Configured params last among data — it's what was set up,
                not what happened. */}
            {selectedNodeParams && (
              <StructuredPayloadBlock
                title="Configured params"
                payload={parseExecutionPayload(JSON.stringify(selectedNodeParams))}
                tone="neutral"
              />
            )}
          </div>
        )}
      </div>

      {/* Actions at the bottom — these are the things you DO with a
          node (approve, open session). Persistent footer separates
          action from data. */}
      {hasActions && (
        <footer className="shrink-0 space-y-2 border-t border-neutral-200 bg-neutral-50/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
          {selectedApprovals.length > 0 && (
            <ApprovalGroup executionId={execution.id} approvals={selectedApprovals} />
          )}
          {sessionLink && (
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="w-full border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
            >
              <Link to="/sessions/$sessionId" params={{ sessionId: sessionLink.sessionId }}>
                {sessionLink.label}
              </Link>
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}

/**
 * Renders a node's approvals with two layouts depending on status:
 *
 *   - Pending approvals get the full ExecutionApprovalCard — that's
 *     where action lives (approve, deny, sweep buttons).
 *   - Resolved approvals collapse into a compact one-line table; for
 *     a foreach that ran 50 iterations and auto-approved all of them
 *     a full card per row is just 50× the same audit line. The table
 *     row carries iteration index, status, and resolved time; clicking
 *     it expands inline for the full prompt + details when needed.
 */
function ApprovalGroup({
  executionId,
  approvals,
}: {
  executionId: string;
  approvals: ExecutionApproval[];
}) {
  const pending = approvals.filter((a) => a.status === 'pending');
  const resolved = approvals.filter((a) => a.status !== 'pending');
  // Count summary for resolved — collapses "5 executed / 1 denied" etc.
  const counts = resolved.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const countParts = Object.entries(counts).map(([status, n]) => `${n} ${status}`);

  return (
    <div className="space-y-2">
      {pending.map((approval) => (
        <ExecutionApprovalCard key={approval.id} executionId={executionId} approval={approval} />
      ))}
      {resolved.length > 0 && (
        <div className="overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <span>{resolved.length === 1 ? '1 approval' : `${resolved.length} approvals`}</span>
            <span className="truncate">{countParts.join(' · ')}</span>
          </div>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {resolved.map((approval) => (
              <CompactApprovalRow key={approval.id} approval={approval} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CompactApprovalRow({ approval }: { approval: ExecutionApproval }) {
  const [open, setOpen] = React.useState(false);
  const iterLabel = typeof approval.iterationIndex === 'number'
    ? `iter ${approval.iterationIndex}`
    : null;
  const promptOneLine = approval.prompt
    ? approval.prompt.split('\n')[0]
    : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
      >
        <Badge variant={resolvedBadgeVariant(approval.status)} className="shrink-0">{approval.status}</Badge>
        {iterLabel && (
          <span className="shrink-0 font-mono text-neutral-500 dark:text-neutral-400">{iterLabel}</span>
        )}
        {promptOneLine && approval.kind === 'explicit' && (
          <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">{promptOneLine}</span>
        )}
        <span className="ml-auto shrink-0 text-neutral-400 dark:text-neutral-500">
          {approval.resolvedAt ? formatRelativeTime(approval.resolvedAt) : formatRelativeTime(approval.createdAt)}
        </span>
        <span className="shrink-0 text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-neutral-100 bg-neutral-50/60 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/40">
          {approval.prompt && (
            <p className="whitespace-pre-wrap text-pretty text-neutral-900 dark:text-neutral-100">{approval.prompt}</p>
          )}
          {approval.resolvedBy && (
            <p className="text-neutral-500 dark:text-neutral-400">
              by <span className="font-mono">{approval.resolvedBy}</span>
            </p>
          )}
          {approval.details !== null && approval.details !== undefined && (
            <details className="mt-1">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                Details
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-[11px] dark:bg-neutral-950">
                {JSON.stringify(approval.details, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

function resolvedBadgeVariant(status: string): 'success' | 'error' | 'secondary' | 'warning' {
  if (status === 'approved' || status === 'executed') return 'success';
  if (status === 'denied' || status === 'failed') return 'error';
  if (status === 'expired') return 'warning';
  return 'secondary';
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v6h6" />
    </svg>
  );
}

function StructuredPayloadBlock({
  title,
  payload,
  tone,
  truncated,
}: {
  title: string;
  payload: ParsedExecutionPayload;
  tone: 'neutral' | 'error';
  truncated?: boolean;
}) {
  if (payload.kind === 'empty') return null;
  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className={cn(
          'text-xs font-medium',
          tone === 'error' ? 'text-red-700 dark:text-red-300' : 'text-neutral-700 dark:text-neutral-300',
        )}>
          {title}
        </h4>
        <div className="flex items-center gap-1">
          {payload.kind === 'json' && <Badge variant="secondary">{getReadableJsonSummary(payload.value)}</Badge>}
          {truncated && <Badge variant="secondary">truncated</Badge>}
        </div>
      </div>
      {payload.kind === 'json' ? (
        <ReadableJsonValue value={payload.value} tone={tone} />
      ) : (
        <pre className={cn(
          'max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs leading-relaxed',
          tone === 'error'
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300'
            : 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300',
        )}>
          {payload.text}
        </pre>
      )}
    </section>
  );
}

function ReadableJsonValue({
  value,
  tone,
  depth = 0,
}: {
  value: unknown;
  tone: 'neutral' | 'error';
  depth?: number;
}) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <EmptyReadableValue label="No items" tone={tone} />;
    const table = getReadableJsonTable(value);
    if (table) return <ReadableJsonTablePreview table={table} tone={tone} />;

    const visibleItems = value.slice(0, 20);
    return (
      <div className="space-y-2">
        {visibleItems.map((item, index) => {
          const expandable = isExpandableReadableValue(item);
          if (expandable) {
            return (
              <ExpandableReadableJsonValue
                key={index}
                title={getReadableJsonItemTitle(item, index)}
                value={item}
                tone={tone}
                depth={depth + 1}
              />
            );
          }

          return (
            <div
              key={index}
              className={cn(
                'rounded-md border bg-white p-2 text-xs text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100',
                tone === 'error' ? 'border-red-200 dark:border-red-900/50' : 'border-neutral-200 dark:border-neutral-800',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium" title={`Item ${index + 1}`}>
                  Item {index + 1}
                </span>
                <span className="break-words text-right">{formatReadableScalar(item)}</span>
              </div>
            </div>
          );
        })}
        {value.length > visibleItems.length && (
          <p className="text-xs text-neutral-500">
            {value.length - visibleItems.length} more items not shown.
          </p>
        )}
      </div>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <EmptyReadableValue label="No fields" tone={tone} />;
    if (depth >= 8) {
      return (
        <div className="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950">
          {getReadableJsonSummary(value)}
        </div>
      );
    }

    return (
      <div className={cn(
        'overflow-hidden rounded-md border bg-white dark:bg-neutral-950',
        tone === 'error' ? 'border-red-200 dark:border-red-900/50' : 'border-neutral-200 dark:border-neutral-800',
      )}>
        {entries.map(([key, nestedValue]) => {
          const nested = isRecord(nestedValue) || Array.isArray(nestedValue);
          const shouldInline = nested && depth <= 1;
          return (
            <div key={key} className="border-b border-neutral-100 last:border-b-0 dark:border-neutral-800">
              {shouldInline ? (
                <div className="space-y-2 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium text-neutral-700 dark:text-neutral-300" title={key}>
                      {key}
                    </span>
                    <Badge variant="secondary" className="shrink-0">{getReadableJsonSummary(nestedValue)}</Badge>
                  </div>
                  <ReadableJsonValue value={nestedValue} tone={tone} depth={depth + 1} />
                </div>
              ) : nested ? (
                <div className="p-2">
                  <ExpandableReadableJsonValue
                    title={key}
                    value={nestedValue}
                    tone={tone}
                    depth={depth + 1}
                  />
                </div>
              ) : (
                <div className="grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)]">
                  <div className="min-w-0 bg-neutral-50 px-2 py-1.5 text-xs font-medium text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                    <span className="block truncate" title={key}>{key}</span>
                  </div>
                  <div className="min-w-0 px-2 py-1.5 text-xs text-neutral-900 dark:text-neutral-100">
                    <span className="break-words">{formatReadableScalar(nestedValue)}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn(
      'rounded-md border bg-white px-2 py-1.5 text-xs text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100',
      tone === 'error' ? 'border-red-200 dark:border-red-900/50' : 'border-neutral-200 dark:border-neutral-800',
    )}>
      {formatReadableScalar(value)}
    </div>
  );
}

function ReadableJsonTablePreview({ table, tone }: { table: ReadableJsonTable; tone: 'neutral' | 'error' }) {
  return (
    <div className={cn(
      'overflow-auto rounded-md border bg-white dark:bg-neutral-950',
      tone === 'error' ? 'border-red-200 dark:border-red-900/50' : 'border-neutral-200 dark:border-neutral-800',
    )}>
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr className="bg-neutral-50 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <th className="sticky left-0 z-10 w-12 border-b border-neutral-100 bg-neutral-50 px-2 py-2 dark:border-neutral-800 dark:bg-neutral-900">
              #
            </th>
            {table.columns.map((column) => (
              <th
                key={column}
                className="max-w-56 border-b border-neutral-100 px-2 py-2 dark:border-neutral-800"
                title={table.kind === 'matrix' ? `Column ${column}` : column}
              >
                <span className="block truncate">{table.kind === 'matrix' ? `Col ${column}` : column}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              <td className="sticky left-0 z-10 border-b border-neutral-100 bg-white px-2 py-2 font-mono text-[11px] text-neutral-400 dark:border-neutral-800 dark:bg-neutral-950">
                {rowIndex + 1}
              </td>
              {row.map((cell, columnIndex) => (
                <td
                  key={`${rowIndex}-${columnIndex}`}
                  className="max-w-72 border-b border-neutral-100 px-2 py-2 text-neutral-900 dark:border-neutral-800 dark:text-neutral-100"
                >
                  <span className="line-clamp-4 whitespace-pre-wrap break-words" title={cell}>
                    {cell}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(table.hiddenRows > 0 || table.hiddenColumns > 0) && (
        <div className="border-t border-neutral-100 px-2 py-2 text-xs text-neutral-500 dark:border-neutral-800">
          Showing {table.rows.length} of {table.totalRows} rows
          {table.hiddenColumns > 0 ? ` and ${table.columns.length} visible columns` : ''}
          .
        </div>
      )}
    </div>
  );
}

function ExpandableReadableJsonValue({
  title,
  value,
  tone,
  depth,
}: {
  title: string;
  value: unknown;
  tone: 'neutral' | 'error';
  depth: number;
}) {
  const [open, setOpen] = React.useState(false);
  const summary = getReadableJsonSummary(value);

  return (
    <div className={cn(
      'overflow-hidden rounded-md border bg-white dark:bg-neutral-950',
      tone === 'error' ? 'border-red-200 dark:border-red-900/50' : 'border-neutral-200 dark:border-neutral-800',
    )}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-2 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronIcon open={open} />
          <span className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-100" title={title}>
            {title}
          </span>
        </span>
        <Badge variant="secondary" className="shrink-0">{summary}</Badge>
      </button>
      {open ? (
        <div className="border-t border-neutral-100 p-2 dark:border-neutral-800">
          <ReadableJsonValue value={value} tone={tone} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={cn('h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform', open && 'rotate-90')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function isExpandableReadableValue(value: unknown): boolean {
  return (Array.isArray(value) && value.length > 0) || (isRecord(value) && Object.keys(value).length > 0);
}

function EmptyReadableValue({ label, tone }: { label: string; tone: 'neutral' | 'error' }) {
  return (
    <div className={cn(
      'rounded-md border border-dashed px-2 py-1.5 text-xs text-neutral-500',
      tone === 'error' ? 'border-red-200 dark:border-red-900/50' : 'border-neutral-200 dark:border-neutral-800',
    )}>
      {label}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-neutral-800 dark:text-neutral-200" title={value}>
        {value}
      </span>
    </div>
  );
}

function ExecutionStatusPill({ status }: { status: Execution['status'] }) {
  return <Badge variant={executionBadgeVariant(status)}>{formatNodeStatus(status)}</Badge>;
}

function NodeTraceStatusPill({ status }: { status: ExecutionDisplayStatus }) {
  return (
    <Badge
      variant={
        status === 'completed'
          ? 'success'
          : status === 'failed'
            ? 'error'
            : status === 'skipped' || status === 'not_run'
              ? 'secondary'
              : 'default'
      }
    >
      {formatNodeStatus(status)}
    </Badge>
  );
}

function ExecutionNodeStatusIcon({ status }: { status: ExecutionDisplayStatus }) {
  return (
    <span
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold',
        status === 'completed' && 'border-emerald-500 bg-emerald-500 text-white',
        status === 'failed' && 'border-red-500 bg-red-500 text-white',
        (status === 'running' || status === 'waiting_approval' || status === 'waiting_time') && 'border-blue-500 bg-blue-500 text-white',
        status === 'skipped' && 'border-neutral-300 bg-neutral-200 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800',
        status === 'pending' && 'border-neutral-300 bg-white text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900',
        status === 'not_run' && 'border-neutral-200 bg-neutral-100 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900',
      )}
      title={formatNodeStatus(status)}
    >
      {formatNodeStatusInitial(status)}
    </span>
  );
}

function executionBadgeVariant(status: Execution['status']): 'success' | 'error' | 'secondary' | 'default' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'secondary';
    default:
      return 'default';
  }
}

function formatNodeStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatNodeStatusInitial(status: ExecutionDisplayStatus): string {
  switch (status) {
    case 'completed':
      return 'C';
    case 'failed':
      return '!';
    case 'running':
      return 'R';
    case 'waiting_approval':
    case 'waiting_time':
      return 'W';
    case 'skipped':
      return 'S';
    case 'pending':
      return 'P';
    case 'not_run':
      return '-';
  }
}

function formatExecutionTimestamp(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}
