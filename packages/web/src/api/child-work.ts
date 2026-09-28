import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ChildWorkResponse } from "@valet/api/wire";
import { api } from "./client";

export const childWorkKey = (sessionId: string | undefined) => ["child-work", sessionId] as const;

export function flattenChildWork(data: InfiniteData<ChildWorkResponse> | undefined) {
  return [...new Map(data?.pages.flatMap(page => page.children).map(child => [child.sessionId, child])).values()];
}

export function useChildWork(sessionId: string | undefined, opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useInfiniteQuery({
    queryKey: childWorkKey(sessionId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (!sessionId) throw new Error("Choose a parent session.");
      return api.getChildWork(sessionId, { cursor: pageParam });
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: opts?.refetchInterval ?? 30_000,
    enabled: !!sessionId && opts?.enabled !== false,
  });
}

export function useDismissChild(sessionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (childSessionId: string) => {
      if (!sessionId) throw new Error("Choose a parent session.");
      return api.dismissChild(sessionId, childSessionId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: childWorkKey(sessionId) }),
  });
}
