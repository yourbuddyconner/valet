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
  type: 'webhook' | 'schedule' | 'manual' | 'github';
  config: WebhookConfig | ScheduleConfig | ManualConfig | GitHubConfig;
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
}

export interface ScheduleConfig {
  type: 'schedule';
  cron: string;
  timezone?: string;
  target?: 'workflow' | 'orchestrator';
  prompt?: string;
  /** Default variable values for `target: 'workflow'` runs. Ignored for orchestrator target. */
  variables?: Record<string, unknown>;
}

export interface ManualConfig {
  type: 'manual';
}

export interface GitHubConfig {
  type: 'github';
  /** Repos to listen on, in "owner/repo" form. */
  repos: string[];
  /** Events to fire on. e.g. ['pull_request.opened', 'push'] or ['pull_request'] for any pull_request.* */
  events: string[];
  /** Optional filters short-circuited before dispatch. */
  filter?: {
    branch?: string | string[];
    labels?: string[];
    actions?: string[];
  };
}

export type TriggerConfig = WebhookConfig | ScheduleConfig | ManualConfig | GitHubConfig;

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

export type TriggerDeliveryOutcome =
  | 'matched'
  | 'no_match'
  | 'concurrency_cap'
  | 'workflow_deleted'
  | 'duplicate'
  | 'error';

export interface TriggerDelivery {
  id: string;
  triggerId: string;
  eventType: string | null;
  deliveryId: string | null;
  outcome: TriggerDeliveryOutcome;
  executionId: string | null;
  reason: string | null;
  payloadPreview: string | null;
  receivedAt: string;
}

export interface ListTriggerDeliveriesResponse {
  deliveries: TriggerDelivery[];
  hasMore: boolean;
}

// Query keys
export const triggerKeys = {
  all: ['triggers'] as const,
  lists: () => [...triggerKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...triggerKeys.lists(), filters] as const,
  details: () => [...triggerKeys.all, 'detail'] as const,
  detail: (id: string) => [...triggerKeys.details(), id] as const,
  deliveries: (id: string) => [...triggerKeys.detail(id), 'deliveries'] as const,
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

export function useTriggerDeliveries(triggerId: string) {
  return useQuery({
    queryKey: triggerKeys.deliveries(triggerId),
    queryFn: () =>
      api.get<ListTriggerDeliveriesResponse>(`/triggers/${triggerId}/deliveries?limit=50`),
    enabled: !!triggerId,
    // Poll while the page is open so newly-fired deliveries surface live.
    refetchInterval: 5000,
  });
}

export function useCreateTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateTriggerRequest) =>
      api.post<Trigger>('/triggers', data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
      if (variables.workflowId) {
        queryClient.invalidateQueries({ queryKey: triggerKeys.byWorkflow(variables.workflowId) });
      }
    },
  });
}

export function useUpdateTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ triggerId, data }: { triggerId: string; data: UpdateTriggerRequest }) =>
      api.patch<{ success: boolean; updatedAt: string }>(`/triggers/${triggerId}`, data),
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
    mutationFn: ({ triggerId, variables }: { triggerId: string; variables?: Record<string, unknown> }) =>
      api.post<{
        executionId?: string;
        workflowId?: string | null;
        workflowName?: string | null;
        status: string;
        variables?: Record<string, unknown>;
        sessionId?: string;
        message: string;
        dispatched?: boolean;
      }>(`/triggers/${triggerId}/run`, {
        variables,
        clientRequestId: createClientRequestId(),
      }),
    onSuccess: (data) => {
      if (data.workflowId) {
        queryClient.invalidateQueries({ queryKey: workflowKeys.executions(data.workflowId) });
      }
    },
  });
}
