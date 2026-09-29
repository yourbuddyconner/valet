// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type OwnerFilter } from "~/api/client";
import { WorkspaceActivity as WorkspaceCatchUp, safeResultUrl } from "./workspace-activity";
let owner: OwnerFilter = { ownerType: "user", ownerId: "u" };
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ error: null }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, params, search }: { children: ReactNode; to: string; params?: Record<string, string>; search?: { thread?: string } }) => <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to) + (search?.thread ? `?thread=${search.thread}` : "")}>{children}</a> }));
vi.mock("~/api/client", () => ({ api: { listWork: vi.fn(), listArtifacts: vi.fn(), listWorkspaceOutcomes: vi.fn(), listWorkspaceActiveWork: vi.fn(), listWorkflows: vi.fn(), listRuns: vi.fn(), listWorkflowActionRequired: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks(); owner = { ownerType: "user", ownerId: "u" };
  vi.mocked(api.listWork).mockResolvedValue({ sessions: [{ id: "s", title: "TKAI-42 · Route events", workspace: "", status: "active", kind: "code", runState: "idle", createdAt: 1, updatedAt: 1, lastActivityAt: 1, owner: { type: "user", id: "u" } }], nextCursor: null });
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [], nextCursor: null });
  vi.mocked(api.listWorkspaceOutcomes).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [{ id: "wf", name: "Review", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1 }] });
  vi.mocked(api.listRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.listWorkflowActionRequired).mockResolvedValue({ items: [], count: 0 });
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><WorkspaceCatchUp /></QueryClientProvider>);
  return { client, ...view };
}
it("groups PRs and published files under their work with real source links", async () => {
  vi.mocked(api.listWorkspaceOutcomes).mockResolvedValue({ items: [{ id: "pr", kind: "pull_request", title: "Route events PR", occurredAt: 5, sessionId: "s", threadId: "thread-a", url: "https://github.com/acme/app/pull/42" }, { id: "unsafe", kind: "review", title: "Unsafe link", occurredAt: 4, url: "javascript:alert(1)" }], nextCursor: null });
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [{ id: "a", title: "Routing report", path: "report.md", format: "markdown", icon: "", ownerType: "user", version: 1, sharedVersion: null, token: "report-token", url: "https://api.example/a/report-token", visibility: "org", actorUserId: "u", revoked: false, createdAt: 2, updatedAt: 3, sourceSessionId: "s", sourceThreadId: "thread-a" }], nextCursor: null });
  setup();
  const pr = await screen.findByRole("link", { name: "Route events PR" });
  const results = screen.getByRole("region", { name: "Recent results" });
  expect(pr.getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
  expect(within(results).getByRole("link", { name: "Routing report" }).getAttribute("href")).toBe("/a/report-token");
  expect(within(results).getByText("TKAI-42 · Route events")).toBeTruthy();
  expect(within(results).getAllByRole("link", { name: "Open thread" })[0]?.getAttribute("href")).toBe("/threads/thread-a");
  expect(screen.queryByRole("link", { name: "Unsafe link" })).toBeNull();
  expect(screen.queryByText("Completed")).toBeNull();
  expect(screen.queryByRole("link", { name: "TKAI-42" })).toBeNull();
});
it("separates approval from timer waits and shows the requested action", async () => {
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [
    { id: "wf", name: "Review rollout", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1, latestRun: { runId: "approval", workflowId: "wf", status: "parked", createdAt: 1, updatedAt: 2 } },
    { id: "timer-wf", name: "Wait for intake", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1, latestRun: { runId: "timer", workflowId: "timer-wf", status: "parked", waitingOn: [{ kind: "timer", nodeId: "wait", wakeAt: 100 }], createdAt: 1, updatedAt: 2 } },
  ] });
  vi.mocked(api.listWorkflowActionRequired).mockResolvedValue({ items: [{ id: "g", runId: "approval", workflowId: "wf", workflowName: "Review rollout", runCreatedAt: 1, owner: { type: "user", id: "u" }, trigger: { type: "manual" }, gate: { nodeId: "review", kind: "approval", prompt: "Check the routing report before rollout." } }], count: 1 });
  setup();
  expect(await screen.findByText("Check the routing report before rollout.")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("Review rollout")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "In progress" })).getByText("Wait for intake")).toBeTruthy();
  expect(api.listWorkflows).toHaveBeenCalledWith(expect.objectContaining(owner));
});
it("finds old active threads independently of recent work and resolves state precedence", async () => {
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [
    { id: "failed", sessionId: "old", threadId: "t", title: "Old failed", state: "failed", updatedAt: 30 },
    { id: "working", sessionId: "old", threadId: "t", title: "Old queued", state: "working", updatedAt: 20 },
    { id: "blocked", sessionId: "old", threadId: "t", title: "Old approval", state: "needs_you", updatedAt: 10 },
  ], nextCursor: null });
  setup();
  expect(await screen.findByRole("link", { name: "Old approval" })).toBeTruthy();
  expect(screen.queryByText("Old failed")).toBeNull();
  expect(screen.queryByText("Old queued")).toBeNull();
});
it("hides cached active work on an error without an all-clear empty state", async () => {
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [{ id: "q", sessionId: "s", threadId: "t", title: "Private approval", state: "needs_you", updatedAt: 1 }], nextCursor: "next" });
  const { client } = setup();
  expect(await screen.findByText("Private approval")).toBeTruthy();
  vi.mocked(api.listWorkspaceActiveWork).mockRejectedValue(new Error("denied"));
  await act(async () => { await client.refetchQueries({ queryKey: ["workspace-active-work"] }); });
  expect(await screen.findByText("Could not load active work.")).toBeTruthy();
  expect(screen.queryByText("Private approval")).toBeNull();
  expect(screen.queryByText("No attention items in the loaded work.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more active work" })).toBeNull();
});
it("resets active paging and hides previous workspace results on scope change", async () => {
  vi.mocked(api.listWorkspaceActiveWork).mockImplementation(async (scope, cursor) => ({ items: [{ id: "q", sessionId: "s", threadId: "t", title: scope.ownerId === "u" ? "Personal item" : "Team item", state: "working", updatedAt: 1 }], nextCursor: cursor ? null : "next" }));
  const { rerender, client } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Load more active work" }));
  await waitFor(() => expect(api.listWorkspaceActiveWork).toHaveBeenCalledWith(owner, "next"));
  owner = { ownerType: "team", ownerId: "team" };
  rerender(<QueryClientProvider client={client}><WorkspaceCatchUp /></QueryClientProvider>);
  expect(screen.queryByText("Personal item")).toBeNull();
  expect(await screen.findByText("Team item")).toBeTruthy();
  expect(api.listWorkspaceActiveWork).toHaveBeenCalledWith(owner, undefined);
});
it("only accepts explicit HTTP result links", () => {
  expect(safeResultUrl("data:text/html,test")).toBeUndefined();
  expect(safeResultUrl("/relative/path")).toBeUndefined();
  expect(safeResultUrl("https://example.com/report")).toBe("https://example.com/report");
});
