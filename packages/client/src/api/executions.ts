import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from './client';

// Types
export interface ExecutionApproval {
  id: string;
  nodeId: string;
  kind: 'explicit' | 'tool_policy';
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  prompt: string;
  summary: string | null;
  // Parsed JSON. `null` when no details were attached; an object/array
  // otherwise. The runtime renders parameters and human context here for
  // tool_policy approvals (action params), and for explicit approvals
  // when the workflow author passed a `details:` map.
  details: unknown | null;
  timeoutAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  // Foreach iteration index. Set when the approval was raised inside a
  // foreach body; the card uses this to show the "Approve remaining rows"
  // button (scope=workflow_execution + nodeId narrower).
  iterationIndex?: number | null;
  // Set when this approval was raised inside a session that the workflow
  // execution spawned (or a descendant of one). The UI badges it and
  // links to the originating session for resolution instead of rendering
  // inline approve/deny — the resolve endpoints differ between
  // execution-attributed and session-attributed approvals.
  originSessionId?: string | null;
}

export interface Execution {
  id: string;
  workflowId: string;
  workflowName: string | null;
  triggerId: string | null;
  triggerName?: string | null;
  // status union matches the worker's ExecutionStatus (execution-status.ts).
  // 'cancelling' is transient — set when a cancel API call has marked the
  // row but cancel-cleanup hasn't finished yet. 'waiting_time' is a wait
  // node parked on step.sleep.
  status: 'pending' | 'running' | 'waiting_approval' | 'waiting_time' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  triggerType: 'webhook' | 'schedule' | 'manual';
  triggerMetadata: Record<string, unknown> | null;
  triggerData: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  mode?: 'production' | 'test' | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  nodes?: ExecutionNode[];
  // Full approval history for this execution (pending + resolved).
  // Source of truth for the approve/deny UI.
  approvals?: ExecutionApproval[];
  // The DAG that this execution actually ran — captured at trigger
  // time so it survives later edits to the workflow's draft or
  // published version. The canvas renders against this instead of the
  // workflow's current state.
  definitionSnapshot?: unknown;
}

export interface ExecutionNode {
  id: string;
  nodeId: string;
  nodeType: string;
  status: 'pending' | 'running' | 'waiting_approval' | 'waiting_time' | 'skipped' | 'completed' | 'failed';
  inputPreview?: string | null;
  inputTruncated: boolean;
  output?: string | null;
  outputTruncated: boolean;
  error?: string | null;
  reason?: string | null;
  retryAttempts: number;
  approvalId?: string | null;
  invocationId?: string | null;
  sessionId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  createdAt: string;
  // Auto-approval audit metadata. Set when the resolver decided
  // 'allow' because a runtime grant or durable user policy matched —
  // i.e. the user never saw an approval prompt. The trace detail panel
  // uses these to render an "Auto-approved by …" line so the audit
  // chain isn't invisible.
  matchedPolicyId?: string | null;
  matchedGrantId?: string | null;
  policySource?: 'system_default' | 'admin_policy' | 'user_policy' | 'runtime_grant' | null;
  policyScope?: 'action' | 'service' | 'risk_level' | 'none' | null;
}

export interface ListExecutionsResponse {
  executions: Execution[];
}

export interface GetExecutionResponse {
  execution: Execution;
}

export interface CancelExecutionRequest {
  reason?: string;
}

export interface RetryExecutionResponse {
  executionId: string;
  workflowId: string;
  status: Execution['status'] | 'pending';
  retriedFromExecutionId: string;
  deduplicated?: boolean;
}

export const LIVE_EXECUTION_REFETCH_INTERVAL_MS = 2_000;

const TERMINAL_EXECUTION_STATUSES = new Set<Execution['status']>([
  'completed',
  'failed',
  'cancelled',
]);

export function isActiveExecutionStatus(status: Execution['status']): boolean {
  return !TERMINAL_EXECUTION_STATUSES.has(status);
}

export function getExecutionDetailRefetchInterval(data?: GetExecutionResponse): number | false {
  return data?.execution && isActiveExecutionStatus(data.execution.status)
    ? LIVE_EXECUTION_REFETCH_INTERVAL_MS
    : false;
}

export function getExecutionListRefetchInterval(executions?: Execution[]): number | false {
  return executions?.some((execution) => isActiveExecutionStatus(execution.status))
    ? LIVE_EXECUTION_REFETCH_INTERVAL_MS
    : false;
}

// Query keys
export const executionKeys = {
  all: ['executions'] as const,
  lists: () => [...executionKeys.all, 'list'] as const,
  list: (filters?: { status?: string; workflowId?: string }) =>
    [...executionKeys.lists(), filters] as const,
  infinite: (filters?: { status?: string; workflowId?: string }) =>
    [...executionKeys.all, 'infinite', filters] as const,
  details: () => [...executionKeys.all, 'detail'] as const,
  detail: (id: string) => [...executionKeys.details(), id] as const,
  byWorkflow: (workflowId: string) => [...executionKeys.all, 'workflow', workflowId] as const,
};

// Hooks
export function useExecutions(filters?: { status?: string; workflowId?: string }) {
  const queryParams = new URLSearchParams();
  if (filters?.status) queryParams.set('status', filters.status);
  if (filters?.workflowId) queryParams.set('workflowId', filters.workflowId);
  const query = queryParams.toString();

  return useQuery({
    queryKey: executionKeys.list(filters),
    queryFn: () =>
      api.get<ListExecutionsResponse>(`/executions${query ? `?${query}` : ''}`),
    refetchInterval: (query) => getExecutionListRefetchInterval(query.state.data?.executions),
    refetchIntervalInBackground: true,
  });
}

