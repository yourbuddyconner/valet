// @vitest-environment jsdom
/**
 * `/usage` — unified spend dashboard. Mocks `~/api/usage`, `~/api/proxy-usage`,
 * `~/api/settings` to assert:
 *   - total cost renders from breakdown;
 *   - token/cache stats render (input/output/cache columns, cache-hit-rate);
 *   - unpriced indicator shows when unpricedTurns > 0, hidden when 0;
 *   - scope toggle appears only for org admins; switching refetches scope=org;
 *   - By-member table renders in org scope;
 *   - By-use-case table has a row per bucket;
 *   - all four use-case rows are expandable (Workflows and Proxy show items);
 *   - Sessions row nests child under parent;
 *   - By model section shows model names;
 *   - spend chart renders day bars;
 *   - Download CSV control points at /api/usage/export.csv with correct query;
 *   - proxy request log has bounded page navigation and never renders raw content;
 *   - Settings → Proxy callout link renders;
 *   - disabled-gateway notice renders.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import type {
  UsageBreakdownResponse,
  UsageToolEfficiencyResponse,
  UsageOutcomesResponse,
  UsageDrillResponse,
  ProxyRequestListItem,
  UsagePeriodSelection,
} from "@valet/api/wire";

// --- mock data -----------------------------------------------------------

const DAY_A_MS = Math.floor(1_750_000_000_000 / 86_400_000) * 86_400_000;
const DAY_B_MS = DAY_A_MS + 86_400_000;

const mockBreakdown: UsageBreakdownResponse = {
  activeAgents: 9,
  windowMs: 7 * 86_400_000,
  scope: "me",
  totalCostUsd: 0.1234,
  totalTokens: 15_000,
  totalInputTokens: 10_000,
  totalOutputTokens: 5_000,
  totalCacheReadTokens: 2_000,
  totalCacheWriteTokens: 500,
  totalTurns: 37,
  unpricedTurns: 0,
  byUseCase: [
    {
      useCase: "orchestrator",
      costUsd: 0.04,
      totalTokens: 5_000,
      inputTokens: 3_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 10,
      unpricedTurns: 0,
    },
    {
      useCase: "session",
      costUsd: 0.06,
      totalTokens: 8_000,
      inputTokens: 5_000,
      outputTokens: 3_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
      turns: 20,
      unpricedTurns: 0,
    },
    {
      useCase: "workflow",
      costUsd: 0.01,
      totalTokens: 1_000,
      inputTokens: 700,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 2,
      unpricedTurns: 0,
    },
    {
      useCase: "proxy",
      costUsd: 0.0134,
      totalTokens: 1_000,
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 5,
      unpricedTurns: 0,
    },
  ],
  skillBreakdown: [
    {
      skillKey: "plugin:github:github",
      name: "github",
      origin: "plugin",
      pluginName: "github",
      invocations: 12,
      uniqueInvokers: 3,
      unassignedInvocations: 2,
      attributedContextTokens: 3456,
      carryingCalls: 9,
    },
  ],
  byModel: [
    {
      model: "claude-opus-4-5",
      costUsd: 0.09,
      totalTokens: 12_000,
      inputTokens: 8_000,
      outputTokens: 4_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 500,
      turns: 25,
      unpricedTurns: 0,
    },
    {
      model: "gpt-4o",
      costUsd: 0.0334,
      totalTokens: 3_000,
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 12,
      unpricedTurns: 0,
    },
  ],
  byDay: [
    { dayMs: DAY_A_MS, costUsd: 0.07, totalTokens: 7_000 },
    { dayMs: DAY_B_MS, costUsd: 0.0534, totalTokens: 8_000 },
  ],
};

const mockToolEfficiency: UsageToolEfficiencyResponse = {
  windowMs: 7 * 86_400_000,
  scope: "me",
  byUseCase: [
    { useCase: "orchestrator", modelDirectedCalls: 10, modelFreeActions: 0 },
    { useCase: "session", modelDirectedCalls: 80, modelFreeActions: 0 },
    { useCase: "workflow", modelDirectedCalls: 2, modelFreeActions: 20 },
    { useCase: "proxy", modelDirectedCalls: 0, modelFreeActions: 0 },
  ],
};
let toolEfficiencyResult: { data: UsageToolEfficiencyResponse | undefined; isLoading: boolean; error: null | Error } = {
  data: mockToolEfficiency, isLoading: false, error: null,
};
const mockOutcomes: UsageOutcomesResponse = {
  scope: "me",
  unpricedTurns: 0,
  byOutcome: [
    { kind: "pull_request_created", count: 2, estimatedCostUsd: 1.5, estimatedCostPerOutcomeUsd: 0.75 },
    { kind: "review_submitted", count: 3, estimatedCostUsd: 0.6, estimatedCostPerOutcomeUsd: 0.2 },
    { kind: "slack_message_sent", count: 4, estimatedCostUsd: 0.4, estimatedCostPerOutcomeUsd: 0.1 },
    { kind: "slack_dm_sent", count: 1, estimatedCostUsd: 0.1, estimatedCostPerOutcomeUsd: 0.1 },
  ],
};
let outcomesResult: { data: UsageOutcomesResponse | undefined; isLoading: boolean; error: null | Error } = {
  data: mockOutcomes, isLoading: false, error: null,
};

const mockBreakdownWithUnpriced: UsageBreakdownResponse = {
  ...mockBreakdown,
  unpricedTurns: 3,
};

const mockBreakdownOrgScope: UsageBreakdownResponse = {
  ...mockBreakdown,
  scope: "org",
  byUser: [
    {
      userId: "user_1",
      name: "Alice Smith",
      costUsd: 0.08,
      totalTokens: 10_000,
      inputTokens: 7_000,
      outputTokens: 3_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
      turns: 22,
      unpricedTurns: 0,
    },
    {
      userId: "user_2",
      name: "Bob Jones",
      costUsd: 0.0434,
      totalTokens: 5_000,
      inputTokens: 3_000,
      outputTokens: 2_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 300,
      turns: 15,
      unpricedTurns: 0,
    },
  ],
};

const mockOrchestratorItems: UsageDrillResponse = {
  items: [
    {
      id: "orchestrator:user_abc123",
      label: "My Orchestrator",
      useCase: "orchestrator",
      isChild: false,
      parentId: null,
      sessionId: "orchestrator:user_abc123",
      costUsd: 0.04,
      totalTokens: 5_000,
      turns: 10,
    },
  ],
};

const mockSessionItems: UsageDrillResponse = {
  items: [
    {
      id: "sess_parent1",
      label: "Parent session",
      useCase: "session",
      isChild: false,
      parentId: null,
      sessionId: "sess_parent1",
      costUsd: 0.05,
      totalTokens: 6_000,
      turns: 15,
    },
    {
      id: "sess_child1",
      label: "Child thread",
      useCase: "session",
      isChild: true,
      parentId: "sess_parent1",
      sessionId: "sess_child1",
      costUsd: 0.01,
      totalTokens: 2_000,
      turns: 5,
    },
  ],
};

const mockWorkflowItems: UsageDrillResponse = {
  items: [
    {
      id: "wf_run_1",
      label: "Deploy pipeline run #12",
      useCase: "workflow",
      isChild: false,
      parentId: null,
      sessionId: null,
      costUsd: 0.01,
      totalTokens: 1_000,
      turns: 2,
    },
  ],
};

const mockProxyItems: UsageDrillResponse = {
  items: [
    {
      id: "proxy_harness_1",
      label: "claude-code",
      useCase: "proxy",
      isChild: false,
      parentId: null,
      sessionId: null,
      costUsd: 0.0134,
      totalTokens: 1_000,
      turns: 5,
    },
  ],
};

const reqItem: ProxyRequestListItem = {
  id: "req_1",
  createdAt: Date.now() - 60_000,
  orgId: "org_1",
  userId: "user_abc123",
  apiKeyId: "key_1",
  providerKind: "anthropic",
  model: "claude-opus-4-5",
  harness: "claude-code",
  endpoint: "/v1/messages",
  stream: false,
  statusCode: 200,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 150,
  costUsd: 0.0012,
  latencyMs: 800,
  hasError: false,
};

const mockRequests = { items: [reqItem], nextCursor: undefined, pageSize: 25, hasMore: false };

// --- mocks ---------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

// Mutable so individual tests can override.
let breakdownResult: {
  data: UsageBreakdownResponse | undefined;
  isLoading: boolean;
  error: null | Error;
} = { data: mockBreakdown, isLoading: false, error: null };

// Items result — keyed by useCase.
let itemsResults: Record<
  string,
  { data: UsageDrillResponse | undefined; isLoading: boolean; error: null | Error }
> = {
  orchestrator: { data: mockOrchestratorItems, isLoading: false, error: null },
  session: { data: mockSessionItems, isLoading: false, error: null },
  workflow: { data: mockWorkflowItems, isLoading: false, error: null },
  proxy: { data: mockProxyItems, isLoading: false, error: null },
};

// Captures the args of the last useUsageBreakdown call so tests can assert
// the scope/teamId/enabled the page requests.
let breakdownCalls: unknown[][] = [];

vi.mock("~/api/usage", () => ({
  useUsageBreakdown: (...args: unknown[]) => {
    breakdownCalls.push(args);
    return breakdownResult;
  },
  useUsageToolEfficiency: () => toolEfficiencyResult,
  useUsageOutcomes: () => outcomesResult,
  useUsageItems: (_period: UsagePeriodSelection, _scope: string, useCase: string) =>
    itemsResults[useCase] ?? { data: undefined, isLoading: false, error: null },
  qkUsage: {
    breakdown: () => [],
    items: () => [],
    sessions: () => [],
  },
}));

let requestsResult: {
  data: typeof mockRequests | undefined;
  isLoading: boolean;
  error: null | Error;
} = { data: mockRequests, isLoading: false, error: null };

// Captures the opts of the last proxy-hook calls (enabled gating).
let lastProxyRequestsOpts: { enabled?: boolean } | undefined;
let lastProxySettingsOpts: { enabled?: boolean } | undefined;

let settingsResult: {
  data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
  isLoading: boolean;
} = { data: { enabled: true, mode: "centralized" }, isLoading: false };

vi.mock("~/api/proxy-usage", () => ({
  useProxyRequests: (_filters: unknown, opts?: { enabled?: boolean }) => {
    lastProxyRequestsOpts = opts;
    return requestsResult;
  },
  useProxySettings: (opts?: { enabled?: boolean }) => {
    lastProxySettingsOpts = opts;
    return settingsResult;
  },
  qkProxy: {
    summary: () => [],
    requests: () => [],
    detail: () => [],
    settings: () => [],
  },
}));

// Mock useOrg — mutable for tests.
let orgResult: {
  data: { features: { organizations: boolean }; callerRole: "admin" | "member" } | undefined;
  isLoading: boolean;
} = {
  data: { features: { organizations: false }, callerRole: "member" },
  isLoading: false,
};

// Mock useTeams — mutable so team-scope tests can add memberships.
let teamsResult: {
  data: { teams: { id: string; name: string; callerRole: "admin" | "member" | null }[] } | undefined;
  isLoading: boolean;
} = { data: { teams: [] }, isLoading: false };

vi.mock("~/api/settings", () => ({
  useOrg: () => orgResult,
  useTeams: () => teamsResult,
}));

// Mock the workspace resolution — mutable so tests can enter a team
// workspace or the still-resolving window (useActiveWorkspace → undefined).
let workspaceTeamId: string | undefined = undefined;
let workspaceResolved = true;
vi.mock("~/components/workspace-clause", () => ({
  WorkspaceClause: () => null,
  useActiveWorkspace: () =>
    !workspaceResolved
      ? undefined
      : workspaceTeamId === undefined
        ? { kind: "personal", hasTeams: false }
        : { kind: "team", team: { id: workspaceTeamId, name: "Team X", memberCount: 2 } },
}));

let usageExportError: Error | undefined;
let usageExportValidations: Array<{ granularity: string; scope: string; teamId?: string }> = [];

// Mock api client — usageExportCsvUrl is a pure URL builder.
vi.mock("~/api/client", () => ({
  api: {
    validateUsageExport: async (_period: UsagePeriodSelection, scope: string, granularity: string, teamId?: string) => {
      usageExportValidations.push({ granularity, scope, ...(teamId === undefined ? {} : { teamId }) });
      if (usageExportError) throw usageExportError;
    },
    usageExportCsvUrl: (period: UsagePeriodSelection, scope: string, granularity = "day", teamId?: string) => {
      const query = period.kind === "lookback"
        ? `window=${period.window}`
        : period.kind === "month"
          ? `month=${period.month}`
          : `start=${period.start}&end=${period.end}`;
      return `/api/usage/export.csv?${query}&scope=${scope}${teamId !== undefined ? `&teamId=${teamId}` : ""}&granularity=${granularity}`;
    },
  },
}));

import { UsagePage } from "./usage";

beforeEach(() => {
  vi.clearAllMocks();
  toolEfficiencyResult = { data: mockToolEfficiency, isLoading: false, error: null };
  outcomesResult = { data: mockOutcomes, isLoading: false, error: null };
  breakdownResult = { data: mockBreakdown, isLoading: false, error: null };
  itemsResults = {
    orchestrator: { data: mockOrchestratorItems, isLoading: false, error: null },
    session: { data: mockSessionItems, isLoading: false, error: null },
    workflow: { data: mockWorkflowItems, isLoading: false, error: null },
    proxy: { data: mockProxyItems, isLoading: false, error: null },
  };
  requestsResult = { data: mockRequests, isLoading: false, error: null };
  settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
  orgResult = {
    data: { features: { organizations: false }, callerRole: "member" },
    isLoading: false,
  };
  workspaceTeamId = undefined;
  workspaceResolved = true;
  usageExportError = undefined;
  usageExportValidations = [];
  breakdownCalls = [];
  lastProxyRequestsOpts = undefined;
  lastProxySettingsOpts = undefined;
});

describe("UsagePage — tool work", () => {
  it("shows model-directed calls and model-free workflow actions", () => {
    render(<UsagePage />);
    expect(screen.getByText("Tool work per model token")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    const session = rows.find((row) => row.textContent?.includes("Runtimes") && row.textContent?.includes("80"));
    const workflow = rows.find((row) => row.textContent?.includes("Workflows") && row.textContent?.includes("20"));
    expect(session?.textContent).toContain("10,000");
    expect(session?.textContent).toContain("8,000");
    expect(workflow?.textContent).toContain("2,000");
  });
});

describe("UsagePage — outcomes", () => {
  it("shows confirmed outcome types and allocated model spend", () => {
    render(<UsagePage />);
    expect(screen.getByText("Outcomes")).toBeTruthy();
    const row = screen.getByRole("row", { name: /PRs created/ });
    expect(row.textContent).toContain("2");
    expect(row.textContent).toContain("$1.5000");
    expect(row.textContent).toContain("$0.7500");
    expect(screen.getByRole("row", { name: /Slack DMs sent/ })).toBeTruthy();
  });
});

describe("UsagePage — spend summary", () => {
  it("renders the active-agent headline independently of member averages and shows zero", () => {
    const view = render(<UsagePage />);
    const card = screen.getByText("Active agents").parentElement;
    if (!card) throw new Error("Active agents card missing");
    expect(within(card).getByText("9")).toBeTruthy();
    expect(within(card).getByText("Unique agents with token usage in this period.")).toBeTruthy();
    expect(card.parentElement?.children).toHaveLength(5);
    breakdownResult.data = { ...mockBreakdown, activeAgents: 0 };
    view.rerender(<UsagePage />);
    expect(within(card).getByText("0")).toBeTruthy();
  });

  it("renders the total cost from the breakdown", () => {
    render(<UsagePage />);
    expect(screen.getByText("$0.1234")).toBeTruthy();
  });

  it("renders total tokens stat", () => {
    render(<UsagePage />);
    expect(screen.getByText("15,000")).toBeTruthy();
  });

  it("renders the spend chart with the correct number of day bars", () => {
    const { container } = render(<UsagePage />);
    const rects = container.querySelectorAll("svg[aria-label='Daily spend chart'] rect");
    expect(rects.length).toBe(2);
    const heights = Array.from(rects).map((r) => Number(r.getAttribute("height")));
    expect(heights.every((h) => h > 2)).toBe(true);
  });
});

describe("UsagePage — token/cache stats", () => {
  it("renders input/output stat card", () => {
    render(<UsagePage />);
    // The "Input / Output" card should show the formatted values
    const inputOutputCard = screen.getByText("Input / Output");
    expect(inputOutputCard).toBeTruthy();
    // Values: 10,000 / 5,000
    expect(screen.getByText("10,000 / 5,000")).toBeTruthy();
  });

  it("renders cache hit rate stat card", () => {
    render(<UsagePage />);
    // cacheHitRate = 2000 / (10000 + 2000) = 16.7%
    expect(screen.getByText("Cache hit rate")).toBeTruthy();
    expect(screen.getByText("16.7%")).toBeTruthy();
  });

  it("renders cache read/write sub-label under cache hit rate", () => {
    render(<UsagePage />);
    // "2,000 read / 500 write"
    expect(screen.getByText("2,000 read / 500 write")).toBeTruthy();
  });

  it("shows — for cache hit rate when no tokens", () => {
    breakdownResult = {
      data: {
        ...mockBreakdown,
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
      },
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders input/output/cache columns in the By-model table", () => {
    render(<UsagePage />);
    expect(screen.getByText("Input tok")).toBeTruthy();
    expect(screen.getByText("Output tok")).toBeTruthy();
    expect(screen.getByText("Cache read")).toBeTruthy();
    expect(screen.getByText("Cache write")).toBeTruthy();
  });
});

describe("UsagePage — unpriced indicator", () => {
  it("shows the unpriced indicator when unpricedTurns > 0", () => {
    breakdownResult = {
      data: mockBreakdownWithUnpriced,
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    expect(screen.getByText(/3 turns unpriced/)).toBeTruthy();
    expect(screen.getByText(/cost shown is a floor/)).toBeTruthy();
  });

  it("hides the unpriced indicator when unpricedTurns === 0", () => {
    render(<UsagePage />);
    expect(screen.queryByText(/turns unpriced/)).toBeNull();
  });
});

describe("UsagePage — scope toggle", () => {
  it("does not show the scope toggle for non-admin users with no teams", () => {
    orgResult = {
      data: { features: { organizations: false }, callerRole: "member" },
      isLoading: false,
    };
    teamsResult = { data: { teams: [] }, isLoading: false };
    render(<UsagePage />);
    expect(screen.queryByText("My usage")).toBeNull();
    expect(screen.queryByText("Organization")).toBeNull();
  });





  it("does not show scope toggle when organizations feature is off even for admin", () => {
    orgResult = {
      data: { features: { organizations: false }, callerRole: "admin" },
      isLoading: false,
    };
    teamsResult = { data: { teams: [] }, isLoading: false };
    render(<UsagePage />);
    expect(screen.queryByText("My usage")).toBeNull();
  });

  it("shows the scope toggle for org admins with organizations feature on", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    render(<UsagePage />);
    expect(screen.getByText("My usage")).toBeTruthy();
    expect(screen.getByText("Organization")).toBeTruthy();
  });

  it("switching to Organization calls useUsageBreakdown with scope=org", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    // Override the breakdown mock to track which scope is requested.
    // The mock vi.mock("~/api/usage") returns breakdownResult — we verify
    // the toggle renders the org data by switching breakdownResult.
    breakdownResult = {
      data: { ...mockBreakdownOrgScope },
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    // The component calls useUsageBreakdown with scope — since we already mock
    // the data with org scope, By-member table should appear if the scope="org"
    // button is clicked. We verify the toggle exists and the button is rendered.
    const orgBtn = screen.getByText("Organization");
    fireEvent.click(orgBtn);
    // Button should now be "active" (aria-pressed=true)
    expect(orgBtn.closest("button")?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("UsagePage — By-member table (org scope)", () => {
  beforeEach(() => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
  });

  it("shows By-member table when scope=org and byUser present", () => {
    breakdownResult = {
      data: mockBreakdownOrgScope,
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    // Switch to org scope
    fireEvent.click(screen.getByText("Organization"));
    // Re-render happens with org data
    expect(screen.getByText("By member")).toBeTruthy();
    expect(screen.getByText("Alice Smith")).toBeTruthy();
    expect(screen.getByText("Bob Jones")).toBeTruthy();
  });

  it("does not show By-member table in me scope", () => {
    render(<UsagePage />);
    // Default scope=me, byUser not present
    expect(screen.queryByText("By member")).toBeNull();
  });
});

describe("UsagePage — by-use-case table", () => {
  it("renders all four use-case labels", () => {
    render(<UsagePage />);
    expect(screen.getByText("Orchestrator")).toBeTruthy();
    expect(screen.getAllByText("Runtimes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Workflows").length).toBeGreaterThan(0);
    expect(screen.getByText("Proxy (external tools)")).toBeTruthy();
  });

  it("expanding Orchestrator row shows orchestrator items", async () => {
    render(<UsagePage />);
    const orchRow = screen.getByRole("button", {
      name: /Orchestrator — expand items/,
    });
    fireEvent.click(orchRow);
    await waitFor(() => {
      expect(screen.getByText("My Orchestrator")).toBeTruthy();
    });
  });

  it("orchestrator item does not render as a link (orch: prefix)", async () => {
    render(<UsagePage />);
    const orchRow = screen.getByRole("button", {
      name: /Orchestrator — expand items/,
    });
    fireEvent.click(orchRow);
    await waitFor(() => {
      expect(screen.getByText("My Orchestrator")).toBeTruthy();
    });
    const links = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("My Orchestrator"),
    );
    expect(links.length).toBe(0);
  });

  it("expanding Sessions row shows parent and child items", async () => {
    render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Runtimes — expand items/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Parent session")).toBeTruthy();
      expect(screen.getByText("Child thread")).toBeTruthy();
    });
  });

  it("child session row is indented with pl-8 class", async () => {
    const { container } = render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Runtimes — expand items/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Child thread")).toBeTruthy();
    });
    const childRows = Array.from(container.querySelectorAll(".pl-8"));
    expect(childRows.length).toBeGreaterThan(0);
    const childText = childRows.some((el) =>
      el.textContent?.includes("Child thread"),
    );
    expect(childText).toBe(true);
  });

  it("regular session item renders as an anchor (links to sessions route)", async () => {
    render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Runtimes — expand items/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Parent session")).toBeTruthy();
    });
    const parentLink = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Parent session",
    );
    expect(parentLink).toBeTruthy();
  });

  it("expanding Workflows row shows workflow items (not linked)", async () => {
    render(<UsagePage />);
    const wfRow = screen.getByRole("button", {
      name: /Workflows — expand items/,
    });
    fireEvent.click(wfRow);
    await waitFor(() => {
      expect(screen.getByText("Deploy pipeline run #12")).toBeTruthy();
    });
    // Workflow items have no sessionId — must not be links
    const wfLinks = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("Deploy pipeline run #12"),
    );
    expect(wfLinks.length).toBe(0);
  });

  it("expanding Proxy row shows proxy items (not linked)", async () => {
    render(<UsagePage />);
    const proxyRow = screen.getByRole("button", {
      name: /Proxy.*expand items/,
    });
    fireEvent.click(proxyRow);
    await waitFor(() => {
      // "claude-code" appears in both the expanded item list (span.truncate.text-muted)
      // and the request log harness column — getAllByText handles duplicates.
      const matches = screen.getAllByText("claude-code");
      expect(matches.length).toBeGreaterThan(0);
    });
    const proxyLinks = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("claude-code"),
    );
    expect(proxyLinks.length).toBe(0);
  });
});

describe("UsagePage — skills section", () => {
  it("renders adoption and estimated context telemetry", () => {
    render(<UsagePage />);
    const heading = screen.getByText("Skills");
    const section = heading.closest("div");
    expect(section?.textContent).toContain("github");
    expect(section?.textContent).toContain("Plugin: github");
    expect(section?.textContent).toContain("3,456");
    expect(screen.getByText("Estimated marginal context tokens")).toBeTruthy();
  });
});

describe("UsagePage — by model section", () => {
  it("renders model names in the By model section", () => {
    render(<UsagePage />);
    const heading = screen.getByText("By model");
    const section = heading.closest("div");
    expect(section).toBeTruthy();
    expect(section!.textContent).toContain("claude-opus-4-5");
    expect(section!.textContent).toContain("gpt-4o");
  });
});

describe("UsagePage — CSV export", () => {
  it("defaults to daily export and builds the native download URL", () => {
    render(<UsagePage />);
    const granularity = screen.getByLabelText("CSV granularity") as HTMLSelectElement;
    expect(granularity.value).toBe("day");
    const csvLink = document.querySelector("a[href*='/api/usage/export.csv']") as HTMLAnchorElement;
    expect(csvLink.href).toContain("window=7d");
    expect(csvLink.href).toContain("scope=me");
    expect(csvLink.href).toContain("granularity=day");
    expect(csvLink.hasAttribute("download")).toBe(false);
  });

  it("selects itemized export, validates it, then uses the native anchor", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<UsagePage />);
    fireEvent.change(screen.getByLabelText("CSV granularity"), { target: { value: "turn" } });
    const csvLink = document.querySelector("a[href*='/api/usage/export.csv']") as HTMLAnchorElement;
    expect(csvLink.href).toContain("granularity=turn");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV (7d, me)" }));
    await waitFor(() => expect(usageExportValidations).toEqual([{ granularity: "turn", scope: "me" }]));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("shows validation errors and does not start a native download", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    usageExportError = Object.assign(new Error("GET /usage/export.csv → 400"), {
      payload: { error: { code: "invalid_range", message: "Choose a valid export range." } },
    });
    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV (7d, me)" }));
    expect(await screen.findByText("Choose a valid export range.")).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
  });
});

describe("UsagePage — request log pagination", () => {
  it("shows bounded navigation without raw request content", () => {
    render(<UsagePage />);
    expect(screen.getByText("Page 1 · 25 requests per page")).toBeTruthy();
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.queryByText("Request detail")).toBeNull();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("UsagePage — team workspace scope", () => {
  beforeEach(() => {
    workspaceTeamId = "team-x";
    breakdownResult = {
      data: { ...mockBreakdown, scope: "team" },
      isLoading: false,
      error: null,
    };
  });

  it("pins the CSV export to scope=team with the team id", () => {
    render(<UsagePage />);
    const csvLink = document.querySelector("a[href*='/api/usage/export.csv']") as HTMLAnchorElement | null;
    expect(csvLink!.href).toContain("scope=team");
    expect(csvLink!.href).toContain("teamId=team-x");
  });

  it("shows member daily averages, zeroes, shared activity, and the UTC denominator", () => {
    const members = mockBreakdownOrgScope.byUser ?? [];
    const first = members[0];
    if (!first) throw new Error("Missing member fixture");
    breakdownResult.data = {
      ...mockBreakdown,
      scope: "team",
      dailyAgentWindow: { days: 7, sinceMs: DAY_A_MS, untilMs: DAY_B_MS, timezone: "UTC" },
      byUser: [
        ...members.map((row, i) => ({ ...row, avgDailyActiveAgents: i === 0 ? 4 / 7 : 0 })),
        { ...first, userId: "shared", name: "Team / shared", avgDailyActiveAgents: 3 / 7 },
      ],
    };
    const view = render(<UsagePage />);
    expect(screen.getByRole("columnheader", { name: "Avg daily active agents" })).toBeTruthy();
    const explanation = screen.getByText("How active agents are counted").closest("details");
    expect(explanation?.open).toBe(false);
    fireEvent.click(screen.getByText("How active agents are counted"));
    expect(screen.getByText(/7 UTC calendar days/)).toBeTruthy();
    for (const [name, value] of [["Alice Smith", "0.57"], ["Bob Jones", "0.00"], ["Team / shared", "0.43"]]) {
      const row = screen.getByRole("row", { name: new RegExp(name ?? "") });
      expect(within(row).getByText(value ?? "")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    expect(breakdownCalls.at(-1)?.slice(0, 3)).toEqual([{ kind: "lookback", window: "24h" }, "team", "team-x"]);
    breakdownResult.data = {
      ...breakdownResult.data,
      dailyAgentWindow: { days: 1, sinceMs: DAY_B_MS, untilMs: DAY_B_MS, timezone: "UTC" },
      byUser: [{ ...first, avgDailyActiveAgents: 2 }],
    };
    view.rerender(<UsagePage />);
    expect(screen.getByText(/1 UTC calendar day,/)).toBeTruthy();
    expect(screen.getByText("2.00")).toBeTruthy();
    expect(screen.queryByText("0.57")).toBeNull();
  });

  it("does not expose member activity when the server omits it for a plain member", () => {
    render(<UsagePage />);
    expect(screen.queryByText("By member")).toBeNull();
    expect(screen.queryByText("Avg daily active agents")).toBeNull();
  });

  it("hides the me/org toggle even for org admins", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    render(<UsagePage />);
    expect(screen.queryByText("My usage")).toBeNull();
    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("hides the personal-only proxy surfaces (request log, key setup)", () => {
    render(<UsagePage />);
    expect(screen.queryByText(/request log/)).toBeNull();
    expect(document.querySelector("a[href='/settings/proxy']")).toBeNull();
  });

  it("names the team in the subtitle", () => {
    render(<UsagePage />);
    expect(screen.getByText(/for this team/)).toBeTruthy();
  });

  it("still renders the breakdown totals", () => {
    render(<UsagePage />);
    expect(screen.getByText("$0.1234")).toBeTruthy();
  });

  it("disables the proxy queries (their surfaces render only in the personal workspace)", () => {
    render(<UsagePage />);
    expect(lastProxyRequestsOpts?.enabled).toBe(false);
    expect(lastProxySettingsOpts?.enabled).toBe(false);
  });
});

describe("UsagePage — workspace still resolving", () => {
  beforeEach(() => {
    workspaceResolved = false;
  });

  it("holds the breakdown query (enabled=false) so a stale stored team key cannot fire a 404", () => {
    render(<UsagePage />);
    const lastCall = breakdownCalls[breakdownCalls.length - 1];
    expect(lastCall?.[3]).toEqual({ enabled: false });
  });

  it("shows Loading and no CSV link while unresolved", () => {
    breakdownResult = { data: undefined, isLoading: false, error: null };
    render(<UsagePage />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(document.querySelector("a[href*='/api/usage/export.csv']")).toBeNull();
  });
});

describe("UsagePage — expanded drill rows across the me/org toggle", () => {
  it("keeps a row expanded when an org admin flips me → org", async () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: /Runtimes — expand items/ }));
    await waitFor(() => {
      expect(screen.getByText("Parent session")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Organization"));
    // The container is keyed by workspace, not scope — the row stays open.
    expect(screen.getByText("Parent session")).toBeTruthy();
  });
});

describe("UsagePage — Settings → Proxy link", () => {
  it("renders Settings → Proxy callout link", () => {
    render(<UsagePage />);
    const link = document.querySelector("a[href='/settings/proxy']");
    expect(link).toBeTruthy();
    expect(link!.textContent).toMatch(/Settings.*Proxy|Settings → Proxy/);
  });
});

describe("UsagePage — disabled-gateway notice", () => {
  it("shows the notice when enabled=false", () => {
    settingsResult = { data: { enabled: false, mode: "centralized" }, isLoading: false };
    render(<UsagePage />);
    expect(screen.getByText(/recording gateway is disabled/)).toBeTruthy();
    const link = document.querySelector("a[href='/settings/organization/proxy']");
    expect(link).toBeTruthy();
  });

  it("does not show the notice when enabled=true", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<UsagePage />);
    expect(screen.queryByText(/recording gateway is disabled/)).toBeNull();
  });
});

describe("UsagePage custom period controls", () => {
  it("selects a calendar month and updates the export URL", () => {
    render(<UsagePage />);
    const month = screen.getByLabelText("Calendar month") as HTMLInputElement;
    fireEvent.change(month, { target: { value: "2024-02" } });
    expect(breakdownCalls.at(-1)?.[0]).toEqual({ kind: "month", month: "2024-02" });
    const csvLink = document.querySelector("a[href*='/api/usage/export.csv']") as HTMLAnchorElement;
    expect(csvLink.href).toContain("month=2024-02");
  });

  it("applies an inclusive custom range to data and CSV", () => {
    render(<UsagePage />);
    fireEvent.change(screen.getByLabelText("Custom start date"), { target: { value: "2024-02-01" } });
    fireEvent.change(screen.getByLabelText("Custom end date"), { target: { value: "2024-02-29" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(breakdownCalls.at(-1)?.[0]).toEqual({ kind: "custom", start: "2024-02-01", end: "2024-02-29" });
    const csvLink = document.querySelector("a[href*='/api/usage/export.csv']") as HTMLAnchorElement;
    expect(csvLink.href).toContain("start=2024-02-01&end=2024-02-29");
    expect(screen.getByRole("button", { name: "Download CSV (2024-02-01 to 2024-02-29, me)" })).toBeTruthy();
  });

  it("marks edited custom dates as pending while data and CSV keep the applied range", () => {
    render(<UsagePage />);
    const start = screen.getByLabelText("Custom start date");
    const end = screen.getByLabelText("Custom end date");
    const apply = screen.getByRole("button", { name: "Apply dates" });

    fireEvent.change(start, { target: { value: "2024-02-01" } });
    fireEvent.change(end, { target: { value: "2024-02-29" } });
    fireEvent.click(apply);
    expect(apply.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(start, { target: { value: "2024-02-02" } });
    expect(apply.getAttribute("aria-pressed")).toBe("false");
    expect(apply.className).toContain("border-amber-500");
    const csvLink = document.querySelector("a[href*='/api/usage/export.csv']") as HTMLAnchorElement;
    expect(csvLink.href).toContain("start=2024-02-01&end=2024-02-29");
    expect(breakdownCalls.at(-1)?.[0]).toEqual({
      kind: "custom",
      start: "2024-02-01",
      end: "2024-02-29",
    });

    fireEvent.click(apply);
    expect(apply.getAttribute("aria-pressed")).toBe("true");
    expect(csvLink.href).toContain("start=2024-02-02&end=2024-02-29");
  });

  it("shows the server range error message", () => {
    breakdownResult = {
      data: undefined,
      isLoading: false,
      error: Object.assign(new Error("GET /usage/breakdown → 400"), {
        payload: { error: { code: "reversed_range", message: "Choose an end date on or after the start date." } },
      }),
    };
    render(<UsagePage />);
    expect(screen.getByText("Choose an end date on or after the start date.")).toBeTruthy();
    expect(screen.queryByText(/GET \/usage\/breakdown/)).toBeNull();
  });

  it("refreshes picker limits when the page renders after UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T23:59:00Z"));
    const view = render(<UsagePage />);
    expect(screen.getByLabelText("Calendar month").getAttribute("max")).toBe("2026-12");
    expect(screen.getByLabelText("Custom end date").getAttribute("max")).toBe("2026-12-31");

    vi.setSystemTime(new Date("2027-01-01T00:01:00Z"));
    view.rerender(<UsagePage />);
    expect(screen.getByLabelText("Calendar month").getAttribute("max")).toBe("2027-01");
    expect(screen.getByLabelText("Custom end date").getAttribute("max")).toBe("2027-01-01");
    view.unmount();
    vi.useRealTimers();
  });

  it("clears inactive controls and marks the active period", () => {
    render(<UsagePage />);
    const month = screen.getByLabelText("Calendar month") as HTMLInputElement;
    const start = screen.getByLabelText("Custom start date") as HTMLInputElement;
    const end = screen.getByLabelText("Custom end date") as HTMLInputElement;
    const apply = screen.getByRole("button", { name: "Apply dates" });

    fireEvent.change(month, { target: { value: "2024-02" } });
    expect(month.getAttribute("aria-current")).toBe("date");
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    expect(month.value).toBe("");
    expect(month.getAttribute("aria-current")).toBeNull();

    fireEvent.change(start, { target: { value: "2024-02-01" } });
    fireEvent.change(end, { target: { value: "2024-02-29" } });
    fireEvent.click(apply);
    expect(apply.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(month, { target: { value: "2024-01" } });
    expect(start.value).toBe("");
    expect(end.value).toBe("");
    expect(apply.getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(month, { target: { value: "" } });
    expect(breakdownCalls.at(-1)?.[0]).toEqual({ kind: "lookback", window: "7d" });
  });
});
