import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ActionInvocation } from '@valet/shared';

export const actionInvocationKeys = {
  all: ['action-invocations'] as const,
  list: (filters?: Record<string, string>) => [...actionInvocationKeys.all, 'list', filters] as const,
  pending: () => [...actionInvocationKeys.all, 'pending'] as const,
  detail: (id: string) => [...actionInvocationKeys.all, id] as const,
};

export function useActionInvocations(opts?: { sessionId?: string; status?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.sessionId) params.set('sessionId', opts.sessionId);
  if (opts?.status) params.set('status', opts.status);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();

  return useQuery({
    queryKey: actionInvocationKeys.list(opts as Record<string, string> | undefined),
    queryFn: () => api.get<ActionInvocation[]>(`/action-invocations${qs ? `?${qs}` : ''}`),
  });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: actionInvocationKeys.pending(),
    queryFn: () => api.get<ActionInvocation[]>('/action-invocations/pending'),
    refetchInterval: 30_000,
  });
}

export function useApproveAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (invocationId: string) =>
      api.post<{ ok: boolean }>(`/action-invocations/${invocationId}/approve`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionInvocationKeys.pending() });
      queryClient.invalidateQueries({ queryKey: actionInvocationKeys.all });
    },
  });
}

export function useDenyAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ invocationId, reason }: { invocationId: string; reason?: string }) =>
      api.post<{ ok: boolean }>(`/action-invocations/${invocationId}/deny`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionInvocationKeys.pending() });
      queryClient.invalidateQueries({ queryKey: actionInvocationKeys.all });
    },
  });
}
