import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from './client';

// Types
export interface Execution {
  id: string;
  /** Nullable when the source workflow has since been deleted. */
  workflowId: string | null;
  workflowName: string | null;
  /** Snapshot of the workflow body captured at execution time. Use as a fallback for the diagram when workflowId is null. */
  workflowSnapshot: Record<string, unknown> | null;
  sessionId?: string | null;
  triggerId: string | null;
  triggerName?: string | null;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  resumeToken?: string | null;
  triggerType: 'webhook' | 'schedule' | 'manual' | 'retry' | 'test' | 'github';
  triggerMetadata: Record<string, unknown> | null;
  variables: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  steps: ExecutionStep[] | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ExecutionStep {
  stepId: string;
  status: string;
  attempt?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ListExecutionsResponse {
  executions: Execution[];
}

export interface GetExecutionResponse {
  execution: Execution;
}

export interface ExecutionStepTrace {
  id: string;
  executionId: string;
  stepId: string;
  attempt: number;
  status: string;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  workflowStepIndex: number | null;
  sequence: number;
}

export interface GetExecutionStepsResponse {
  steps: ExecutionStepTrace[];
}

export interface CompleteExecutionRequest {
  status: 'completed' | 'failed' | 'cancelled';
  outputs?: Record<string, unknown>;
  steps?: ExecutionStep[];
  error?: string;
  completedAt?: string;
}

export interface ApproveExecutionRequest {
  approve: boolean;
  resumeToken: string;
  reason?: string;
}

export interface CancelExecutionRequest {
  reason?: string;
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
  steps: (id: string) => [...executionKeys.detail(id), 'steps'] as const,
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
  });
}

export function useExecution(executionId: string) {
  return useQuery({
    queryKey: executionKeys.detail(executionId),
    queryFn: () => api.get<GetExecutionResponse>(`/executions/${executionId}`),
    enabled: !!executionId,
  });
}

export function useWorkflowExecutions(workflowId: string) {
  return useQuery({
    queryKey: executionKeys.byWorkflow(workflowId),
    queryFn: () => api.get<ListExecutionsResponse>(`/workflows/${workflowId}/executions`),
    enabled: !!workflowId,
    refetchInterval: 2500,
    refetchIntervalInBackground: true,
  });
}

export function useExecutionSteps(executionId: string) {
  return useQuery({
    queryKey: executionKeys.steps(executionId),
    queryFn: () => api.get<GetExecutionStepsResponse>(`/executions/${executionId}/steps`),
    enabled: !!executionId,
    refetchInterval: executionId ? 2500 : false,
    refetchIntervalInBackground: true,
  });
}

export function useCompleteExecution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ executionId, data }: { executionId: string; data: CompleteExecutionRequest }) =>
      api.post<{ success: boolean; status: string; completedAt: string }>(
        `/executions/${executionId}/complete`,
        data
      ),
    onSuccess: (_, { executionId }) => {
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.steps(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

export function useApproveExecution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ executionId, data }: { executionId: string; data: ApproveExecutionRequest }) =>
      api.post<{ success: boolean; status: string }>(
        `/executions/${executionId}/approve`,
        data
      ),
    onMutate: async ({ executionId, data }) => {
      await queryClient.cancelQueries({ queryKey: executionKeys.detail(executionId) });
      const previous = queryClient.getQueryData<GetExecutionResponse>(
        executionKeys.detail(executionId),
      );
      if (previous) {
        const nextStatus: Execution['status'] = data.approve ? 'running' : 'cancelled';
        const optimistic: GetExecutionResponse = {
          ...previous,
          execution: {
            ...previous.execution,
            status: nextStatus,
          },
        };
        queryClient.setQueryData(executionKeys.detail(executionId), optimistic);
      }
      return { previous };
    },
    onError: (_err, { executionId }, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(executionKeys.detail(executionId), ctx.previous);
      }
    },
    onSettled: (_data, _err, { executionId }) => {
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.steps(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

export interface RetryFromStepRequest {
  stepId: string;
}

export interface RetryFromStepResponse {
  execution: {
    executionId: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    sessionId: string;
    sourceExecutionId: string;
    retryFromStepId: string;
    dispatched: boolean;
  };
}

export function useRetryExecutionFromStep() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      executionId,
      data,
    }: {
      executionId: string;
      data: RetryFromStepRequest;
      // workflowId is passed through so we can invalidate the workflow-scoped
      // execution lists shown on the workflow detail page.
      workflowId?: string | null;
    }) =>
      api.post<RetryFromStepResponse>(
        `/executions/${executionId}/retry-from`,
        data,
      ),
    onSuccess: (_, { executionId, workflowId }) => {
      // Refresh the source execution (now has a retry trail) and the list view.
      queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
      if (workflowId) {
        queryClient.invalidateQueries({ queryKey: executionKeys.byWorkflow(workflowId) });
        // Mirrors workflowKeys.executions(workflowId) from api/workflows.ts.
        // Inlined here to avoid a circular import between workflows.ts and executions.ts.
        queryClient.invalidateQueries({
          queryKey: ['workflows', 'detail', workflowId, 'executions'],
        });
      }
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
      queryClient.invalidateQueries({ queryKey: executionKeys.steps(executionId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}
