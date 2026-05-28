import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from './client';
import { executionKeys } from './executions';

function createClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Types
export interface Workflow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  version: string;
  data: WorkflowData;
  enabled: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowData {
  id: string;
  name: string;
  description?: string;
  version?: string;
  variables?: Record<string, VariableDefinition>;
  steps: WorkflowStep[];
  constraints?: WorkflowConstraints;
  // Controls whether non-manual execution failures (schedule/webhook) auto-notify
  // the user's orchestrator agent. Defaults to 'orchestrator' when omitted.
  failureNotify?: 'orchestrator' | 'none';
}

export interface VariableDefinition {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: 'agent_prompt' | 'notify' | 'tool' | 'bash' | 'conditional' | 'loop' | 'parallel' | 'approval';
  target?: 'orchestrator';
  tool?: string;
  command?: string;
  description?: string;
  arguments?: Record<string, unknown>;
  goal?: string;
  context?: string;
  content?: string;
  prompt?: string;
  thread?: string;
  interrupt?: boolean;
  awaitTimeoutMs?: number;
  // Persona id (agent_personas.id). Sent to OpenCode as the `system` field for
  // this single `agent_prompt` call, overriding the default per-call.
  persona?: string;
  outputVariable?: string;
  outputSchema?: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description?: string;
  }>;
  condition?: unknown;
  then?: WorkflowStep[];
  else?: WorkflowStep[];
  steps?: WorkflowStep[];
  // `loop.over` accepts either a path string (`outputs.x` / `variables.y`)
  // or an inline array literal.
  over?: string | unknown[];
  itemVar?: string;
  indexVar?: string;
}

export interface WorkflowConstraints {
  maxDuration?: number;
  maxSteps?: number;
  maxToolCalls?: number;
}

