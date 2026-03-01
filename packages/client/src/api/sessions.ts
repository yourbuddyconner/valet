import { useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { useAuthStore } from '@/stores/auth';
import type {
  AgentSession,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  SessionGitState,
  SessionFileChanged,
  ChildSessionSummary,
  ListChildSessionsResponse,
  SessionParticipant,
  SessionParticipantRole,
  SessionShareLink,
  SessionOwnershipFilter,
  ProviderModels,
} from './types';

export const sessionKeys = {
  all: ['sessions'] as const,
  lists: () => [...sessionKeys.all, 'list'] as const,
  list: (filters?: { cursor?: string }) =>
    [...sessionKeys.lists(), filters] as const,
  infinite: (ownership?: SessionOwnershipFilter) => [...sessionKeys.all, 'infinite', ownership ?? 'all'] as const,
  details: () => [...sessionKeys.all, 'detail'] as const,
  detail: (id: string) => [...sessionKeys.details(), id] as const,
  gitState: (id: string) => [...sessionKeys.detail(id), 'git-state'] as const,
  children: (id: string) => [...sessionKeys.detail(id), 'children'] as const,
  filesChanged: (id: string) => [...sessionKeys.detail(id), 'files-changed'] as const,
  participants: (id: string) => [...sessionKeys.detail(id), 'participants'] as const,
  shareLinks: (id: string) => [...sessionKeys.detail(id), 'share-links'] as const,
};

export function useSessions(cursor?: string) {
  return useQuery({
    queryKey: sessionKeys.list({ cursor }),
    queryFn: () =>
      api.get<ListSessionsResponse>(
        `/sessions${cursor ? `?cursor=${cursor}` : ''}`
      ),
  });
}

export function useInfiniteSessions(ownership?: SessionOwnershipFilter) {
  return useInfiniteQuery({
    queryKey: sessionKeys.infinite(ownership),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', pageParam);
      if (ownership && ownership !== 'all') params.set('ownership', ownership);
      const qs = params.toString();
      return api.get<ListSessionsResponse>(`/sessions${qs ? `?${qs}` : ''}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor,
    select: (data) => ({
      sessions: data.pages.flatMap((page) => page.sessions),
      hasMore: data.pages[data.pages.length - 1]?.hasMore ?? false,
    }),
    refetchInterval: 10_000,
  });
}

export type { ProviderModels };

export function useAvailableModels() {
  const query = useQuery({
    queryKey: ['available-models'],
    queryFn: () => api.get<{ models: ProviderModels[]; orgModelPreferences?: string[] | null }>('/sessions/available-models'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  // Hydrate orgModelPreferences into auth store so model pickers
  // get updated preferences without requiring a re-login.
  // Done in useEffect (not select) to avoid side effects during render.
  useEffect(() => {
    if (!query.data) return;
    const incoming = query.data.orgModelPreferences ?? undefined;
    const current = useAuthStore.getState().orgModelPreferences;
    if (JSON.stringify(current) !== JSON.stringify(incoming)) {
      useAuthStore.setState({ orgModelPreferences: incoming });
    }
  }, [query.data]);

  const data = useMemo(() => query.data?.models ?? [], [query.data]);

  return { ...query, data };
}

interface SessionDetailResponse {
  session: AgentSession;
  doStatus: SessionDoStatus;
}

export interface SessionDoStatus {
  sessionId?: string;
  userId?: string;
  workspace?: string;
  status?: string;
  lifecycleStatus?: string;
  sandboxId?: string | null;
  tunnelUrls?: Record<string, string> | null;
  tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
  runnerConnected?: boolean;
  runnerBusy?: boolean;
  agentState?: string;
  sandboxState?: string;
  jointState?: string;
  messageCount?: number;
  queuedPrompts?: number;
  connectedClients?: number;
  connectedUsers?: string[];
  runningStartedAt?: number | null;
  [key: string]: unknown;
}

export interface ChildSessionSummaryWithRuntime extends ChildSessionSummary {
  prTitle?: string;
  gatewayUrl?: string;
  tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }>;
}

export function useSession(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId),
    queryFn: () => api.get<SessionDetailResponse>(`/sessions/${sessionId}`),
    enabled: !!sessionId,
    select: (data) => data.session,
    refetchInterval: 15_000,
  });
}

export function useSessionDoStatus(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId),
    queryFn: () => api.get<SessionDetailResponse>(`/sessions/${sessionId}`),
    enabled: !!sessionId,
    select: (data) => data.doStatus,
    refetchInterval: 15_000,
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateSessionRequest) =>
      api.post<CreateSessionResponse>('/sessions', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.infinite() });
    },
  });
}

export function useBulkDeleteSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionIds: string[]) =>
      api.post<{ deleted: number; errors: { sessionId: string; error: string }[] }>(
        '/sessions/bulk-delete',
        { sessionIds }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.infinite() });
    },
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.delete<void>(`/sessions/${sessionId}`),
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.infinite() });
    },
  });
}

export function useSessionToken(sessionId: string) {
  const { data: session } = useSession(sessionId);
  const isStarting = !session || session.status === 'initializing';

  return useQuery({
    queryKey: [...sessionKeys.detail(sessionId), 'token'] as const,
    queryFn: () =>
      api.get<{ token: string; tunnelUrls: Record<string, string>; expiresAt: string }>(
        `/sessions/${sessionId}/sandbox-token`
      ),
    enabled: !!sessionId,
    staleTime: 10 * 60 * 1000,
    refetchInterval: (query) => {
      // If we already have data, refresh every 10 min (token lasts 15)
      if (query.state.data) return 10 * 60 * 1000;
      // During startup or if last fetch failed, poll every 3s
      if (query.state.status === 'error' || isStarting) return 3_000;
      // Default steady state
      return 10 * 60 * 1000;
    },
    retry: (failureCount, error) => {
      // Don't retry 401/403 (auth issues)
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
      // Retry 503 (sandbox not ready) up to 20 times
      if (error instanceof ApiError && error.status === 503) return failureCount < 20;
      // Default: retry once for other errors
      return failureCount < 1;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10_000),
  });
}

export function useDeleteSessionTunnel(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) =>
      api.delete<{ success: boolean }>(`/sessions/${sessionId}/tunnels/${encodeURIComponent(name)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
  });
}

export function useDeleteAnySessionTunnel(parentSessionId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, name }: { sessionId: string; name: string }) =>
      api.delete<{ success: boolean }>(`/sessions/${sessionId}/tunnels/${encodeURIComponent(name)}`),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      if (parentSessionId) {
        queryClient.invalidateQueries({ queryKey: sessionKeys.children(parentSessionId) });
      }
    },
  });
}

