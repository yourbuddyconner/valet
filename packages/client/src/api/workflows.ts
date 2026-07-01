import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDefinition, WorkflowValidationError } from '@valet/shared';
import { api } from './client';
import { executionKeys } from './executions';

function createClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Workflow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  version: string;
  data: Record<string, unknown>;
  enabled: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  // Null when the workflow has no published version yet. The list/detail
  // endpoints both return this so the UI can distinguish draft-only
  // workflows (Draft badge) from published ones (Published badge).
  publishedVersionId: string | null;
}

export interface ListWorkflowsResponse {
  workflows: Workflow[];
}

export interface GetWorkflowResponse {
  workflow: Workflow;
}

export interface CreateWorkflowRequest {
  name: string;
  description?: string | null;
  slug?: string | null;
}

export interface UpdateWorkflowRequest {
  name?: string;
  description?: string | null;
  slug?: string | null;
  version?: string;
  enabled?: boolean;
  tags?: string[];
  data?: Record<string, unknown>;
}

export interface GetDraftResponse {
  draft: WorkflowDefinition | null;
  ui: unknown;
  publishedVersionId: string | null;
}

export interface SaveDraftRequest {
  draft: WorkflowDefinition;
  ui?: unknown;
}

export interface ValidateDraftResponse {
  errors: WorkflowValidationError[];
  warnings: WorkflowValidationError[];
}

export interface PublishDraftRequest {
  publishNote?: string;
}

export interface PublishDraftResponse {
  // The publish endpoint returns the freshly-created workflow_definition_versions
  // row nested under `version`. Server source of truth: services/workflow-versions.ts
  // `publishDraft` returns `{ version: PublishedVersion }`.
  version: WorkflowPublishedVersion;
}

export interface TestRunRequest {
  /** Sample trigger payload exposed to templates as {{trigger.data.X}}. */
  triggerData?: Record<string, unknown>;
}

export interface TestRunResponse {
  executionId: string;
  status: 'pending';
}

export interface WorkflowPublishedVersion {
  id: string;
  version: number;
  definitionHash: string;
  publishNote?: string;
  createdAt: string;
}

export interface ListVersionsResponse {
  versions: WorkflowPublishedVersion[];
}

export interface RestoreVersionResponse {
  draft: WorkflowDefinition;
  ui: unknown;
}

// ─── Query keys ──────────────────────────────────────────────────────────────

export const workflowKeys = {
  all: ['workflows'] as const,
  lists: () => [...workflowKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...workflowKeys.lists(), filters] as const,
  details: () => [...workflowKeys.all, 'detail'] as const,
  detail: (id: string) => [...workflowKeys.details(), id] as const,
  executions: (id: string) => [...workflowKeys.detail(id), 'executions'] as const,
  draft: (id: string) => [...workflowKeys.detail(id), 'draft'] as const,
  versions: (id: string) => [...workflowKeys.detail(id), 'versions'] as const,
};

// ─── Workflow CRUD ───────────────────────────────────────────────────────────

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

export function useCreateWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateWorkflowRequest) =>
      api.post<GetWorkflowResponse>('/workflows', data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      queryClient.setQueryData(workflowKeys.detail(response.workflow.id), response);
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

  return useMutation({
    mutationFn: ({ workflowId, variables }: { workflowId: string; variables?: Record<string, unknown> }) =>
      api.post<{
        executionId: string;
        workflowId: string;
        workflowName: string;
        status: string;
        variables: Record<string, unknown>;
        message: string;
      }>('/triggers/manual/run', {
        workflowId,
        variables,
        clientRequestId: createClientRequestId(),
      }),
    onSuccess: (_, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.executions(workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.byWorkflow(workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

// ─── Draft / publish / test-run / versions (dag/v1) ──────────────────────────

export function useWorkflowDraft(workflowId: string) {
  return useQuery({
    queryKey: workflowKeys.draft(workflowId),
    queryFn: () => api.get<GetDraftResponse>(`/workflows/${workflowId}/draft`),
    enabled: !!workflowId,
  });
}

export function useSaveWorkflowDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, ...data }: SaveDraftRequest & { workflowId: string }) =>
      api.put<{ ok: true }>(`/workflows/${workflowId}/draft`, data),
    // Write the just-saved draft straight into the cache. Invalidating
    // instead used to trigger a background GET that could race the
    // copilot's own setQueryData: the refetch would return the
    // pre-copilot server state and silently drop whatever the copilot
    // had just injected into the cache.
    onSuccess: (_, { workflowId, draft, ui }) => {
      queryClient.setQueryData<GetDraftResponse>(
        workflowKeys.draft(workflowId),
        (prev) => ({
          draft,
          ui: ui ?? prev?.ui ?? null,
          publishedVersionId: prev?.publishedVersionId ?? null,
        }),
      );
    },
  });
}

export function useValidateWorkflowDraft() {
  return useMutation({
    mutationFn: ({ workflowId }: { workflowId: string }) =>
      api.post<ValidateDraftResponse>(`/workflows/${workflowId}/validate`),
  });
}

export function usePublishWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, publishNote }: PublishDraftRequest & { workflowId: string }) =>
      api.post<PublishDraftResponse>(`/workflows/${workflowId}/publish`, {
        ...(publishNote ? { publishNote } : {}),
      }),
    onSuccess: (_, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.versions(workflowId) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

export function useTestRunWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, triggerData }: TestRunRequest & { workflowId: string }) =>
      api.post<TestRunResponse>(`/workflows/${workflowId}/test-run`, {
        ...(triggerData !== undefined ? { triggerData } : {}),
      }),
    onSuccess: (_, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.executions(workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.byWorkflow(workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.lists() });
    },
  });
}

export function useWorkflowVersions(workflowId: string) {
  return useQuery({
    queryKey: workflowKeys.versions(workflowId),
    queryFn: () => api.get<ListVersionsResponse>(`/workflows/${workflowId}/versions`),
    enabled: !!workflowId,
  });
}

export function useRestoreWorkflowVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, versionId }: { workflowId: string; versionId: string }) =>
      api.post<RestoreVersionResponse>(
        `/workflows/${workflowId}/versions/${versionId}/restore`,
      ),
    onSuccess: (response, { workflowId }) => {
      queryClient.setQueryData<GetDraftResponse>(
        workflowKeys.draft(workflowId),
        (current) =>
          current
            ? { ...current, draft: response.draft, ui: response.ui }
            : current,
      );
      queryClient.invalidateQueries({ queryKey: workflowKeys.draft(workflowId) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
    },
  });
}