export interface WorkflowMutationProposal {
  id: string;
  workflowId: string;
  executionId: string | null;
  proposedBySessionId: string | null;
  baseWorkflowHash: string;
  proposal: Record<string, unknown>;
  diffText: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  reviewNotes: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionHistoryEntry {
  id: string;
  workflowId: string;
  version: string | null;
  workflowHash: string;
  workflowData: Record<string, unknown>;
  source: 'sync' | 'update' | 'proposal_apply' | 'rollback' | 'system';
  sourceProposalId: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ListWorkflowsResponse {
  workflows: Workflow[];
}

export interface GetWorkflowResponse {
  workflow: Workflow;
}

export interface ListWorkflowProposalsResponse {
  proposals: WorkflowMutationProposal[];
}

export interface WorkflowHistoryResponse {
  currentWorkflowHash: string;
  history: WorkflowVersionHistoryEntry[];
}

export interface CreateWorkflowProposalRequest {
  executionId?: string;
  proposedBySessionId?: string;
  baseWorkflowHash: string;
  proposal: Record<string, unknown>;
  diffText?: string;
  expiresAt?: string;
}

export interface ReviewWorkflowProposalRequest {
  approve: boolean;
  notes?: string;
}

export interface ApplyWorkflowProposalRequest {
  reviewNotes?: string;
  version?: string;
}

export interface RollbackWorkflowRequest {
  targetWorkflowHash: string;
  version?: string;
  notes?: string;
}

export interface SyncWorkflowRequest {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  version?: string;
  data: WorkflowData;
}

export interface UpdateWorkflowRequest {
  name?: string;
  description?: string | null;
  slug?: string | null;
  version?: string;
  enabled?: boolean;
  tags?: string[];
  data?: WorkflowData;
}

// Query keys
export const workflowKeys = {
  all: ['workflows'] as const,
  lists: () => [...workflowKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...workflowKeys.lists(), filters] as const,
  details: () => [...workflowKeys.all, 'detail'] as const,
  detail: (id: string) => [...workflowKeys.details(), id] as const,
  executions: (id: string) => [...workflowKeys.detail(id), 'executions'] as const,
  proposals: (id: string) => [...workflowKeys.detail(id), 'proposals'] as const,
  history: (id: string) => [...workflowKeys.detail(id), 'history'] as const,
};

// Hooks
export function useWorkflows() {
  return useQuery({
    queryKey: workflowKeys.list(),
    queryFn: () => api.get<ListWorkflowsResponse>('/workflows'),
  });
}

export function useWorkflow(workflowId: string) {
  return useQuery({
    queryKey: workflowKeys.detail(workflowId),
    queryFn: () => api.get<GetWorkflowResponse>(`/workflows/${workflowId}`),
    enabled: !!workflowId,
  });
}

export function useSyncWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: SyncWorkflowRequest) =>
      api.post<{ success: boolean; id: string }>('/workflows/sync', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

export function useUpdateWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, ...data }: UpdateWorkflowRequest & { workflowId: string }) =>
      api.put<GetWorkflowResponse>(`/workflows/${workflowId}`, data),
    onSuccess: (response, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      queryClient.setQueryData(workflowKeys.detail(workflowId), response);
    },
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workflowId: string) =>
      api.delete<{ success: boolean }>(`/workflows/${workflowId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

export function useRunWorkflow() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: ({ workflowId, variables }: { workflowId: string; variables?: Record<string, unknown> }) =>
      api.post<{
        executionId: string;
        workflowId: string;
        workflowName: string;
        status: string;
        variables: Record<string, unknown>;
        sessionId?: string;
        message: string;
      }>('/triggers/manual/run', {
        workflowId,
        variables,
        clientRequestId: createClientRequestId(),
      }),
    onSuccess: (data, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.executions(workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.byWorkflow(workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
      // Navigate to the new execution so users see live progress instead of
      // staying on the workflow detail page with stale "Recent executions".
      if (data.executionId) {
        navigate({
          to: '/automation/executions/$executionId',
          params: { executionId: data.executionId },
        });
      }
    },
  });
}

export function useWorkflowProposals(workflowId: string, status?: string) {
  const queryParams = new URLSearchParams();
  if (status) queryParams.set('status', status);
  const query = queryParams.toString();

  return useQuery({
    queryKey: [...workflowKeys.proposals(workflowId), status] as const,
    queryFn: () =>
      api.get<ListWorkflowProposalsResponse>(
        `/workflows/${workflowId}/proposals${query ? `?${query}` : ''}`
      ),
    enabled: !!workflowId,
  });
}

export function useWorkflowHistory(workflowId: string) {
  return useQuery({
    queryKey: workflowKeys.history(workflowId),
    queryFn: () => api.get<WorkflowHistoryResponse>(`/workflows/${workflowId}/history`),
    enabled: !!workflowId,
  });
}

export function useCreateWorkflowProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, ...data }: CreateWorkflowProposalRequest & { workflowId: string }) =>
      api.post<{ proposal: WorkflowMutationProposal }>(`/workflows/${workflowId}/proposals`, data),
    onSuccess: (_, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.proposals(workflowId) });
    },
  });
}

export function useReviewWorkflowProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      workflowId,
      proposalId,
      data,
    }: {
      workflowId: string;
      proposalId: string;
      data: ReviewWorkflowProposalRequest;
    }) =>
      api.post<{ success: boolean; status: string; reviewedAt: string }>(
        `/workflows/${workflowId}/proposals/${proposalId}/review`,
        data
      ),
    onSuccess: (_, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.proposals(workflowId) });
    },
  });
}

export function useApplyWorkflowProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      workflowId,
      proposalId,
      data,
    }: {
      workflowId: string;
      proposalId: string;
      data?: ApplyWorkflowProposalRequest;
    }) =>
      api.post<{ success: boolean; proposalId: string; workflow: Workflow }>(
        `/workflows/${workflowId}/proposals/${proposalId}/apply`,
        data || {}
      ),
    onSuccess: (response) => {
      const workflow = response.workflow;
      queryClient.invalidateQueries({ queryKey: workflowKeys.proposals(workflow.id) });
      queryClient.setQueryData<GetWorkflowResponse>(workflowKeys.detail(workflow.id), { workflow });
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

export function useRollbackWorkflowVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      workflowId,
      data,
    }: {
      workflowId: string;
      data: RollbackWorkflowRequest;
    }) =>
      api.post<{ success: boolean; workflow: Workflow }>(`/workflows/${workflowId}/rollback`, data),
    onSuccess: (response) => {
      const workflow = response.workflow;
      queryClient.setQueryData<GetWorkflowResponse>(workflowKeys.detail(workflow.id), { workflow });
      queryClient.invalidateQueries({ queryKey: workflowKeys.history(workflow.id) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.proposals(workflow.id) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.executions(workflow.id) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

export function useDraftWorkflow() {
  return useMutation({
    mutationFn: (vars: { prompt: string; baseDraft?: WorkflowData }) =>
      api.post<{ workflow: WorkflowData; attempts: number }>('/workflows/draft', vars),
  });
}

export function useDraftWorkflowStep() {
  return useMutation({
    mutationFn: (vars: { workflow: WorkflowData; stepIds: string[]; instruction: string }) =>
      api.post<{ workflow: WorkflowData; attempts: number }>('/workflows/draft/step', vars),
  });
}

export interface TestRunWorkflowResponse {
  executionId: string;
  sessionId: string | null;
  status: string;
  dispatched: boolean;
}

export function useTestRunWorkflow() {
  return useMutation({
    mutationFn: (vars: {
      data: WorkflowData;
      variables?: Record<string, unknown>;
      repoUrl?: string;
      branch?: string;
      ref?: string;
    }) => api.post<TestRunWorkflowResponse>('/workflows/test-run', vars),
  });
}