export function useInfiniteExecutions(filters?: { status?: string; workflowId?: string }) {
  return useInfiniteQuery({
    queryKey: executionKeys.infinite(filters),
    queryFn: ({ pageParam = 0 }) => {
      const queryParams = new URLSearchParams();
      if (filters?.status) queryParams.set('status', filters.status);
      if (filters?.workflowId) queryParams.set('workflowId', filters.workflowId);
      queryParams.set('offset', String(pageParam));
      queryParams.set('limit', '20');
      return api.get<ListExecutionsResponse>(`/executions?${queryParams.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.executions.length < 20) return undefined;
      return allPages.length * 20;
    },
    select: (data) => ({
      executions: data.pages.flatMap((page) => page.executions),
      hasMore: data.pages[data.pages.length - 1]?.executions.length === 20,
    }),
    refetchInterval: (query) =>
      getExecutionListRefetchInterval(query.state.data?.pages.flatMap((page) => page.executions)),
    refetchIntervalInBackground: true,
  });
}

export function useExecution(executionId: string) {
  return useQuery({
    queryKey: executionKeys.detail(executionId),
    queryFn: () => api.get<GetExecutionResponse>(`/executions/${executionId}`),
    enabled: !!executionId,
    refetchInterval: (query) => getExecutionDetailRefetchInterval(query.state.data),
    refetchIntervalInBackground: true,
  });
}

export function useWorkflowExecutions(workflowId: string) {
  return useQuery({
    queryKey: executionKeys.byWorkflow(workflowId),
    queryFn: () => api.get<ListExecutionsResponse>(`/workflows/${workflowId}/executions`),
    enabled: !!workflowId,
    refetchInterval: (query) => getExecutionListRefetchInterval(query.state.data?.executions),
    refetchIntervalInBackground: true,
  });
}

export interface ListExecutionApprovalsResponse {
  approvals: ExecutionApproval[];
}

/**
 * Pending-approval poll for an execution. The detail endpoint returns
 * the same list, but the hook is broken out so a list/banner view can
 * watch approvals without re-fetching the whole execution tree.
 */
export function useExecutionApprovals(executionId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...executionKeys.detail(executionId), 'approvals'] as const,
    queryFn: () => api.get<ListExecutionApprovalsResponse>(`/executions/${executionId}/approvals`),
    enabled: (options?.enabled ?? true) && !!executionId,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });
}

/**
 * Pending-approvals poll that ALSO surfaces approvals from sessions this
 * execution spawned (and their descendants). Used by the execution
 * detail view so the user sees every approval gate stalling the
 * workflow — not just direct tool-policy / approval-node holds — without
 * having to open each spawned session manually.
 *
 * Rows with `originSessionId` set are session-attributed propagations:
 * the panel badges them and deep-links to the originating session
 * rather than rendering inline approve/deny.
 */
export function usePendingExecutionApprovals(executionId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...executionKeys.detail(executionId), 'pending-approvals'] as const,
    queryFn: () => api.get<ListExecutionApprovalsResponse>(`/executions/${executionId}/pending-approvals`),
    enabled: (options?.enabled ?? true) && !!executionId,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });
}

export interface ResolveApprovalRequest {
  reason?: string;
}

export interface ResolveApprovalResponse {
  status: string;
  timedOut?: boolean;
  alreadyResolved?: boolean;
}

// Scope of a workflow approval decision. 'once' resolves only the
// originating row. 'workflow_execution' persists a runtime grant on the
// execution that the backend uses to sweep currently-pending matching
// invocations AND auto-approve future ones. Pair with `nodeId` to narrow
// the grant to a specific foreach body (the "Approve remaining rows"
// button).
export type ApprovalScope = 'once' | 'workflow_execution';

export interface ResolveApprovalArgs {
  executionId: string;
  approvalId: string;
  reason?: string;
  scope?: ApprovalScope;
  nodeId?: string;
}

export function useApproveExecutionApproval() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ executionId, approvalId, reason, scope, nodeId }: ResolveApprovalArgs) => {
      const body: Record<string, unknown> = {};
      if (reason) body.reason = reason;
      if (scope) body.scope = scope;
      if (nodeId) body.nodeId = nodeId;
      return api.post<ResolveApprovalResponse>(
        `/executions/${executionId}/approvals/${approvalId}/approve`,
        body,
      );
    },
    onSuccess: (_, { executionId }) => {
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: [...executionKeys.detail(executionId), 'approvals'] });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

export function useDenyExecutionApproval() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ executionId, approvalId, reason }: ResolveApprovalArgs) =>
      api.post<ResolveApprovalResponse>(
        `/executions/${executionId}/approvals/${approvalId}/deny`,
        reason ? { reason } : {},
      ),
    onSuccess: (_, { executionId }) => {
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: [...executionKeys.detail(executionId), 'approvals'] });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

export function useCancelExecution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ executionId, data }: { executionId: string; data?: CancelExecutionRequest }) =>
      api.post<{ success: boolean; status: string }>(
        `/executions/${executionId}/cancel`,
        data || {}
      ),
    onSuccess: (_, { executionId }) => {
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

export function useRetryExecution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ executionId }: { executionId: string }) =>
      api.post<RetryExecutionResponse>(
        `/executions/${executionId}/retry`,
        { clientRequestId: crypto.randomUUID() },
      ),
    onSuccess: (result, { executionId }) => {
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(result.executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: executionKeys.byWorkflow(result.workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.all });
    },
  });
}
