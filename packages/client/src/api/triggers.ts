import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { workflowKeys } from './workflows';

function createClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Types
export interface Trigger {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  name: string;
  enabled: boolean;
  type: 'webhook' | 'schedule' | 'manual';
  config: WebhookConfig | ScheduleConfig | ManualConfig;
  variableMapping: Record<string, string> | null;
  webhookUrl?: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfig {
  type: 'webhook';
  path: string;
  method?: 'GET' | 'POST';
  secret?: string;
  headers?: Record<string, string>;
  // Per-trigger requests-per-60s override; default 60. The trigger UI
  // doesn't expose this directly yet, but we round-trip it on PATCH so
  // an API-set value doesn't get silently wiped when a user edits the
  // trigger from the form.
  rateLimit?: number;
}

export interface ScheduleConfig {
  type: 'schedule';
  cron: string;
  timezone?: string;
  target?: 'workflow' | 'orchestrator';
  prompt?: string;
  // Static trigger payload used for each scheduled workflow run.
  triggerData?: Record<string, unknown>;
}

export interface ManualConfig {
  type: 'manual';
}

export type TriggerConfig = WebhookConfig | ScheduleConfig | ManualConfig;

export interface CreateTriggerRequest {
  workflowId?: string;
  name: string;
  enabled?: boolean;
  config: TriggerConfig;
  variableMapping?: Record<string, string>;
}

export interface UpdateTriggerRequest {
  workflowId?: string | null;
  name?: string;
  enabled?: boolean;
  config?: TriggerConfig;
  variableMapping?: Record<string, string>;
}

export interface ListTriggersResponse {
  triggers: Trigger[];
}

export interface GetTriggerResponse {
  trigger: Trigger;
}

// Query keys
export const triggerKeys = {
  all: ['triggers'] as const,
  lists: () => [...triggerKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...triggerKeys.lists(), filters] as const,
  details: () => [...triggerKeys.all, 'detail'] as const,
  detail: (id: string) => [...triggerKeys.details(), id] as const,
  byWorkflow: (workflowId: string) => [...triggerKeys.all, 'workflow', workflowId] as const,
};

// Hooks
export function useTriggers() {
  return useQuery({
    queryKey: triggerKeys.list(),
    queryFn: () => api.get<ListTriggersResponse>('/triggers'),
  });
}

export function useTrigger(triggerId: string) {
  return useQuery({
    queryKey: triggerKeys.detail(triggerId),
    queryFn: () => api.get<GetTriggerResponse>(`/triggers/${triggerId}`),
    enabled: !!triggerId,
  });
}

export interface CreateTriggerResponse extends Trigger {
  // Server returns the webhook token EXACTLY ONCE at create time.
  // Subsequent GET /api/triggers/:id calls never re-expose it. UIs must
  // surface this from the mutation result or the token is lost.
  webhookToken?: string;
}

export function useCreateTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateTriggerRequest) =>
      api.post<CreateTriggerResponse>('/triggers', data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
      if (variables.workflowId) {
        queryClient.invalidateQueries({ queryKey: triggerKeys.byWorkflow(variables.workflowId) });
      }
    },
  });
}

export interface UpdateTriggerResponse {
  success: boolean;
  updatedAt: string;
  // Returned exactly once when PATCH transitions a trigger TO webhook
  // (manual/schedule → webhook). Callers must capture it from this
  // response; GET /api/triggers/:id never echoes it again.
  webhookToken?: string;
  webhookUrl?: string;
}

export function useUpdateTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ triggerId, data }: { triggerId: string; data: UpdateTriggerRequest }) =>
      api.patch<UpdateTriggerResponse>(`/triggers/${triggerId}`, data),
    onSuccess: (_, { triggerId }) => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.detail(triggerId) });
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
    },
  });
}

export function useDeleteTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (triggerId: string) =>
      api.delete<{ success: boolean }>(`/triggers/${triggerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
    },
  });
}

export function useEnableTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (triggerId: string) =>
      api.post<{ success: boolean }>(`/triggers/${triggerId}/enable`),
    onSuccess: (_, triggerId) => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.detail(triggerId) });
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
    },
  });
}

export function useDisableTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (triggerId: string) =>
      api.post<{ success: boolean }>(`/triggers/${triggerId}/disable`),
    onSuccess: (_, triggerId) => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.detail(triggerId) });
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
    },
  });
}

export function useRunTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      triggerId,
      variables,
      triggerData,
    }: {
      triggerId: string;
      variables?: Record<string, unknown>;
      triggerData?: Record<string, unknown>;
    }) =>
      api.post<{
        executionId?: string;
        workflowId?: string | null;
        workflowName?: string | null;
        status: string;
        variables?: Record<string, unknown>;
        // Orchestrator-target triggers also return `sessionId` (the
        // orchestrator session's id, NOT a workflow execution column).
        // Surface it on the trigger run mutation type so UI can deep-link.
        sessionId?: string;
        message: string;
        dispatched?: boolean;
      }>(`/triggers/${triggerId}/run`, {
        ...(variables !== undefined ? { variables } : {}),
        ...(triggerData !== undefined ? { triggerData } : {}),
        clientRequestId: createClientRequestId(),
      }),
    onSuccess: (data) => {
      if (data.workflowId) {
        queryClient.invalidateQueries({ queryKey: workflowKeys.executions(data.workflowId) });
      }
    },
  });
}
