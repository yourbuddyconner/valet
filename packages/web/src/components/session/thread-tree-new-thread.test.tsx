// @vitest-environment jsdom
/**
 * "+ new thread" affordance at the bottom of the thread tree (only rendered
 * on `/chat`, decision 12 sidebar). Verifies the click calls
 * `useCreateThread`'s mutation and navigates to the new thread — the tree's
 * other tests (`thread-tree.test.ts`) cover pure grouping/status logic;
 * this one needs a render since the behavior is a hook call + navigation.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";

const navigate = vi.fn();
const createThreadMutateAsync = vi.fn().mockResolvedValue({
  id: "thread-new",
  title: null,
  createdAt: Date.now(),
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => navigate,
}));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useThreads: () => ({
      data: { threads: [{ id: "thread-1", title: null, createdAt: Date.now() }] },
      isLoading: false,
      error: null,
    }),
    useCreateThread: () => ({
      mutateAsync: createThreadMutateAsync,
      isPending: false,
    }),
    useArchivedThreads: () => ({ data: undefined, isLoading: false, error: null }),
    useSetThreadArchived: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRenameThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useReplaceSandbox: () => ({ mutateAsync: vi.fn(), isPending: false }),
    // Session default model for the pin chip.
    useSession: () => ({ data: undefined, isLoading: false, error: null }),
    // Keeps the gate seed (usePendingGatesSeed) off the real query client.
    useDecisions: () => ({ data: undefined, isLoading: false, error: null }),
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: { id: "user-1" }, error: null }),
    useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
    useModelTiers: () => ({
      data: { xs: [], s: [], m: [], l: [], xl: [] },
      isLoading: false,
      error: null,
    }),
  };
});

const runtimeInfo = vi.fn((_workspace?: string) => ({ data: { sessionId: "orchestrator:user-1" } }));
vi.mock("~/api/workspace-runtime", () => ({
  useWorkspaceRuntimeInfo: (workspace: string | undefined) => runtimeInfo(workspace),

}));

vi.mock("~/stores/stream", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/stores/stream")>(),
  useThreadLiveStatus: () => ({ status: "idle" }),
  useQueueStateForThread: () => undefined,
  useStreamStore: () => undefined,
}));

import { ThreadTree } from "./thread-tree";

describe("ThreadTree — new thread affordance", () => {
  it("disables the personal runtime query when an explicit session is supplied", () => {
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    expect(runtimeInfo).toHaveBeenLastCalledWith(undefined);
  });
  it("creates a thread and navigates to it", async () => {
    render(
      <TooltipProvider>
        <ThreadTree />
      </TooltipProvider>,
    );

    // Exact name, not a regex: an untitled newest thread is itself labelled
    // "New thread", so its row menu ("Thread menu: New thread") also matches
    // a loose /new thread/i.
    const button = screen.getByRole("button", { name: "New thread" });
    await userEvent.click(button);

    expect(createThreadMutateAsync).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
    });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) }),
    );
    const call = navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> };
    expect(call.search({ thread: "thread-1" })).toEqual({
      thread: "thread-new",
      child: undefined,
    });
  });
});

vi.mock("~/api/child-work", async (importOriginal) => {
 const actual = await importOriginal<typeof import("~/api/child-work")>();
 return { ...actual,
  useChildWork: () => ({ data: { pages: [{ children: [], runningCount: 0, nextCursor: null }] }, refetch: vi.fn() }),
  useDismissChild: () => ({ mutateAsync: vi.fn(), isPending: false }),
 };
});