export function useHibernateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<{ status: string; message: string }>(`/sessions/${sessionId}/hibernate`),
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.infinite() });
    },
  });
}

export function useWakeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<{ status: string; message: string }>(`/sessions/${sessionId}/wake`),
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
  });
}

export function useSessionGitState(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.gitState(sessionId),
    queryFn: () =>
      api.get<{ gitState: SessionGitState | null }>(`/sessions/${sessionId}/git-state`),
    enabled: !!sessionId,
    select: (data) => data.gitState,
    refetchInterval: 15_000,
  });
}

export function useSessionChildren(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.children(sessionId),
    queryFn: () =>
      api.get<{ children: ChildSessionSummaryWithRuntime[] }>(`/sessions/${sessionId}/children`),
    enabled: !!sessionId,
    select: (data) => data.children,
    refetchInterval: (query) => {
      // Poll more aggressively when any child is still active
      const children = query.state.data?.children;
      const hasActive = children?.some(
        (c) => c.status !== 'terminated' && c.status !== 'archived' && c.status !== 'hibernated',
      );
      return hasActive ? 5_000 : 30_000;
    },
  });
}

type ChildrenWithRuntime = ListChildSessionsResponse & { children: ChildSessionSummaryWithRuntime[] };

export function useInfiniteSessionChildren(
  sessionId: string,
  options: { hideTerminated?: boolean } = {}
) {
  const { hideTerminated = false } = options;

  return useInfiniteQuery({
    queryKey: [...sessionKeys.children(sessionId), { hideTerminated }],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', pageParam);
      if (hideTerminated) params.set('hideTerminated', 'true');
      const qs = params.toString();
      return api.get<ChildrenWithRuntime>(`/sessions/${sessionId}/children${qs ? `?${qs}` : ''}`);
    },
    enabled: !!sessionId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor,
    select: (data) => ({
      children: data.pages.flatMap((page) => page.children),
      hasMore: data.pages[data.pages.length - 1]?.hasMore ?? false,
      totalCount: data.pages[0]?.totalCount ?? 0,
    }),
    refetchInterval: (query) => {
      const children = query.state.data?.pages.flatMap((p) => p.children);
      const hasActive = children?.some(
        (c) => c.status !== 'terminated' && c.status !== 'archived' && c.status !== 'hibernated',
      );
      return hasActive ? 5_000 : 30_000;
    },
  });
}

