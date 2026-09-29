// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { OwnerFilter } from "~/api/client";
import { api } from "~/api/client";
import { WorkDiscovery, WorkArtifacts } from "./work-discovery";
let owner: OwnerFilter | undefined;
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ error: null }) }));
vi.mock("~/components/new-session-dialog", () => ({ NewSessionDialog: () => null }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("~/api/client", () => ({ api: { getWorkspaceBriefings: vi.fn(), listWork: vi.fn(), listArtifacts: vi.fn(), listWorkspaceOutcomes: vi.fn(), listWorkspaceActiveWork: vi.fn(), listWorkflows: vi.fn(), listRuns: vi.fn(), listWorkflowActionRequired: vi.fn() } }));
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks(); owner = undefined;
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [], generatedAt: 1, coverage: "recent" });
  vi.mocked(api.listWorkspaceOutcomes).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listWorkflowActionRequired).mockResolvedValue({ items: [], count: 0 });
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [] });
  vi.mocked(api.listRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [], nextCursor: null });
});
it("does not fetch an unscoped list while identity loads", () => {
  render(<WorkDiscovery />, { wrapper });
  expect(api.listWork).not.toHaveBeenCalled();
  expect(screen.getByText("Preparing your briefing…")).toBeTruthy();
});
it("resets paged work when the workspace changes", async () => {
  owner = { ownerType: "user", ownerId: "u" };
  vi.mocked(api.listWork).mockResolvedValueOnce({ sessions: [], nextCursor: "next" })
    .mockResolvedValueOnce({ sessions: [], nextCursor: null })
    .mockResolvedValue({ sessions: [], nextCursor: null });
  const view = render(<WorkDiscovery />, { wrapper });
  fireEvent.click(screen.getByText("Activity details"));
  fireEvent.click(await screen.findByText("Recent work · 0 loaded"));
  fireEvent.click(await screen.findByRole("button", { name: "Load more work" }));
  await waitFor(() => expect(api.listWork).toHaveBeenCalledWith(owner, "next"));
  owner = { ownerType: "team", ownerId: "t" };
  view.rerender(<WorkDiscovery />);
  fireEvent.click(screen.getByText("Activity details"));
  await waitFor(() => expect(api.listWork).toHaveBeenCalledWith(owner, undefined));
  expect(await screen.findByText("No attention items in the loaded work.")).toBeTruthy();
});
it("shows retry on failed discovery", async () => {
  owner = { ownerType: "team", ownerId: "t" };
  vi.mocked(api.listWork).mockRejectedValue(new Error("denied"));
  render(<WorkDiscovery />, { wrapper });
  fireEvent.click(screen.getByText("Activity details"));
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByText("No work yet. Select New work to start.")).toBeNull();
});
it("loads source artifacts only when expanded, with both owner and runtime identity", async () => {
  const scopedOwner: OwnerFilter = { ownerType: "team", ownerId: "t" };
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [], nextCursor: null });
  render(<WorkArtifacts owner={scopedOwner} sessionId="child" />, { wrapper });
  expect(api.listArtifacts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Artifacts from this work" }));
  await waitFor(() => expect(api.listArtifacts).toHaveBeenCalledWith(scopedOwner, { sourceSessionId: "child", limit: 10, cursor: undefined }));
  expect(await screen.findByText("No published artifacts from this work.")).toBeTruthy();
});

it("binds artifact discovery to the selected transcript thread", async () => {
  const scopedOwner: OwnerFilter = { ownerType: "team", ownerId: "t" };
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [], nextCursor: null });
  render(<WorkArtifacts owner={scopedOwner} sessionId="assistant:t" threadId="th-two" />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Artifacts from this thread" }));
  await waitFor(() => expect(api.listArtifacts).toHaveBeenCalledWith(scopedOwner, { sourceSessionId: "assistant:t", sourceThreadId: "th-two", limit: 10, cursor: undefined }));
});

it("hides cached work and pagination when a refresh loses workspace access", async () => {
  owner = { ownerType: "team", ownerId: "t" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.listWork).mockResolvedValueOnce({ sessions: [{
    id: "private-work", title: "Private work", workspace: "/tmp", status: "active", kind: "code", runState: "idle",
    createdAt: 1, updatedAt: 1, lastActivityAt: 1, owner: { type: "team", id: "t" },
  }], nextCursor: "next" });
  render(<QueryClientProvider client={client}><WorkDiscovery /></QueryClientProvider>);
  fireEvent.click(screen.getByText("Activity details"));
  fireEvent.click(await screen.findByText("Recent work · 1 loaded"));
  expect(await screen.findByText("Private work")).toBeTruthy();
  vi.mocked(api.listWork).mockRejectedValue(new Error("404: workspace not found"));
  await act(async () => { await client.refetchQueries({ queryKey: ["workspace-work"] }); });
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByText("Private work")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more work" })).toBeNull();
});
it("hides cached artifacts and pagination when a refresh loses workspace access", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.listArtifacts).mockResolvedValueOnce({ artifacts: [{
    id: "private-artifact", title: "Private report", ownerType: "team", path: "report.md", format: "markdown", icon: "",
    version: 1, sharedVersion: null, token: "token", url: "/a/token", visibility: "org", actorUserId: "u",
    revoked: false, createdAt: 1, updatedAt: 1,
  }], nextCursor: "next" });
  render(<QueryClientProvider client={client}><WorkArtifacts owner={{ ownerType: "team", ownerId: "t" }} sessionId="s" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Artifacts from this work" }));
  expect(await screen.findByText("Private report")).toBeTruthy();
  vi.mocked(api.listArtifacts).mockRejectedValue(new Error("404: workspace not found"));
  await act(async () => { await client.refetchQueries({ queryKey: ["artifacts", "work"] }); });
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByText("Private report")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more artifacts" })).toBeNull();
});

it("shows results without creation or artifact management controls", async () => {
  owner = { ownerType: "team", ownerId: "t" };
  vi.mocked(api.listWork).mockResolvedValue({ sessions: [], nextCursor: null });
  render(<WorkDiscovery />, { wrapper });
  expect(await screen.findByRole("heading", { name: "Nothing to brief yet" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Recent results" })).toBeNull();
  expect(api.listWork).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Briefing" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New work" })).toBeNull();
  expect(screen.queryByRole("button", { name: "All workspace artifacts" })).toBeNull();
});
