// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import "./chat";
const capture = vi.hoisted(() => ({ page: undefined as (() => ReactElement) | undefined }));
let data: { sessionId: string } | undefined;
let error: Error | null = null;
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: () => ReactElement }) => {
    capture.page = config.component; return { ...config, fullPath: "/chat", useSearch: () => ({ thread: "thread-a" }) };
  }, useNavigate: () => vi.fn(),
}));
vi.mock("~/hooks/use-workspace-conversation", () => ({ useWorkspaceConversation: () => ({ data, error, refetch: vi.fn() }) }));
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ key: "team-a", teamId: "team-a" }) }));
vi.mock("~/api/settings", () => ({ useTeams: () => ({ data: { teams: [{ id: "team-a", name: "Platform" }] } }) }));
vi.mock("~/hooks/use-invalidate-messages-on-queue-state", () => ({ useInvalidateMessagesOnQueueState: vi.fn() }));
vi.mock("~/components/session/session-view", () => ({ SessionView: ({ sessionId, activeThreadId, scopeNotice }: { sessionId: string; activeThreadId?: string; scopeNotice?: string }) => <div data-testid="conversation" data-scope-notice={scopeNotice}>{sessionId}:{activeThreadId}</div> }));
vi.mock("~/components/session/child-panel", () => ({ ChildPanel: () => null }));
beforeEach(() => { data = { sessionId: "team-session" }; error = null; });
function show() { if (!capture.page) throw new Error("missing route"); const Page = capture.page; return render(<Page />); }
it("opens the resolved workspace thread and labels its audience", () => {
  show(); expect(screen.getByTestId("conversation").textContent).toBe("team-session:thread-a");
  expect(screen.getByTestId("conversation").getAttribute("data-scope-notice")).toContain("Platform");
});
it("does not read a conversation before its session is ensured", () => {
  data = undefined; show(); expect(screen.queryByTestId("conversation")).toBeNull();
  expect(screen.getByText("Opening threads…")).toBeTruthy();
});
it("shows errors without silently substituting a personal conversation", () => {
  data = undefined; error = new Error("not found"); show();
  expect(screen.queryByTestId("conversation")).toBeNull(); expect(screen.getByRole("alert")).toBeTruthy();
});