export function useSessionFilesChanged(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.filesChanged(sessionId),
    queryFn: () =>
      api.get<{ files: SessionFileChanged[] }>(`/sessions/${sessionId}/files-changed`),
    enabled: !!sessionId,
    select: (data) => data.files,
    refetchInterval: 15_000,
  });
}

export function useUpdateSessionTitle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api.patch<{ success: boolean }>(`/sessions/${sessionId}`, { title }),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
  });
}

// --- Sharing & Participants ---

export function useSessionParticipants(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.participants(sessionId),
    queryFn: () =>
      api.get<{ participants: SessionParticipant[] }>(`/sessions/${sessionId}/participants`),
    enabled: !!sessionId,
    select: (data) => data.participants,
  });
}

export function useAddParticipant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sessionId,
      email,
      role,
    }: {
      sessionId: string;
      email: string;
      role?: SessionParticipantRole;
    }) => api.post<{ success: boolean }>(`/sessions/${sessionId}/participants`, { email, role }),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.participants(sessionId) });
    },
  });
}

export function useRemoveParticipant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, userId }: { sessionId: string; userId: string }) =>
      api.delete<{ success: boolean }>(`/sessions/${sessionId}/participants/${userId}`),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.participants(sessionId) });
    },
  });
}

export function useSessionShareLinks(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.shareLinks(sessionId),
    queryFn: () =>
      api.get<{ shareLinks: SessionShareLink[] }>(`/sessions/${sessionId}/share-links`),
    enabled: !!sessionId,
    select: (data) => data.shareLinks,
  });
}

export function useCreateShareLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sessionId,
      role,
      expiresAt,
      maxUses,
    }: {
      sessionId: string;
      role?: SessionParticipantRole;
      expiresAt?: string;
      maxUses?: number;
    }) => api.post<{ shareLink: SessionShareLink }>(`/sessions/${sessionId}/share-link`, { role, expiresAt, maxUses }),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.shareLinks(sessionId) });
    },
  });
}

export function useRevokeShareLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, linkId }: { sessionId: string; linkId: string }) =>
      api.delete<{ success: boolean }>(`/sessions/${sessionId}/share-link/${linkId}`),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.shareLinks(sessionId) });
    },
  });
}

export function useJoinSession() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post<{ sessionId: string; role: SessionParticipantRole }>(`/sessions/join/${token}`),
  });
}

export function useTerminateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.delete<void>(`/sessions/${sessionId}`),
    onMutate: async (sessionId) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: sessionKeys.detail(sessionId) });
      await queryClient.cancelQueries({ queryKey: sessionKeys.infinite() });

      // Optimistically update session detail cache
      const previousDetail = queryClient.getQueryData(sessionKeys.detail(sessionId));
      queryClient.setQueryData(
        sessionKeys.detail(sessionId),
        (old: SessionDetailResponse | undefined) => {
          if (!old) return old;
          return { ...old, session: { ...old.session, status: 'terminated' } };
        }
      );

      return { previousDetail };
    },
    onError: (_err, sessionId, context) => {
      // Roll back optimistic update on error
      if (context?.previousDetail) {
        queryClient.setQueryData(sessionKeys.detail(sessionId), context.previousDetail);
      }
    },
    onSettled: (_, __, sessionId) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.infinite() });
    },
  });
}
