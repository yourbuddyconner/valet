import type { ExecutionNode } from '@/api/executions';

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
