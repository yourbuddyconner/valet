// @vitest-environment jsdom
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./client";
import { flattenChildWork, useChildWork, useDismissChild } from "./child-work";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
afterEach(() => vi.restoreAllMocks());

it("does not fetch without an explicit parent, even when enabled", () => {
  const get = vi.spyOn(api, "getChildWork");
  renderHook(() => useChildWork(undefined, { enabled: true }), { wrapper: wrapper() });
  expect(get).not.toHaveBeenCalled();
});

it("paginates one parent, deduplicates moving children, and isolates a different parent", async () => {
  const child = { sessionId: "child", parentThreadId: "thread", title: "Work", createdAt: 1, status: "running" as const };
  const get = vi.spyOn(api, "getChildWork").mockImplementation(async (parent, opts) => parent === "other"
    ? { children: [], nextCursor: null, runningCount: 0 }
    : opts?.cursor ? { children: [{ ...child, status: "settled" }], nextCursor: null, runningCount: 0 }
    : { children: [child], nextCursor: "next", runningCount: 40 });
  const { result, rerender } = renderHook(({ parent }) => useChildWork(parent), { initialProps: { parent: "team-runtime" }, wrapper: wrapper() });
  await waitFor(() => expect(result.current.hasNextPage).toBe(true));
  expect(result.current.data?.pages[0]?.runningCount).toBe(40);
  await act(async () => { await result.current.fetchNextPage(); });
  expect(get).toHaveBeenCalledWith("team-runtime", { cursor: "next" });
  await waitFor(() => expect(flattenChildWork(result.current.data)).toEqual([{ ...child, status: "settled" }]));
  rerender({ parent: "other" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(flattenChildWork(result.current.data)).toEqual([]);
});

it("dismisses through the explicit parent", async () => {
  const dismiss = vi.spyOn(api, "dismissChild").mockResolvedValue({ ok: true });
  const { result } = renderHook(() => useDismissChild("team-runtime"), { wrapper: wrapper() });
  await act(async () => { await result.current.mutateAsync("child"); });
  expect(dismiss).toHaveBeenCalledWith("team-runtime", "child");
});
