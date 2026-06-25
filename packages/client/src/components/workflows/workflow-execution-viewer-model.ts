import type { ExecutionApproval, ExecutionNode } from '@/api/executions';
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
): ExecutionDisplayStatus {
  return nodeState.get(nodeId)?.status ?? 'not_run';
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
  if (!selectedNodeId || !approvals || approvals.length === 0) return null;

  if (approvalId) {
    const exact = approvals.find((approval) => approval.id === approvalId);
    if (exact) return exact;
  }

  const nodeApprovals = approvals.filter((approval) => approval.nodeId === selectedNodeId);
  return nodeApprovals.find((approval) => approval.status === 'pending') ?? nodeApprovals[0] ?? null;
}

export type ParsedExecutionPayload =
  | { kind: 'empty' }
  | { kind: 'json'; value: unknown; formatted: string }
  | { kind: 'text'; text: string };

export interface ExecutionTraceDetailSection {
  title: 'Input' | 'Output' | 'Error' | 'Reason';
  payload: ParsedExecutionPayload;
  tone: 'neutral' | 'error';
  truncated?: boolean;
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

  return sections;
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
