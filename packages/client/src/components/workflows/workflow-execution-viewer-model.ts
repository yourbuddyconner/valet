import type { ExecutionApproval, ExecutionNode } from '@/api/executions';

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
