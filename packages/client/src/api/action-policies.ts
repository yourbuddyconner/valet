import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ActionPolicy } from '@valet/shared';

export const actionPolicyKeys = {
  all: ['action-policies'] as const,
  list: () => [...actionPolicyKeys.all, 'list'] as const,
};

export function useActionPolicies() {
  return useQuery({
    queryKey: actionPolicyKeys.list(),
    queryFn: () => api.get<ActionPolicy[]>('/admin/action-policies'),
  });
}

export function useUpsertActionPolicy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: {
      id: string;
      service?: string | null;
      actionId?: string | null;
      riskLevel?: string | null;
      mode: string;
    }) => api.put<{ ok: boolean; id: string }>(`/admin/action-policies/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionPolicyKeys.list() });
    },
  });
}

export function useDeleteActionPolicy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/admin/action-policies/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionPolicyKeys.list() });
    },
  });
}
