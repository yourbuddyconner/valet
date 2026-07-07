import type { Execution, ExecutionApproval, ExecutionNode } from '@/api/executions';
import type { WorkflowNode } from '@valet/shared';

export type ExecutionDisplayStatus = ExecutionNode['status'] | 'not_run';

export function buildExecutionNodeStateMap(nodes: ExecutionNode[]): Map<string, ExecutionNode> {
  const latest = new Map<string, ExecutionNode>();
  for (const node of nodes) {
    latest.set(node.nodeId, node);
  }
  return latest;
}

export function getExecutionDisplayStatus(
  nodeId: string,
  nodeState: Map<string, ExecutionNode>,
  executionStatus?: Execution['status'],
): ExecutionDisplayStatus {
  const status = nodeState.get(nodeId)?.status ?? 'not_run';
  if (!executionStatus) return status;
  return correctNodeStatusForFinishedExecution(status, executionStatus);
}

/**
 * Display-side correction for trace rows the runtime never advanced
 * out of an active state. The foreach approval-sweep can fulfill a
 * body node's wait via a runtime grant without writing a follow-up
 * "completed" trace transition — leaves a node visible as
 * waiting_approval even after the workflow finished. The execution's
 * terminal status is the source of truth: if the workflow finished,
 * the node finished too. Exported so the standalone trace table can
 * apply the same correction.
 */
export function correctNodeStatusForFinishedExecution(
  status: ExecutionDisplayStatus,
  executionStatus: Execution['status'],
): ExecutionDisplayStatus {
  const executionFinished =
    executionStatus === 'completed' || executionStatus === 'failed' || executionStatus === 'cancelled';
  if (!executionFinished) return status;
  if (status === 'completed' || status === 'failed' || status === 'skipped' || status === 'not_run') return status;
  if (executionStatus === 'failed') return 'failed';
  return 'completed';
}

export function formatExecutionDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number') return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function getSelectedNodeApproval(
  selectedNodeId: string | null,
  approvals: ExecutionApproval[] | undefined,
  approvalId?: string | null,
): ExecutionApproval | null {
  return getSelectedNodeApprovals({ selectedNodeId, approvals, approvalId })[0] ?? null;
}

export function getSelectedNodeApprovals({
  selectedNodeId,
  selectedNode,
  approvals,
  approvalId,
}: {
  selectedNodeId: string | null;
  selectedNode?: WorkflowNode | null;
  approvals: ExecutionApproval[] | undefined;
  approvalId?: string | null;
}): ExecutionApproval[] {
  if (!selectedNodeId || !approvals || approvals.length === 0) return [];

  const selectedNodeIds = new Set([selectedNodeId]);
  if (selectedNode?.type === 'foreach') {
    selectedNodeIds.add(selectedNode.body.id);
  }

  const selected: ExecutionApproval[] = [];
  const seen = new Set<string>();
  const addApproval = (approval: ExecutionApproval | undefined) => {
    if (!approval || seen.has(approval.id)) return;
    seen.add(approval.id);
    selected.push(approval);
  };

  // If the selected trace has an approval id, keep that exact approval
  // first. This matters for foreach body traces, whose nodeId is the
  // body node id even though the selectable canvas node is the parent.
  if (approvalId) {
    const exact = approvals.find((approval) => approval.id === approvalId);
    addApproval(exact);
  }

  const nodeApprovals = approvals.filter((approval) => selectedNodeIds.has(approval.nodeId));
  for (const approval of nodeApprovals.filter((approval) => approval.status === 'pending')) {
    addApproval(approval);
  }
  for (const approval of nodeApprovals.filter((approval) => approval.status !== 'pending')) {
    addApproval(approval);
  }

  return selected;
}

export type ParsedExecutionPayload =
  | { kind: 'empty' }
  | { kind: 'json'; value: unknown; formatted: string }
  | { kind: 'text'; text: string };

export interface ExecutionTraceDetailSection {
  title: 'Input' | 'Output' | 'Error' | 'Reason' | 'Auto-approved';
  payload: ParsedExecutionPayload;
  tone: 'neutral' | 'error';
  truncated?: boolean;
}

export interface SessionTraceLink {
  label: 'Open session';
  sessionId: string;
}

