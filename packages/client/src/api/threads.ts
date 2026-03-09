import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SessionThread, ListThreadsResponse, Message } from './types';

export const threadKeys = {
  all: ['threads'] as const,
  lists: () => [...threadKeys.all, 'list'] as const,
  list: (sessionId: string) => [...threadKeys.lists(), sessionId] as const,
  details: () => [...threadKeys.all, 'detail'] as const,
  detail: (sessionId: string, threadId: string) =>
    [...threadKeys.details(), sessionId, threadId] as const,
  active: (sessionId: string) => [...threadKeys.all, 'active', sessionId] as const,
};

export function useThreads(sessionId: string) {
  return useQuery({
    queryKey: threadKeys.list(sessionId),
    queryFn: () =>
      api.get<ListThreadsResponse>(`/sessions/${sessionId}/threads`),
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
      api.post<{ thread: SessionThread; continuationContext?: string }>(
        `/sessions/${sessionId}/threads/${threadId}/continue`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}
