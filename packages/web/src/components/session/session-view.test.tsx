// @vitest-environment jsdom
/**
 * `SessionView` header chrome (decisions 13/14): by default the view gets
 * the existing `SessionHeader` (model picker, delete, etc.); with `panel`
 * it gets a compact header (title + open-full-page + ✕ close) instead. The
 * threads/thread-tree *sidebar* is deliberately NOT part of this
 * component (it's a root-layout concern — see `__root.tsx`), so this test
 * only covers header chrome, not sidebar visibility.
 *
 * All data hooks are mocked so this stays a pure rendering/branching test.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { SessionView } from "./session-view";

let fullProfile = false;
beforeEach(() => { fullProfile = false; });

vi.mock("~/api/ws", () => ({ useSessionWebSocket: () => undefined }));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSession: () => ({
      isLoading: false,
      error: null,
      data: { owner: { type: "user", id: "u1" }, id: "sess-1", title: "fix-auth", workspace: "/workspace", profile: fullProfile ? "full" : "headless" },
    }),
    useThreads: () => ({ data: { threads: [{ id: "t1", createdAt: 0 }] } }),
    useMessages: () => ({ data: undefined }),
    useDecisions: () => ({ data: undefined }),
  };
});

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useSessionStream: () => ({ messages: [], statusByThread: {}, conn: "open" }),
    useStreamStore: (selector: (s: { setThreadMessages: () => void; setPendingGates: () => void }) => unknown) =>
      selector({ setThreadMessages: vi.fn(), setPendingGates: vi.fn() }),
    usePendingGateForThread: () => undefined,
    useQueueStateForThread: () => undefined,
  };
});

vi.mock("./session-header", () => ({
  SandboxChip: () => null,
  SessionHeader: ({ session }: { session: { title?: string } }) => (
    <div data-testid="full-header">{session.title}</div>
  ),
}));
vi.mock("./message-list", () => ({ MessageList: ({ header }: { header?: ReactNode }) => <div data-testid="message-list">{header}</div> }));
vi.mock("./composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("./decision-gate-card", () => ({ DecisionGateCard: () => null }));

vi.mock("./browser/browser-overlay", () => ({ BrowserOverlay: ({ minimized, onMinimize, onRestore, onClose, onExpand }: {
  minimized: boolean; onMinimize: () => void; onRestore: () => void; onClose: () => void; onExpand: () => void;
}) => <section aria-label="Browser preview"><span>{minimized ? "minimized feed" : "visible feed"}</span>
  <button onClick={onMinimize}>minimize preview</button><button onClick={onRestore}>restore preview</button>
  <button onClick={onClose}>close preview</button><button onClick={onExpand}>expand preview</button></section> }));
vi.mock("./browser/browser-pane", () => ({ BrowserPane: () => <section aria-label="Full browser" /> }));

function renderInRouter(sessionId: string, panel: boolean, onClose?: () => void) {
  const rootRoute = createRootRoute({
    component: () => <SessionView sessionId={sessionId} panel={panel} onClose={onClose} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // SessionView's query hooks need a QueryClient in scope. Provide a scratch
  // client per render so the test shares no cache state.
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("SessionView header chrome", () => {
  it("watches from chat, suspends in the full pane, restores, and returns focus on close", async () => {
    renderInRouter("sess-1", false);
    fireEvent.click(await screen.findByRole("button", { name: "Watch browser" }));
    expect(screen.getByText("visible feed")).toBeTruthy();
    fireEvent.click(screen.getByText("minimize preview"));
    expect(screen.getByText("minimized feed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch browser" }));
    expect(screen.getByText("visible feed")).toBeTruthy();
    fireEvent.click(screen.getByText("expand preview"));
    expect(screen.queryByRole("region", { name: "Browser preview" })).toBeNull();
    expect(screen.getByRole("region", { name: "Full browser" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Browser" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("visible feed")).toBeTruthy();
    fireEvent.click(screen.getByText("close preview"));
    expect(screen.queryByRole("region", { name: "Browser preview" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Watch browser" }));
  });
  it("without panel: renders the standard SessionHeader", async () => {
    renderInRouter("sess-1", false);
    expect(await screen.findByTestId("full-header")).toBeTruthy();
    expect(screen.queryByLabelText("Close panel")).toBeNull();
  });

  it("panel: renders a compact header with title + close button, not SessionHeader", async () => {
    const onClose = vi.fn();
    renderInRouter("sess-1", true, onClose);
    expect(await screen.findByText("fix-auth")).toBeTruthy();
    expect(screen.queryByTestId("full-header")).toBeNull();
    const closeBtn = screen.getByLabelText("Close panel");
    closeBtn.click();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps focus on the selected sandbox tab across chat transitions", async () => {
    fullProfile = true;
    renderInRouter("sess-1", false);
    const terminal = await screen.findByRole("tab", { name: "Terminal" });
    act(() => terminal.focus());
    fireEvent.click(terminal);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Terminal" })));
    const chat = screen.getByRole("tab", { name: "Chat" });
    act(() => chat.focus());
    fireEvent.click(chat);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Chat" })));
  });

  it("renders the transcript and composer either way", async () => {
    renderInRouter("sess-1", true);
    expect(await screen.findByTestId("message-list")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });
});
