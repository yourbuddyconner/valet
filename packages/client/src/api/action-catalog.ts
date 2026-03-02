import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface ActionCatalogEntry {
  service: string;
  serviceDisplayName: string;
  actionId: string;
  name: string;
  description: string;
  riskLevel: string;
}

export const actionCatalogKeys = {
  all: ['action-catalog'] as const,
};

export function useActionCatalog() {
  return useQuery({
    queryKey: actionCatalogKeys.all,
    queryFn: () =>
      api.get<{ actions: ActionCatalogEntry[] }>('/integrations/actions').then((r) => r.actions),
    staleTime: Infinity,
  });
}
