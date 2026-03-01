import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { OrgSettings, OrgApiKey, Invite, User, CustomProvider } from '@agent-ops/shared';

// Query key factory
export const adminKeys = {
  all: ['admin'] as const,
  settings: () => [...adminKeys.all, 'settings'] as const,
  llmKeys: () => [...adminKeys.all, 'llm-keys'] as const,
  customProviders: () => [...adminKeys.all, 'custom-providers'] as const,
  invites: () => [...adminKeys.all, 'invites'] as const,
  users: () => [...adminKeys.all, 'users'] as const,
};

// --- Org Settings ---

export function useOrgSettings() {
  return useQuery({
    queryKey: adminKeys.settings(),
    queryFn: () => api.get<OrgSettings>('/admin'),
  });
}

export function useUpdateOrgSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Pick<OrgSettings, 'name' | 'allowedEmailDomain' | 'allowedEmails' | 'domainGatingEnabled' | 'emailAllowlistEnabled' | 'modelPreferences'>>) =>
      api.put<OrgSettings>('/admin', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.settings() });
    },
  });
}

// --- LLM Keys ---

export function useOrgLLMKeys() {
  return useQuery({
    queryKey: adminKeys.llmKeys(),
    queryFn: () => api.get<OrgApiKey[]>('/admin/llm-keys'),
  });
}

export function useSetLLMKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ provider, key }: { provider: string; key: string }) =>
      api.put<{ ok: boolean }>(`/admin/llm-keys/${provider}`, { key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.llmKeys() });
    },
  });
}

export function useDeleteLLMKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (provider: string) =>
      api.delete<{ ok: boolean }>(`/admin/llm-keys/${provider}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.llmKeys() });
    },
  });
}

// --- Invites ---

export function useInvites() {
  return useQuery({
    queryKey: adminKeys.invites(),
    queryFn: () => api.get<Invite[]>('/admin/invites'),
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { email?: string; role?: 'admin' | 'member' }) =>
      api.post<Invite>('/admin/invites', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.invites() });
    },
  });
}

export function useDeleteInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/admin/invites/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.invites() });
    },
  });
}

// --- Users ---

export function useOrgUsers() {
  return useQuery({
    queryKey: adminKeys.users(),
    queryFn: () => api.get<User[]>('/admin/users'),
  });
}

export function useUpdateUserRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'member' }) =>
      api.patch<{ ok: boolean }>(`/admin/users/${userId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users() });
    },
  });
}

export function useRemoveUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      api.delete<{ ok: boolean }>(`/admin/users/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users() });
    },
  });
}

// --- Custom Providers ---

export function useDiscoverModels() {
  return useMutation({
    mutationFn: (data: { baseUrl: string; apiKey?: string }) =>
      api.post<{ models: Array<{ id: string; created?: number }> }>('/admin/custom-providers/discover-models', data),
  });
}

export function useCustomProviders() {
  return useQuery({
    queryKey: adminKeys.customProviders(),
    queryFn: () => api.get<CustomProvider[]>('/admin/custom-providers'),
  });
}

export function useUpsertCustomProvider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ providerId, ...data }: {
      providerId: string;
      displayName: string;
      baseUrl: string;
      apiKey?: string;
      models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>;
    }) =>
      api.put<{ ok: boolean }>(`/admin/custom-providers/${providerId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.customProviders() });
    },
  });
}

export function useDeleteCustomProvider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (providerId: string) =>
      api.delete<{ ok: boolean }>(`/admin/custom-providers/${providerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.customProviders() });
    },
  });
}
