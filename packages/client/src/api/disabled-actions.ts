import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { DisabledAction } from '@agent-ops/shared';

export const disabledActionKeys = {
  all: ['disabled-actions'] as const,
  list: () => [...disabledActionKeys.all, 'list'] as const,
};

export function useDisabledActions() {
  return useQuery({
    queryKey: disabledActionKeys.list(),
    queryFn: () => api.get<DisabledAction[]>('/admin/disabled-actions'),
  });
}

export function useSetServiceDisabledState() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ service, ...data }: {
      service: string;
      serviceDisabled: boolean;
      disabledActionIds: string[];
    }) => api.put<{ ok: boolean }>(`/admin/disabled-actions/${service}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: disabledActionKeys.list() });
    },
  });
}
