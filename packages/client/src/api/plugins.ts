import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { OrgPlugin, OrgPluginArtifact, OrgPluginSettings } from '@valet/shared';
import { api } from './client';

export const pluginKeys = {
  all: ['plugins'] as const,
  list: () => [...pluginKeys.all, 'list'] as const,
  detail: (id: string) => [...pluginKeys.all, 'detail', id] as const,
  settings: () => [...pluginKeys.all, 'settings'] as const,
};

export function usePlugins() {
  return useQuery({
    queryKey: pluginKeys.list(),
    queryFn: () => api.get<{ plugins: OrgPlugin[] }>('/plugins').then(r => r.plugins),
  });
}

export function usePluginSettings() {
  return useQuery({
    queryKey: pluginKeys.settings(),
    queryFn: () => api.get<{ settings: OrgPluginSettings }>('/plugins/settings').then(r => r.settings),
  });
}

export function usePluginDetail(id: string | null) {
  return useQuery({
    queryKey: pluginKeys.detail(id ?? ''),
    queryFn: () => api.get<{ plugin: OrgPlugin & { artifacts: OrgPluginArtifact[] } }>(`/plugins/${id}`).then(r => r.plugin),
    enabled: !!id,
  });
}

export function useUpdatePluginStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      api.put<{ ok: boolean }>(`/plugins/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

export function useSyncPlugins() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/plugins/sync'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

export function useUpdatePluginSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<OrgPluginSettings>) =>
      api.put<{ ok: boolean }>('/plugins/settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.settings() });
    },
  });
}
