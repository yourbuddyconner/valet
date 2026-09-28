// @vitest-environment jsdom
/**
 * Dashboard branch (assistant-centered web UI, decision 11/20): `/` shows
 * the identity step when `info.name === null` (first visit), otherwise the
 * identity header + card grid. Card internals (each a self-contained
 * query, decision 15) are stubbed here so this test stays focused on the
 * naming-vs-dashboard branch — they're covered by their own component
 * tests.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const infoMock = vi.fn();

// The dashboard renders bare Links (Manage assistants), which need a router
// — mock them to anchors, same as every other route test.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => infoMock(),
  useOrchestratorChildren: () => ({
    data: { children: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSaveIdentity: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useNotifications: () => ({
      data: { notifications: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("~/components/assistant/threads-card", () => ({
  ThreadsCard: () => <div data-testid="threads-card" />,
}));
vi.mock("~/components/assistant/memory-card", () => ({
  MemoryCard: () => <div data-testid="memory-card" />,
}));
vi.mock("~/components/assistant/usage-card", () => ({
  UsageCard: () => <div data-testid="usage-card" />,
}));
vi.mock("~/components/dashboard/team-dashboard", () => ({
  TeamDashboard: ({ teamId }: { teamId: string }) => (
    <div data-testid="team-dashboard" data-team={teamId} />
  ),
}));

// The workspace branch (team dashboard design): `Home` reads the scope and
// picks a dashboard. Personal is the context default, so only the team
// arm needs the mock to steer.
const scopeMock = vi.fn((): { key: string; teamId: string | undefined; available: string[]; setKey: (next: string) => void } => ({
  key: "user",
  teamId: undefined,
  available: ["user"],
  setKey: vi.fn(),
}));
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return { ...actual, useWorkspaceScope: () => scopeMock() };
});

import { Dashboard, Home } from "./index";

function renderDashboard() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

describe("Dashboard", () => {
  it("shows the identity step on first visit (name === null)", () => {
    infoMock.mockReturnValue({
      data: {
        sessionId: "orchestrator:user-1",
        name: null,
        personality: null,
        presence: "idle",
        activeChildren: 0,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderDashboard();

    expect(screen.queryByText("Meet your assistant")).toBeNull();
    expect(screen.getByTestId("threads-card")).toBeTruthy();
  });

  it("shows the identity header + card grid once named", () => {
    infoMock.mockReturnValue({
      data: {
        sessionId: "orchestrator:user-1",
        name: "Echo",
        personality: null,
        presence: "idle",
        activeChildren: 0,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByTestId("threads-card")).toBeTruthy();
    expect(screen.getByTestId("memory-card")).toBeTruthy();
    expect(screen.getByTestId("usage-card")).toBeTruthy();
    expect(screen.queryByText("Meet your assistant")).toBeNull();
  });

  it("shows a loading state while the info query is in flight", () => {
    infoMock.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    renderDashboard();
    expect(screen.queryByTestId("threads-card")).toBeNull();
    expect(screen.queryByText("Meet your assistant")).toBeNull();
  });
});

describe("Home (workspace branch)", () => {
  it("renders the personal dashboard when the scope is personal", () => {
    scopeMock.mockReturnValue({ key: "user", teamId: undefined, available: ["user"], setKey: vi.fn() });
    infoMock.mockReturnValue({
      data: { sessionId: "orchestrator:user-1", name: null, personality: null, presence: "idle", activeChildren: 0 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("team-dashboard")).toBeNull();
  });

  it("renders the team dashboard when the scope names a team", () => {
    scopeMock.mockReturnValue({ key: "team_1", teamId: "team_1", available: ["user", "team_1"], setKey: vi.fn() });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>,
    );
    const dash = screen.getByTestId("team-dashboard");
    expect(dash.getAttribute("data-team")).toBe("team_1");
  });
});
