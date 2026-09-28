// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { WorkspaceBriefing } from "@valet/api/wire";
import { api, type OwnerFilter } from "~/api/client";
import { WorkspaceCatchUp } from "./workspace-catch-up";
let owner: OwnerFilter | undefined;
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ error: null }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, params, search }: { children: ReactNode; to: string; params?: Record<string, string>; search?: { thread?: string } }) => <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to) + (search?.thread ? `?thread=${search.thread}` : "")}>{children}</a> }));
vi.mock("~/api/client", () => ({ api: { getWorkspaceBriefings: vi.fn() } }));
vi.mock("./workspace-activity", () => ({ WorkspaceActivity: () => <div>Detailed activity</div>, safeResultUrl: (value?: string) => {
  try { const url = new URL(value ?? ""); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
} }));
const briefing: WorkspaceBriefing = {
  id: "goal-routing", title: "Make event routing reliable",
  summary: "The routing change and replay checks are ready. The PR and report cover the implementation; rollout awaits your review.",
  status: "needs_attention", updatedAt: 100,
  latestThread: { sessionId: "runtime", threadId: "rollout-review", title: "Review routing rollout" },
  sources: [
    { id: "planning", kind: "thread", title: "Routing design", updatedAt: 10, sessionId: "runtime", threadId: "design" },
    { id: "pr", kind: "pull_request", title: "TKAI-42 routing PR", updatedAt: 50, url: "https://github.com/acme/app/pull/42", runId: "run-implementation" },
    { id: "report", kind: "artifact", title: "Replay report", updatedAt: 60, token: "replay-report" },
    { id: "verification", kind: "workflow", title: "Replay verification", updatedAt: 70, runId: "run-verification" },
  ],
};
beforeEach(() => {
  vi.clearAllMocks(); owner = { ownerType: "user", ownerId: "u" };
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [briefing], generatedAt: 100, coverage: "recent" });
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><WorkspaceCatchUp /></QueryClientProvider>);
  return { client, ...view };
}
it("briefs one goal across conversations and runs with one concise summary", async () => {
  setup();
  const article = await screen.findByRole("article", { name: briefing.title });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(within(article).getByText(briefing.summary)).toBeTruthy();
  expect(within(article).queryByText("Next step")).toBeNull();
  expect(within(article).getByRole("link", { name: "Latest thread" }).getAttribute("href")).toBe("/sessions/runtime?thread=rollout-review");
  expect(within(article).getByRole("link", { name: "Routing design" }).getAttribute("href")).toBe("/sessions/runtime?thread=design");
  expect(within(article).getByRole("link", { name: "TKAI-42 routing PR" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
  expect(within(article).getByRole("link", { name: "Replay report" }).getAttribute("href")).toBe("/a/replay-report");
  expect(within(article).getByRole("list", { name: "Sources" }).querySelector("a")?.textContent).toBe("TKAI-42 routing PR");
  expect(screen.queryByText("Detailed activity")).toBeNull();
  expect(screen.getByRole("link", { name: "Replay verification" }).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("1 more source"));
  expect(screen.getByRole("link", { name: "Replay verification" }).closest("details")?.open).toBe(true);
  expect(screen.getByRole("link", { name: "Replay verification" }).getAttribute("href")).toBe("/workflows/runs/run-verification");
});
it("does not invent a conversation or completion when only workflow evidence exists", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [{ ...briefing, latestThread: null, status: "updated", sources: [{ id: "run", kind: "workflow", title: "Verification run", updatedAt: 1, runId: "run" }, { id: "unknown", kind: "message", title: "Imported note", updatedAt: 1, url: "javascript:alert(1)" }] }], generatedAt: 100, coverage: "recent" });
  setup();
  expect(await screen.findByText("No linked conversation")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Latest thread" })).toBeNull();
  expect(screen.getByRole("link", { name: "Verification run" }).getAttribute("href")).toBe("/workflows/runs/run");
  expect(screen.queryByRole("link", { name: "Imported note" })).toBeNull();
  expect(screen.getByText("Imported note")).toBeTruthy();
  expect(screen.queryByText("Next step")).toBeNull();
  expect(screen.queryByText("Completed")).toBeNull();
});
it("prepares without an unscoped request while identity is unresolved", () => {
  owner = undefined;
  setup();
  expect(screen.getByText("Preparing your briefing…")).toBeTruthy();
  expect(api.getWorkspaceBriefings).not.toHaveBeenCalled();
});
it("hides cached briefs on refresh failure and retries explicitly", async () => {
  const { client } = setup();
  expect(await screen.findByText(briefing.summary)).toBeTruthy();
  vi.mocked(api.getWorkspaceBriefings).mockRejectedValue(new Error("denied"));
  await act(async () => { await client.refetchQueries({ queryKey: ["workspace-briefings"] }); });
  expect(await screen.findByText("Could not prepare your briefing.")).toBeTruthy();
  expect(screen.queryByText(briefing.summary)).toBeNull();
  expect(screen.queryByRole("link", { name: "Latest thread" })).toBeNull();
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [briefing], generatedAt: 100, coverage: "recent" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(briefing.summary)).toBeTruthy();
});
it("hides personal context immediately when switching to a team", async () => {
  const { client, rerender } = setup();
  expect(await screen.findByText(briefing.summary)).toBeTruthy();
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [{ ...briefing, id: "team-goal", title: "Team goal", summary: "Team conclusion" }], generatedAt: 100, coverage: "recent" });
  owner = { ownerType: "team", ownerId: "team" };
  rerender(<QueryClientProvider client={client}><WorkspaceCatchUp /></QueryClientProvider>);
  expect(screen.queryByText(briefing.summary)).toBeNull();
  expect(await screen.findByText("Team conclusion")).toBeTruthy();
  expect(api.getWorkspaceBriefings).toHaveBeenCalledWith(owner);
});
it("shows a retry state when generation is unavailable without inventing context", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [], generatedAt: null, coverage: "recent", unavailable: true });
  setup();
  expect(await screen.findByText("Your briefing is unavailable. Retry to prepare it from your recent work.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("article")).toBeNull();
});
it("keeps activity details closed and mounts them only on request", async () => {
  setup();
  await screen.findByText(briefing.summary);
  expect(screen.queryByText("Detailed activity")).toBeNull();
  fireEvent.click(screen.getByText("Activity details"));
  await waitFor(() => expect(screen.getByText("Detailed activity")).toBeTruthy());
});
it("shows an honest briefing when no source links are available", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [{ ...briefing, latestThread: null, sources: [] }], generatedAt: 100, coverage: "recent" });
  setup();
  expect(await screen.findByText(briefing.summary)).toBeTruthy();
  expect(screen.getByText("No linked conversation")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Sources" })).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
it("distinguishes an empty workspace from unavailable generation", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [], generatedAt: null, coverage: "recent" });
  setup();
  expect(await screen.findByText("No recent work to brief yet. Your goals and results will appear here as you work.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("shows pending shared generation as loading rather than an error", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [], generatedAt: null, coverage: "recent", refreshing: true });
  setup();
  expect(await screen.findByText("Updating your briefing…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});
