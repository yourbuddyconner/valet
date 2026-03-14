import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { OrchestratorIdentity, MemoryFile, MemoryFileListing, MemoryFileSearchResult, AgentSession, MailboxMessage, UserNotificationPreference, UserIdentityLink, UserTelegramConfig } from './types';

export const orchestratorKeys = {
  all: ['orchestrator'] as const,
  info: () => [...orchestratorKeys.all, 'info'] as const,
  identity: () => [...orchestratorKeys.all, 'identity'] as const,
  checkHandle: (handle: string) => [...orchestratorKeys.all, 'check-handle', handle] as const,
  memoryFiles: (path?: string) => [...orchestratorKeys.all, 'memory-files', path] as const,
  memoryFile: (path: string) => [...orchestratorKeys.all, 'memory-file', path] as const,
  notifications: (filters?: { messageType?: string; unreadOnly?: boolean }) => [...orchestratorKeys.all, 'notifications', filters] as const,
  notificationCount: () => [...orchestratorKeys.all, 'notifications-count'] as const,
  notificationThread: (threadId: string) => [...orchestratorKeys.all, 'notifications-thread', threadId] as const,
  notificationPreferences: () => [...orchestratorKeys.all, 'notification-prefs'] as const,
  orgAgents: () => [...orchestratorKeys.all, 'org-agents'] as const,
  identityLinks: () => [...orchestratorKeys.all, 'identity-links'] as const,
  telegram: () => [...orchestratorKeys.all, 'telegram'] as const,
};

export function useOrchestratorInfo() {
  return useQuery({
    queryKey: orchestratorKeys.info(),
    queryFn: () =>
      api.get<{
        sessionId: string;
        identity: OrchestratorIdentity | null;
        session: AgentSession | null;
        exists: boolean;
        needsRestart: boolean;
      }>('/me/orchestrator'),
    staleTime: 30_000,
  });
}

export function useCreateOrchestrator() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name: string;
      handle: string;
      avatar?: string;
      customInstructions?: string;
    }) =>
      api.post<{
        sessionId: string;
        identity: OrchestratorIdentity;
        session: AgentSession;
      }>('/me/orchestrator', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.all });
    },
  });
}

export function useCheckHandle(handle: string) {
  return useQuery({
    queryKey: orchestratorKeys.checkHandle(handle),
    queryFn: () =>
      api.get<{ available: boolean; handle: string }>(
        `/me/orchestrator/check-handle?handle=${encodeURIComponent(handle)}`
      ),
    enabled: handle.length >= 2,
    staleTime: 10_000,
  });
}

export function useOrchestratorIdentity() {
  return useQuery({
    queryKey: orchestratorKeys.identity(),
    queryFn: () =>
      api.get<{ identity: OrchestratorIdentity }>('/me/orchestrator/identity'),
    staleTime: 60_000,
  });
}

export function useUpdateOrchestratorIdentity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name?: string;
      handle?: string;
      avatar?: string;
      customInstructions?: string;
    }) =>
      api.put<{ identity: OrchestratorIdentity }>(
        '/me/orchestrator/identity',
        data
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.all });
    },
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const token = (await import('@/stores/auth')).useAuthStore.getState().token;
      const apiBase = import.meta.env.VITE_API_URL || '/api';

      const res = await fetch(`${apiBase}/me/orchestrator/avatar`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || 'Upload failed');
      }

      return res.json() as Promise<{ avatar: string; identity: OrchestratorIdentity }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.all });
    },
  });
}

export function useDeleteAvatar() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.delete<{ success: boolean }>('/me/orchestrator/avatar'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.all });
    },
  });
}

export function useMemoryFiles(path?: string) {
  return useQuery({
    queryKey: orchestratorKeys.memoryFiles(path || ''),
    queryFn: () => {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      const qs = params.toString();
      return api.get<{ files: MemoryFileListing[] }>(
        `/me/memory${qs ? `?${qs}` : ''}`
      );
    },
    select: (data) => data.files,
    staleTime: 30_000,
  });
}

export function useMemoryFile(path: string) {
  return useQuery({
    queryKey: orchestratorKeys.memoryFile(path),
    queryFn: () => {
      const params = new URLSearchParams({ path });
      return api.get<{ file: MemoryFile | null }>(
        `/me/memory?${params.toString()}`
      );
    },
    select: (data) => data.file,
    enabled: !!path && !path.endsWith('/'),
    staleTime: 30_000,
  });
}

export function useWriteMemoryFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { path: string; content: string }) =>
      api.put<{ file: MemoryFile }>('/me/memory', data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...orchestratorKeys.all, 'memory-files'],
      });
    },
  });
}

export function useSearchMemoryFiles(query: string) {
  return useQuery({
    queryKey: [...orchestratorKeys.all, 'memory-search', query],
    queryFn: () => {
      const params = new URLSearchParams({ query });
      return api.get<{ results: MemoryFileSearchResult[] }>(
        `/me/memory/search?${params.toString()}`
      );
    },
    select: (data) => data.results,
    enabled: query.length >= 2,
    staleTime: 15_000,
  });
}