export function getNodeParametersForDisplay(node: WorkflowNode | null | undefined): Record<string, unknown> | null {
  if (!node) return null;
  const entries = Object.entries(node).filter(([key, value]) =>
    key !== 'id' && key !== 'type' && value !== undefined
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

export function parseExecutionPayload(value: string | null | undefined): ParsedExecutionPayload {
  if (!value) return { kind: 'empty' };
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'empty' };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return {
      kind: 'json',
      value: parsed,
      formatted: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return {
      kind: 'text',
      text: value,
    };
  }
}

export function buildTraceDetailSections(trace: ExecutionNode | null): ExecutionTraceDetailSection[] {
  if (!trace) return [];

  const sections: ExecutionTraceDetailSection[] = [];
  if (trace.inputPreview) {
    sections.push({
      title: 'Input',
      payload: parseExecutionPayload(trace.inputPreview),
      tone: 'neutral',
      truncated: trace.inputTruncated,
    });
  }
  if (trace.output) {
    sections.push({
      title: 'Output',
      payload: parseExecutionPayload(trace.output),
      tone: 'neutral',
      truncated: trace.outputTruncated,
    });
  }
  if (trace.error) {
    sections.push({
      title: 'Error',
      payload: parseExecutionPayload(trace.error),
      tone: 'error',
    });
  }
  if (trace.reason) {
    sections.push({
      title: 'Reason',
      payload: parseExecutionPayload(trace.reason),
      tone: 'neutral',
    });
  }

  const autoApprovalText = describeAutoApproval(trace);
  if (autoApprovalText) {
    sections.push({
      title: 'Auto-approved',
      payload: { kind: 'text', text: autoApprovalText },
      tone: 'neutral',
    });
  }

  return sections;
}

/**
 * Human-readable explanation of why an invocation was auto-approved
 * without prompting. Returns null when the trace either had no
 * invocation, was denied/prompted, or the resolver fell back to system
 * default (no grant or policy match).
 */
function describeAutoApproval(trace: ExecutionNode): string | null {
  const source = trace.policySource;
  if (!source || source === 'system_default') return null;
  const scope = trace.policyScope ?? 'action';
  const scopeLabel = scope === 'action'
    ? 'exact action'
    : scope === 'service'
      ? 'service'
      : scope === 'risk_level'
        ? 'risk level'
        : 'scope';
  switch (source) {
    case 'runtime_grant':
      return `Auto-approved by a runtime grant (${scopeLabel} match). The grant lives on the session or workflow run; it expires when its parent context completes.`;
    case 'user_policy':
      return `Auto-approved by a durable user policy (${scopeLabel} match). The user previously chose "Always allow" for this target.`;
    case 'admin_policy':
      return `Auto-approved by an admin policy (${scopeLabel} match). Configured at the organization level.`;
    default:
      return null;
  }
}

export function getSessionTraceLink(trace: ExecutionNode | null | undefined): SessionTraceLink | null {
  if (!trace || trace.nodeType !== 'session') return null;

  const directSessionId = trimNonEmpty(trace.sessionId);
  if (directSessionId) return { label: 'Open session', sessionId: directSessionId };

  const output = parseExecutionPayload(trace.output);
  if (output.kind !== 'json' || !isRecord(output.value)) return null;

  const outputSessionId = trimNonEmpty(output.value.sessionId);
  return outputSessionId ? { label: 'Open session', sessionId: outputSessionId } : null;
}

export function getReadableJsonSummary(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return `${count} ${count === 1 ? 'field' : 'fields'}`;
  }
  return formatReadableScalar(value);
}

export function getReadableJsonItemTitle(value: unknown, index: number): string {
  if (!isRecord(value)) return `Item ${index + 1}`;

  const numberValue = value.number;
  const titleValue = firstString(value.title, value.name, value.summary, value.message, value.id);
  if (typeof numberValue === 'number' && titleValue) return `#${numberValue} ${titleValue}`;
  return titleValue || `Item ${index + 1}`;
}

export type ReadableJsonTable =
  | {
      kind: 'matrix';
      columns: string[];
      rows: string[][];
      totalRows: number;
      hiddenRows: number;
      hiddenColumns: number;
    }
  | {
      kind: 'records';
      columns: string[];
      rows: string[][];
      totalRows: number;
      hiddenRows: number;
      hiddenColumns: number;
    };

export function getReadableJsonTable(value: unknown): ReadableJsonTable | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  if (value.every((item) => Array.isArray(item))) {
    const allRows = value as unknown[][];
    const maxColumns = Math.max(0, ...allRows.map((row) => row.length));
    const visibleColumnCount = Math.min(maxColumns, 8);
    const visibleRows = allRows.slice(0, 20);
    return {
      kind: 'matrix',
      columns: Array.from({ length: visibleColumnCount }, (_, index) => String(index + 1)),
      rows: visibleRows.map((row) =>
        Array.from({ length: visibleColumnCount }, (_, index) => formatReadableScalar(row[index])),
      ),
      totalRows: allRows.length,
      hiddenRows: Math.max(0, allRows.length - visibleRows.length),
      hiddenColumns: Math.max(0, maxColumns - visibleColumnCount),
    };
  }

  if (value.every(isRecord)) {
    const records = value as Record<string, unknown>[];
    const columns = collectReadableRecordColumns(records);
    if (columns.length === 0) return null;
    const visibleColumns = columns.slice(0, 8);
    const visibleRows = records.slice(0, 20);
    return {
      kind: 'records',
      columns: visibleColumns,
      rows: visibleRows.map((record) => visibleColumns.map((column) => formatReadableScalar(record[column]))),
      totalRows: records.length,
      hiddenRows: Math.max(0, records.length - visibleRows.length),
      hiddenColumns: Math.max(0, columns.length - visibleColumns.length),
    };
  }

  return null;
}

export function formatReadableScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value || 'empty string';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return getReadableJsonSummary(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function trimNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function collectReadableRecordColumns(records: Record<string, unknown>[]): string[] {
  const preferred = ['id', 'number', 'name', 'title', 'summary', 'status', 'state', 'email', 'url'];
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const key of preferred) {
    if (records.some((record) => Object.prototype.hasOwnProperty.call(record, key))) {
      seen.add(key);
      columns.push(key);
    }
  }

  for (const record of records.slice(0, 20)) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }

  return columns;
}
