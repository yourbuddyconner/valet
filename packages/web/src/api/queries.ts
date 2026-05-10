/**
 * TanStack Query hooks for the REST surface. Live updates from the WS stream
 * are handled separately (see `src/stores/stream.ts`); these hooks own the
 * historical-state side of the picture (initial fetch + cache-invalidation
 * on mutations).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListMessagesResponse,
  ListSessionsResponse,
  ListThreadsResponse,
  MeResponse,
} from "@valet/api/wire";
import { api } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qk = {
  me: () => ["me"] as const,
  sessions: () => ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  threads: (id: string) => ["sessions", id, "threads"] as const,
  messages: (id: string) => ["sessions", id, "messages"] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

export function useMe(opts?: UseQueryOptions<MeResponse>) {
  return useQuery<MeResponse>({ queryKey: qk.me(), queryFn: () => api.me(), ...opts });
}

export function useSessions(opts?: UseQueryOptions<ListSessionsResponse>) {
  return useQuery<ListSessionsResponse>({
    queryKey: qk.sessions(),
    queryFn: () => api.listSessions(),
    ...opts,
  });
}

export function useSession(id: string, opts?: UseQueryOptions<GetSessionResponse>) {
  return useQuery<GetSessionResponse>({
    queryKey: qk.session(id),
    queryFn: () => api.getSession(id),
    enabled: !!id,
    ...opts,
  });
}

export function useThreads(id: string, opts?: UseQueryOptions<ListThreadsResponse>) {
  return useQuery<ListThreadsResponse>({
    queryKey: qk.threads(id),
    queryFn: () => api.listThreads(id),
    enabled: !!id,
    ...opts,
  });
}

export function useMessages(id: string, opts?: UseQueryOptions<ListMessagesResponse>) {
  return useQuery<ListMessagesResponse>({
    queryKey: qk.messages(id),
    queryFn: () => api.listMessages(id, { limit: 200 }),
    enabled: !!id,
    ...opts,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation<CreateSessionResponse, Error, CreateSessionRequest>({
    mutationFn: (body) => api.createSession(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useSendPrompt(sessionId: string) {
  return useMutation<{ messageId: string; threadId: string }, Error, string>({
    mutationFn: (text) => api.sendPrompt(sessionId, { text }),
    // Invalidations not needed — live updates flow through the WS store.
  });
}