export function useDeleteMemoryFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) =>
      api.delete<{ success: boolean; deleted: number }>(`/me/memory?path=${encodeURIComponent(path)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...orchestratorKeys.all, 'memory-files'],
      });
    },
  });
}

// ─── Notification Queue Hooks (Phase C) ─────────────────────────────────

export function useNotifications(opts?: { messageType?: string; unreadOnly?: boolean; limit?: number }) {
  return useQuery({
    queryKey: orchestratorKeys.notifications({ messageType: opts?.messageType, unreadOnly: opts?.unreadOnly }),
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.messageType) params.set('messageType', opts.messageType);
      if (opts?.unreadOnly) params.set('unreadOnly', 'true');
      if (opts?.limit) params.set('limit', String(opts.limit));
      const qs = params.toString();
      return api.get<{ messages: MailboxMessage[]; cursor?: string; hasMore: boolean }>(
        `/me/notifications${qs ? `?${qs}` : ''}`
      );
    },
    staleTime: 15_000,
  });
}

export function useNotificationCount() {
  return useQuery({
    queryKey: orchestratorKeys.notificationCount(),
    queryFn: () => api.get<{ count: number }>('/me/notifications/count'),
    select: (data) => data.count,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useNotificationThread(threadId: string | null) {
  return useQuery({
    queryKey: orchestratorKeys.notificationThread(threadId!),
    queryFn: () =>
      api.get<{ rootMessage: MailboxMessage; replies: MailboxMessage[]; totalCount: number }>(
        `/me/notifications/threads/${threadId}`
      ),
    enabled: !!threadId,
    staleTime: 10_000,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (messageId: string) =>
      api.put<{ success: boolean }>(`/me/notifications/${messageId}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...orchestratorKeys.all, 'notifications'] });
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.notificationCount() });
    },
  });
}

export function useMarkNonActionableNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.put<{ success: boolean; count: number }>('/me/notifications/read-non-actionable'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...orchestratorKeys.all, 'notifications'] });
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.notificationCount() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.put<{ success: boolean; count: number }>('/me/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...orchestratorKeys.all, 'notifications'] });
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.notificationCount() });
    },
  });
}

export function useReplyToNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { messageId: string; content: string }) =>
      api.post<{ message: MailboxMessage }>(`/me/notifications/${data.messageId}/reply`, {
        content: data.content,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...orchestratorKeys.all, 'notifications'] });
      queryClient.invalidateQueries({ queryKey: [...orchestratorKeys.all, 'notifications-thread'] });
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.notificationCount() });
    },
  });
}

// ─── Notification Preferences Hooks (Phase C) ──────────────────────────

export function useNotificationPreferences() {
  return useQuery({
    queryKey: orchestratorKeys.notificationPreferences(),
    queryFn: () =>
      api.get<{ preferences: UserNotificationPreference[] }>('/me/notification-preferences'),
    select: (data) => data.preferences,
    staleTime: 60_000,
  });
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      messageType: string;
      eventType?: string;
      webEnabled?: boolean;
      slackEnabled?: boolean;
      emailEnabled?: boolean;
    }) =>
      api.put<{ preference: UserNotificationPreference }>(
        '/me/notification-preferences',
        data
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.notificationPreferences() });
    },
  });
}

// ─── Org Directory Hooks (Phase C) ──────────────────────────────────────

export function useOrgAgents() {
  return useQuery({
    queryKey: orchestratorKeys.orgAgents(),
    queryFn: () =>
      api.get<{ agents: OrchestratorIdentity[] }>('/me/org-agents'),
    select: (data) => data.agents,
    staleTime: 60_000,
  });
}

// ─── Identity Link Hooks (Phase D) ──────────────────────────────────────

export function useIdentityLinks() {
  return useQuery({
    queryKey: orchestratorKeys.identityLinks(),
    queryFn: () =>
      api.get<{ links: UserIdentityLink[] }>('/me/identity-links'),
    select: (data) => data.links,
    staleTime: 60_000,
  });
}

export function useCreateIdentityLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      provider: string;
      externalId: string;
      externalName?: string;
      teamId?: string;
    }) =>
      api.post<{ link: UserIdentityLink }>('/me/identity-links', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.identityLinks() });
    },
  });
}

export function useDeleteIdentityLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/me/identity-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.identityLinks() });
    },
  });
}

// ─── Telegram Config Hooks (Phase D) ────────────────────────────────────

export function useTelegramConfig() {
  return useQuery({
    queryKey: orchestratorKeys.telegram(),
    queryFn: () =>
      api.get<{ config: UserTelegramConfig | null }>('/me/telegram'),
    select: (data) => data.config,
    staleTime: 60_000,
  });
}

export function useSetupTelegram() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { botToken: string }) =>
      api.post<{ config: UserTelegramConfig; webhookUrl: string }>('/me/telegram', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.telegram() });
    },
  });
}

export function useDisconnectTelegram() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.delete<{ success: boolean }>('/me/telegram'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.telegram() });
    },
  });
}

export function useUpdateTelegramConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { ownerTelegramUserId?: string }) =>
      api.patch<{ config: UserTelegramConfig }>('/me/telegram', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orchestratorKeys.telegram() });
    },
  });
}
