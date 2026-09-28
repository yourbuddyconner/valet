// @vitest-environment jsdom
/**
 * The team dashboard's two testable halves: `mergeTeamFeed` (pure — ordering,
 * the cap, attribution, tone mapping) and the header's assistant line, which
 * must name an assistant exactly as the rail, the chat header and the
 * assistants list do. One name for one thing: the header calls the shared
 * `assistantLabel`, so an unnamed default reads "Default Orchestrator" on every
 * surface instead of "Untitled assistant" on this one.
 */
import { render, screen } from "@testing-library/react";
import type {
  GlobalWorkflowRunSummary,
  ListTeamsResponse,
  ChildWorkSummary,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
let teamsData: ListTeamsResponse = { teams: [] };

// The header and cards render bare Links, which need a router — stub them to
// anchors, same as every other test of a routed surface.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

// importOriginal, not a bare replacement: these modules export more than the
// dashboard's own graph reads, and a partial factory would govern the module
// for everything else in the file.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return { ...actual, useTeams: () => ({ data: teamsData, isLoading: false, error: null }) };
});
vi.mock("~/api/workspace-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/workspace-runtime")>();
  return {
    ...actual,
    useWorkspaceRuntimeInfo: () => ({ data: { sessionId: "team-runtime" }, error: null, refetch: vi.fn() }),
  };
});
vi.mock("~/api/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/workflows")>();
  return {
    ...actual,
    useWorkflows: () => ({ data: { workflows: [] }, error: null, refetch: vi.fn() }),
    useRuns: () => ({ data: { runs: [] }, error: null, refetch: vi.fn() }),
  };
});
vi.mock("~/api/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/usage")>();
  return { ...actual, useUsageBreakdown: () => ({ data: undefined, error: null }) };
});
vi.mock("~/api/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/artifacts")>();
  return { ...actual, useArtifacts: () => ({ data: { artifacts: [] }, error: null }) };
});
vi.mock("~/api/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/memory")>();
  return { ...actual, useMemoryTree: () => ({ data: { entries: [] }, error: null }) };
});

import { TeamDashboard, mergeTeamFeed } from "./team-dashboard";

function child(overrides: Partial<ChildWorkSummary> = {}): ChildWorkSummary {
  return {
    sessionId: "child-1",
    title: "Audit PR",
    parentThreadId: "th-1",
    status: "settled",
    createdAt: 100,
    ...overrides,
  };
}

function run(overrides: Partial<GlobalWorkflowRunSummary> = {}): GlobalWorkflowRunSummary {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowName: "triage",
    status: "settled",
    outcome: "completed",
    createdAt: 50,
    updatedAt: 50,
    ...overrides,
  };
}

describe("mergeTeamFeed", () => {
  it("merges both kinds newest-first and caps the result", () => {
    const children = [child({ sessionId: "c1", createdAt: 30 }), child({ sessionId: "c2", createdAt: 10 })];
    const runs = [run({ runId: "r1", createdAt: 20 })];
    const feed = mergeTeamFeed(children, runs, 2);
    expect(feed.map((i) => i.key)).toEqual(["child:c1", "run:r1"]);
  });

  it("attributes child executions to team work", () => {
    const named = mergeTeamFeed([child()], [])[0];
    expect(named?.actor).toBe("Team work");
    expect(named?.title).toBe("Audit PR");

    const unnamed = mergeTeamFeed([child()], [])[0];
    expect(unnamed?.actor).toBe("Team work");
  });

  it("maps tones: running children run; failed or cancelled outcomes fail; parked runs still run", () => {
    expect(mergeTeamFeed([child({ status: "running" })], [])[0]?.tone).toBe("running");
    expect(mergeTeamFeed([], [run({ outcome: "failed" })])[0]?.tone).toBe("failed");
    expect(mergeTeamFeed([], [run({ outcome: "cancelled" })])[0]?.tone).toBe("failed");
    expect(mergeTeamFeed([], [run({ status: "parked", outcome: undefined })])[0]?.tone).toBe("running");
    expect(mergeTeamFeed([], [run()])[0]?.tone).toBe("done");
  });

  it("labels a workflow run by its outcome when settled, its status while moving", () => {
    expect(mergeTeamFeed([], [run()])[0]?.statusLabel).toBe("completed");
    expect(mergeTeamFeed([], [run({ status: "running", outcome: undefined })])[0]?.statusLabel).toBe(
      "running",
    );
  });
});

describe("TeamDashboard header", () => {
  it("opens workspace threads instead of profile editors", () => {
    render(<TeamDashboard teamId="team-1" />);
    expect(screen.getByRole("link", { name: "Open threads" }).getAttribute("href")).toBe("/chat");
    expect(screen.queryByRole("link", { name: "Edit assistant" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sentinel" })).toBeNull();
  });
});

vi.mock("~/api/child-work", async (importOriginal) => {
 const actual = await importOriginal<typeof import("~/api/child-work")>();
 return { ...actual, useChildWork: () => ({ data: { pages: [{ children: [], runningCount: 0, nextCursor: null }] }, error: null, refetch: vi.fn() }) };
});
