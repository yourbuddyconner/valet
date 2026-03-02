import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  Integration,
  ConfigureIntegrationRequest,
} from './types';

export const integrationKeys = {
  all: ['integrations'] as const,
  lists: () => [...integrationKeys.all, 'list'] as const,
  list: () => [...integrationKeys.lists()] as const,
  details: () => [...integrationKeys.all, 'detail'] as const,
  detail: (id: string) => [...integrationKeys.details(), id] as const,
};

interface ListIntegrationsResponse {
  integrations: Integration[];
}

export function useIntegrations() {
  return useQuery({
    queryKey: integrationKeys.list(),
    queryFn: () => api.get<ListIntegrationsResponse>('/integrations'),
  });
}

export function useIntegration(integrationId: string) {
  return useQuery({
    queryKey: integrationKeys.detail(integrationId),
    queryFn: () => api.get<Integration>(`/integrations/${integrationId}`),
    enabled: !!integrationId,
  });
}

export function useConfigureIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: ConfigureIntegrationRequest) =>
      api.post<Integration>('/integrations', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.lists() });
    },
  });
}

export function useUpdateIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      integrationId,
      data,
    }: {
      integrationId: string;
      data: Partial<ConfigureIntegrationRequest>;
    }) => api.patch<Integration>(`/integrations/${integrationId}`, data),
    onSuccess: (_, { integrationId }) => {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.detail(integrationId),
      });
      queryClient.invalidateQueries({ queryKey: integrationKeys.lists() });
    },
  });
}

export function useDeleteIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (integrationId: string) =>
      api.delete<void>(`/integrations/${integrationId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.lists() });
    },
  });
}
