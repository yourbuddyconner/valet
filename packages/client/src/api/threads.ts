import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SessionThread, ListThreadsResponse, Message } from './types';

export type PaginatedThreadsResponse = ListThreadsResponse & {
  page?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
};

export const threadKeys = {
  all: ['threads'] as const,
  lists: () => [...threadKeys.all, 'list'] as const,
  list: (sessionId: string, page?: number, pageSize?: number) => [...threadKeys.lists(), sessionId, page ?? null, pageSize ?? null] as const,
  details: () => [...threadKeys.all, 'detail'] as const,
  detail: (sessionId: string, threadId: string) =>
    [...threadKeys.details(), sessionId, threadId] as const,
  active: (sessionId: string) => [...threadKeys.all, 'active', sessionId] as const,
};

export function useThreads(sessionId: string, options?: { page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: threadKeys.list(sessionId, options?.page, options?.pageSize),
    queryFn: () =>
      api.get<PaginatedThreadsResponse>(
        `/sessions/${sessionId}/threads${options?.page ? `?page=${options.page}&pageSize=${options.pageSize ?? 30}` : ''}`
      ),
    enabled: !!sessionId,
  });
}

export function useThread(sessionId: string, threadId: string) {
  return useQuery({
    queryKey: threadKeys.detail(sessionId, threadId),
    queryFn: async () => {
      const data = await api.get<{ thread: SessionThread; messages: Message[] }>(
        `/sessions/${sessionId}/threads/${threadId}`
      );
      return {
        ...data,
        messages: data.messages.map((m) => ({
          ...m,
          createdAt: new Date(m.createdAt),
        })),
      };
    },
    enabled: !!sessionId && !!threadId,
  });
}

export function useActiveThread(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: threadKeys.active(sessionId),
    queryFn: () =>
      api.get<{ thread: SessionThread }>(`/sessions/${sessionId}/threads/active`),
    select: (data) => data.thread,
    enabled: !!sessionId && enabled,
    staleTime: 30_000,
  });
}

export function useCreateThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<SessionThread>(`/sessions/${sessionId}/threads`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}

export function useContinueThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      api.post<{ thread: SessionThread; resumed: boolean; continuationContext?: string }>(
        `/sessions/${sessionId}/threads/${threadId}/continue`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}

export function useDismissThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      api.patch<{ thread: SessionThread }>(
        `/sessions/${sessionId}/threads/${threadId}`,
        { status: 'archived' }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}

export function useReactivateThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      api.patch<{ thread: SessionThread }>(
        `/sessions/${sessionId}/threads/${threadId}`,
        { status: 'active' }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}
