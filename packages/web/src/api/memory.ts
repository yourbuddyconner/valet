/**
 * Memory queries (assistant-centered web UI, decision 7). House pattern: a
 * query-key factory per resource file, mirroring `~/api/queries` and
 * `~/api/workspace-runtime`. The dashboard memory card uses `tree` + `doc`; the
 * Task 6 explorer adds `search` on top of the same factory.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { GetMemoryTreeResponse } from "@valet/api/wire";
import { api, ApiError, type OwnerFilter } from "./client";
import type { GetMemoryDocResponse, SearchMemoryResponse } from "./memory-types";

/** Every key carries the workspace, so switching refetches instead of
 * answering from the previous workspace's cache. The owner is a trailing
 * element, leaving the bare prefix as the one that invalidates all of them. */
function ownerKey(owner?: OwnerFilter): readonly string[] {
  return owner ? [owner.ownerType, owner.ownerId] : [];
}

export const qkMemory = {
  tree: (owner?: OwnerFilter) => ["memory", "tree", ...ownerKey(owner)] as const,
  doc: (path: string, owner?: OwnerFilter) =>
    ["memory", "doc", path, ...ownerKey(owner)] as const,
  search: (q: string, owner?: OwnerFilter) =>
    ["memory", "search", q, ...ownerKey(owner)] as const,
  graph: (owner?: OwnerFilter) => ["memory", "graph", ...ownerKey(owner)] as const,
};

export function useMemoryTree(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<GetMemoryTreeResponse>>,
) {
  return useQuery<GetMemoryTreeResponse>({
    queryKey: qkMemory.tree(owner),
    queryFn: () => api.getMemoryTree(owner),
    ...opts,
  });
}

/**
 * A single doc read (e.g. today's journal for the dashboard card, or the
 * detail pane in the Task 6 explorer). 404 (no file at this path yet — the
 * common case for "today's journal" before the assistant has written
 * anything) is a normal, expected outcome, not a card-blanking error —
 * callers branch on `query.error instanceof ApiError && error.status ===
 * 404` to show an in-voice empty state instead of a retry.
 */
export function useMemoryDoc(
  path: string,
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<GetMemoryDocResponse>>,
) {
  return useQuery<GetMemoryDocResponse>({
    queryKey: qkMemory.doc(path, owner),
    queryFn: () => api.getMemoryDoc(path, owner),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 2;
    },
    ...opts,
  });
}

/**
 * FTS search (Task 6, decision 17). `q` is expected to already be the
 * debounced value — callers own debouncing (`useDebouncedValue`) since
 * whether/when to debounce is a UI concern, not a data-fetching one.
 * Disabled for an empty/whitespace-only query so the explorer's tree stays
 * the resting state instead of firing an invalid `q=` request.
 */
export function useMemorySearch(
  q: string,
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<SearchMemoryResponse>>,
) {
  const trimmed = q.trim();
  return useQuery<SearchMemoryResponse>({
    queryKey: qkMemory.search(trimmed, owner),
    queryFn: () => api.searchMemory(trimmed, owner),
    enabled: trimmed.length > 0,
    ...opts,
  });
}
