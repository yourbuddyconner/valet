import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ActionPolicyOverride, ParamMatcher } from '@valet/shared';

export const actionPolicyOverrideKeys = {
  all: ['action-policy-overrides'] as const,
  list: () => [...actionPolicyOverrideKeys.all, 'list'] as const,
};

export function useActionPolicyOverrides() {
  return useQuery({
    queryKey: actionPolicyOverrideKeys.list(),
    queryFn: () => api.get<ActionPolicyOverride[]>('/action-policy-overrides'),
  });
}

export function useUpsertActionPolicyOverride() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: {
      id: string;
      service?: string | null;
      actionId?: string | null;
      riskLevel?: string | null;
      mode: string;
      appliesIn?: 'any' | 'workflow' | 'session';
      paramMatchers?: ParamMatcher[];
    }) => api.put<{ ok: boolean; id: string }>(`/action-policy-overrides/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionPolicyOverrideKeys.list() });
    },
  });
}

export function useDeleteActionPolicyOverride() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/action-policy-overrides/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionPolicyOverrideKeys.list() });
    },
  });
}
