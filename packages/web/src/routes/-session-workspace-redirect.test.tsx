// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppSessionPage, Route } from "./sessions.$sessionId";
let owner: { type: "user" | "team"; id: string } = { type: "team", id: "team-a" };
let runtime = "runtime-team";
let sessionId = "runtime-team";

vi.mock("@tanstack/react-router", async importOriginal => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual,
    Navigate: ({ search }: { search: Record<string, string> }) => <div data-testid="redirect">{JSON.stringify(search)}</div>,
    Link: ({ children, search }: { children: ReactNode; search: Record<string, string> }) => <a data-testid="origin" data-search={JSON.stringify(search)}>{children}</a>,
  };
});
vi.mock("~/api/queries", () => ({ useSession: () => ({ data: { owner, isWorkspaceRuntime: sessionId === runtime, parentWork: sessionId === "child" ? { sessionId: runtime, threadId: "parent-thread" } : undefined } }) }));
vi.mock("~/lib/workspace-scope", () => ({ useAdoptWorkspaceScope: () => undefined }));
vi.mock("~/components/session/session-view", () => ({ SessionView: () => <div>Work history</div> }));
vi.mock("~/components/session/child-panel", () => ({ ChildPanel: () => null }));
vi.mock("~/components/security/engagement-panel", () => ({ SecuritySessionLayout: () => null }));
vi.mock("~/components/workflows/agent-approvals", () => ({ WorkflowAgentApprovals: () => null }));
beforeEach(() => {
  vi.clearAllMocks();
  owner = { type: "team", id: "team-a" }; runtime = "runtime-team"; sessionId = runtime;
  vi.spyOn(Route, "useParams").mockImplementation(() => ({ sessionId }));
  vi.spyOn(Route, "useSearch").mockReturnValue({ thread: "source-thread" });
  vi.spyOn(Route, "useNavigate").mockReturnValue(vi.fn());
});
it("redirects a team runtime to its workspace and preserves the source thread", () => {
  render(<AppSessionPage />);
  expect(JSON.parse(screen.getByTestId("redirect").textContent ?? "{}")).toEqual({ workspace: "team-a", thread: "source-thread" });
});
it("resolves personal runtime links through the personal workspace", () => {
  owner = { type: "user", id: "u1" };
  render(<AppSessionPage />);
  expect(JSON.parse(screen.getByTestId("redirect").textContent ?? "{}").workspace).toBe("user");
});
it("keeps child history in its own runtime and points back to the team origin", () => {
  sessionId = "child";
  render(<AppSessionPage />);
  expect(screen.getByText("Work history")).toBeTruthy();
  expect(screen.queryByTestId("redirect")).toBeNull();
  expect(JSON.parse(screen.getByTestId("origin").getAttribute("data-search") ?? "{}")).toEqual({ thread: "parent-thread" });
});
