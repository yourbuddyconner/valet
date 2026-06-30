import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface RuntimeGrant {
  id: string;
  sessionId: string | null;
  workflowExecutionId: string | null;
  subjectType: string;
  service: string | null;
  actionId: string | null;
  riskLevel: string | null;
  nodeId: string | null;
  policyKey: string;
  createdAt: string;
}

export const runtimeGrantKeys = {
  all: ['runtime-grants'] as const,
  list: () => [...runtimeGrantKeys.all, 'list'] as const,
};

export function useRuntimeGrants() {
  return useQuery({
    queryKey: runtimeGrantKeys.list(),
    queryFn: () => api.get<RuntimeGrant[]>('/runtime-grants'),
  });
}

export function useRevokeRuntimeGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/runtime-grants/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runtimeGrantKeys.list() });
    },
  });
}
