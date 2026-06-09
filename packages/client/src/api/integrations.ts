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
  available: () => [...integrationKeys.all, 'available'] as const,
  details: () => [...integrationKeys.all, 'detail'] as const,
  detail: (id: string) => [...integrationKeys.details(), id] as const,
};

// Wire shape of integrations returned by GET /api/integrations.
// The API strips userId and updatedAt; createdAt is a string after JSON transport.
export interface IntegrationListItem {
  id: string;
  service: string;
  status: 'active' | 'error' | 'pending' | 'disconnected';
  scope: 'user' | 'org';
  config: { entities: string[] };
  createdAt: string;
  authType?: 'oauth2' | 'api_key' | 'bearer';
  displayName?: string;
  isCustomConnector?: boolean;
  isOrgManagedConnector?: boolean;
}

interface ListIntegrationsResponse {
  integrations: IntegrationListItem[];
}

export interface AvailableService {
  service: string;
  displayName: string;
  authType: 'oauth2' | 'bot_token' | 'api_key' | 'bearer';
  supportedEntities: string[];
  hasActions: boolean;
  hasTriggers: boolean;
  isCustomConnector?: boolean;
}

interface AvailableServicesResponse {
  services: AvailableService[];
  disabledServices: string[];
}

export function useIntegrations() {
  return useQuery({
    queryKey: integrationKeys.list(),
    queryFn: () => api.get<ListIntegrationsResponse>('/integrations'),
  });
}

export function useAvailableIntegrations() {
  return useQuery({
    queryKey: integrationKeys.available(),
    queryFn: () => api.get<AvailableServicesResponse>('/integrations/available'),
  });
}

export function useIntegration(integrationId: string) {
  return useQuery({
    queryKey: integrationKeys.detail(integrationId),
    queryFn: () => api.get<Integration>(`/integrations/${integrationId}`),
    enabled: !!integrationId,
  });
}

interface ConfigureIntegrationResponse {
  integration: Integration;
}

export async function configureIntegration(
  data: ConfigureIntegrationRequest
): Promise<Integration> {
  const response = await api.post<ConfigureIntegrationResponse>('/integrations', data);
  return response.integration;
}

export function useConfigureIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: configureIntegration,
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
