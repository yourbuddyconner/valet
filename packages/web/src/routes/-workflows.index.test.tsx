// @vitest-environment jsdom
/**
 * `/workflows` definitions list (plan decision 11): each row's name links
 * to `/workflows/$workflowId` (the editor), Run starts a run and navigates
 * to the run detail page, and "New workflow" opens `NewWorkflowDialog`
 * (review fix 1), which POSTs the entered name + a minimal trigger→stop
 * definition then navigates to its editor page. `<Link>`/`useNavigate` need
 * router context — mocked the same way `thread-tree-new-thread.test.tsx`
 * does, since this suite only cares that navigation was requested, not
 * that the router actually resolved it.
 *
 * The team row's `AssistantBadge` carries a tooltip, which Radix refuses to
 * render outside a provider, so the page renders inside one here — the same
 * wrapper `session-header.test.tsx` uses.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { api } from "~/api/client";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ListAllWorkflowRunsResponse,
  ListWorkflowActionRequiredResponse,
  WorkflowDefinitionSummary,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "~/components/primitives";

// Annotated rather than inferred: the empty-list case reassigns `workflows`
// to `[]`, which an inferred tuple would reject. The wire type stands in for
// a hand-listed shape so a new field cannot drift out of this fixture.
const workflowsData: { workflows: WorkflowDefinitionSummary[] } = {
  workflows: [
    {
      id: "wf_1",
      name: "Deploy pipeline",
      // Pins an assistant, which is what the row badges. `wf_2` pins none,
      // so the two rows cover both halves of the resolution rule.
      definition: { version: "dag/v1", assistantId: "asst_scribe", nodes: [], edges: [] },
      createdAt: 1,
      updatedAt: 1,
      ownerType: "user",
      ownerId: "u1",
    },
    {
      id: "wf_2",
      name: "Nightly digest",
      definition: {},
      createdAt: 2,
      updatedAt: 2,
      ownerType: "team",
      ownerId: "team_1",
      origin: "repo",
      upstream: {
        repoFullName: "tkhq/automation",
        ref: "release/v2",
        path: ".valet/workflows/nightly.yaml",
      },
    },
  ],
};

const teamsData = {
  teams: [
    {
      id: "team_1",
      orgId: "org_1",
      name: "Platform",
      createdAt: 1,
      memberCount: 2,
      callerRole: "admin" as const,
    },
  ],
};

const triggersData = {
  triggers: [
    {
      kind: "schedule" as const,
      id: "sched_1",
      workflowId: "wf_1",
      name: "Nightly build",
      enabled: true,
      detail: {
        cron: "0 2 * * *",
        timezone: "UTC",
        targetKind: "workflow" as const,
        nextFireAt: Date.now() + 86400000,
        lastFiredAt: null,
      },
    },
  ],
};

const runsQuery = vi.fn();
const allRunsData: ListAllWorkflowRunsResponse = {
  nextCursor: "cursor_2",
  runs: [
    {
      runId: "wfrun_1",
      workflowId: "wf_1",
      workflowName: "Deploy pipeline",
      status: "settled" as const,
      outcome: "completed" as const,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    },
  ],
};

const actionRequiredData: ListWorkflowActionRequiredResponse = {
  count: 2,
  items: [
    {
      id: "wfrun_approval:review:0",
      runId: "wfrun_approval",
      workflowId: "wf_1",
      workflowName: "Deploy pipeline",
      runCreatedAt: Date.now() - 20_000,
      owner: { type: "user", id: "u-1" },
      // The run's snapshot, which is NOT what `wf_1` pins today. The row
      // must badge the assistant the parked run actually executes as.
      trigger: { type: "manual" },
      gate: {
        nodeId: "review",
        kind: "approval",
        prompt: "Ship this release?",
        waitingSince: Date.now() - 10_000,
      },
    },
    {
      id: "wfrun_policy:send:0",
      runId: "wfrun_policy",
      workflowId: "wf_2",
      workflowName: "Nightly digest",
      runCreatedAt: Date.now() - 15_000,
      owner: { type: "team", id: "team_1" },
      trigger: { type: "schedule", triggerId: "sched_1" },
      gate: {
        nodeId: "send",
        kind: "policy_gate",
        service: "slack",
        action: "send_message",
        provenance: "org_policy",
        riskLevel: "high",
        gateParams: { channel: "#ops" },
        onDeny: "skip",
        waitingSince: Date.now() - 5_000,
      },
    },
  ],
};

let searchState: Record<string, unknown> = {};

const navigate = vi.fn();
const startMutateAsync = vi.fn().mockResolvedValue({ runId: "wfrun_new" });
const deleteMutateAsync = vi.fn().mockResolvedValue(undefined);
const resolveMutate = vi.fn();
const createMutateAsync = vi.fn().mockResolvedValue({
  id: "wf_new",
  name: "My new workflow",
  definition: { version: "dag/v1", nodes: [], edges: [] },
  createdAt: 1,
  updatedAt: 1,
});

vi.mock("@tanstack/react-router", () => ({
  // `params` is serialized onto the stub so a case can read the row a link
  // navigates to, not only its route pattern.
  Link: ({
    children,
    params,
    ...rest
  }: {
    children: ReactNode;
    params?: unknown;
    [key: string]: unknown;
  }) => (
    <a data-params={JSON.stringify(params)} data-search={JSON.stringify(rest.search)} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  // One `useSearch` serves both readers: the hub reads `?tab=`, and the
  // workspace scope reads `?assistant=` so an open assistant can override the
  // stored workspace. This page is never rendered with an assistant, so
  // `searchState` only ever carries the tab.
  useSearch: () => searchState,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/components/layout/workspace-assistant", () => ({ useWorkspaceAssistant: () => ({ open: vi.fn(), close: vi.fn(), isOpen: false }) }));

vi.mock("~/components/session/composer", () => ({ Composer: () => <textarea aria-label="Workflow request" /> }));

vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
  useModelTiers: () => ({ data: { xs: [], s: [], m: [], l: [], xl: [] }, isLoading: false, error: null }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({
    data: { features: { organizations: true } },
    isLoading: false,
    error: null,
  }),
  // `useListOwner` reads the caller's own id to address the personal
  // workspace: the workspace switcher holds a routing key, not a principal.
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
}));

// The badge links by assistant id, so it reads the assistants list to find
// the team's default one.

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useWorkflowActionRequired: () => ({
    data: actionRequiredData,
    isLoading: false,
    error: null,
  }),
  useResolveApproval: () => ({
    mutate: resolveMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useWorkflowRuns: () => ({ data: { runs: [] }, isLoading: false }),
  useStartRun: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useCreateWorkflow: () => ({
    mutateAsync: createMutateAsync,
    isPending: false,
    error: null,
  }),
  useDeleteWorkflow: () => ({
    mutateAsync: deleteMutateAsync,
    isPending: false,
  }),
  useWorkflowTriggers: () => ({
    data: triggersData,
    isLoading: false,
    error: null,
  }),
  useAllWorkflowRuns: (...args: unknown[]) => {
    runsQuery(...args);
    return { data: { ...allRunsData }, isLoading: false, error: null };
  },
  useUpdateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunScheduleNow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTriggerCatalog: () => ({
    data: { catalog: [] },
    isLoading: false,
    error: null,
  }),
  useCreateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The gallery has its own suite; here it only has to be identifiable, so the
// page's placement rule can be asserted without a second templates fixture.
vi.mock("~/components/workflows/template-gallery", () => ({
  TemplateGallery: () => <div data-testid="template-gallery" />,
}));

import { PERSONAL, WorkspaceScopeProvider, useWorkspaceScope } from "~/lib/workspace-scope";
import { WorkflowsIndexPage } from "./workflows.index";
import { WorkflowApprovalItem } from "~/components/workflows/workflow-approval-item";

/** `workspace` selects the workspace the page is being read in — what the
 * nav's switcher sets. Seeded through localStorage, which is where the real
 * scope lives. */
function SwitchWorkspace() {
  const scope = useWorkspaceScope();
  return <button onClick={() => scope.setKey("team_1")}>Switch workspace</button>;
}

function renderPage(workspace = PERSONAL) {
  window.localStorage.setItem("valet:workspace", workspace);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <SwitchWorkspace />
        <WorkflowsIndexPage />
      </WorkspaceScopeProvider>
    </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderApprovals(focusRun?: string) {
  return render(<TooltipProvider><WorkspaceScopeProvider><ul>{actionRequiredData.items.map(item =>
    <WorkflowApprovalItem key={item.id} item={item} focused={item.runId === focusRun} />
  )}</ul></WorkspaceScopeProvider></TooltipProvider>);
}

const populated = [...workflowsData.workflows];

beforeEach(() => {
  workflowsData.workflows = structuredClone(populated);
  searchState = {};
  navigate.mockClear();
  createMutateAsync.mockClear();
  deleteMutateAsync.mockClear();
  resolveMutate.mockClear();
});

describe("WorkflowsIndexPage", () => {
  it("renders each workflow definition's name as a link to its editor page", () => {
    renderPage();
    const link = screen.getByText("Deploy pipeline").closest("a");
    expect(link?.getAttribute("href") ?? link?.getAttribute("to")).toBeTruthy();
    expect(screen.getByText("Nightly digest")).toBeTruthy();
  });

  it("starts a run and navigates to the run detail page when Run is clicked", async () => {
    renderPage();
    const runButtons = screen.getAllByRole("button", { name: "Run" });
    fireEvent.click(runButtons[0]);

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/runs/$runId",
        params: { runId: "wfrun_new" },
      }),
    );
  });

  it("runs immediately, with no dialog, when the trigger's only field is hidden", async () => {
    // github.pull-request-review and github.assign-reviewers, once
    // installed, declare exactly one trigger field: a hidden webhook
    // payload nobody types. Run must not open a dialog asking for it.
    workflowsData.workflows = [
      {
        id: "wf_event_only",
        name: "Review a pull request when a comment asks for it",
        definition: {
          version: "dag/v1",
          nodes: [
            {
              id: "start",
              type: "trigger",
              dataSchema: { payload: { type: "object", hidden: true } },
            },
          ],
          edges: [],
        },
        createdAt: 1,
        updatedAt: 1,
        ownerType: "user",
        ownerId: "u1",
      },
    ];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    expect(screen.queryByText("payload")).toBeNull();
    expect(screen.queryByText(/This workflow's trigger declares inputs/)).toBeNull();
  });

  it("opens the New workflow dialog, defaults the name field, and posts the entered name on Create", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Workflow options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Manual setup" }));

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("Untitled workflow");
    fireEvent.change(nameInput, { target: { value: "My new workflow" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const call = createMutateAsync.mock.calls[0]![0] as {
      name: string;
      definition: {
        nodes: Array<{ id: string; type: string }>;
        edges: Array<{ from: string; to: string }>;
      };
    };
    expect(call.name).toBe("My new workflow");
    expect(call.definition.nodes.map((n) => n.type)).toEqual(["trigger", "stop"]);
    expect(call.definition.edges).toEqual([{ from: "trigger", to: "stop" }]);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_new" },
      }),
    );
  });

  it("asks in-page before deleting a workflow, and only deletes once confirmed", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Delete Deploy pipeline"));
    expect(deleteMutateAsync).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Settled run history is kept/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workflow" }));

    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith("wf_1"));
  });

  it("shows the Workflows tab by default with per-workflow trigger badges", () => {
    renderPage();
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.getByLabelText(/1 schedule/)).toBeTruthy();
  });

  it("removes the separate approval tab", () => {
    renderPage();
    expect(screen.queryByRole("tab", { name: /Needs your approval/ })).toBeNull();
  });

  it("shows both gate classes in the shared approval cards", () => {
    renderApprovals();

    expect(screen.getByText("Workflow approval")).toBeTruthy();
    expect(screen.getByText("Tool permission")).toBeTruthy();
    const approvalRow = screen.getAllByTestId("action-required-item")[0];
    const details = approvalRow.querySelector("details");
    expect(details?.open).toBe(false);
    expect(within(approvalRow).getByText("Ship this release?", { selector: "summary *" })).toBeTruthy();
    expect(screen.getAllByText("slack.send_message").length).toBeGreaterThan(0);
    expect(screen.getByText("Started by schedule (sched_1)")).toBeTruthy();
  });

  it("stacks action details at a narrow viewport without a minimum page width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    renderApprovals();
    const row = screen.getAllByTestId("action-required-item")[0];
    expect(row.className).toContain("min-w-0");
    expect(row.querySelector(".flex-col")).toBeTruthy();
  });

  it("uses the notification search target to focus one gate", () => {
    renderApprovals("wfrun_policy");
    const rows = screen.getAllByTestId("action-required-item");
    expect(rows[0].className).not.toContain("ring-2");
    expect(rows[1].className).toContain("ring-2");
  });

  it("confirms an explicit approval before it resolves", () => {
    renderApprovals();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    expect(resolveMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve step" }));
    expect(resolveMutate).toHaveBeenCalledWith({
      nodeId: "review",
      body: { approved: true, note: undefined, iteration: undefined },
    });
  });

  it("badges a mirrored workflow with its repository path", () => {
    renderPage();
    expect(screen.getByText("tkhq/automation:.valet/workflows/nightly.yaml")).toBeTruthy();
    expect(screen.queryByLabelText("Delete Nightly digest")).toBeNull();
  });

  it("renders the Scheduled tab", () => {
    searchState = { tab: "scheduled" };
    renderPage();
    expect(screen.getByText("Nightly build")).toBeTruthy();
  });

  it("tab buttons navigate via search params", () => {
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Scheduled/ }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { tab: "scheduled" } }));
  });

  it("shows only Workflows and Scheduled tabs", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual(["Workflows", "Scheduled"]);
    expect(screen.queryByTestId("template-gallery")).toBeNull();
  });

  it("offers the workflow composer without templates when the list is empty", async () => {
    vi.spyOn(api, "ensureWorkspaceRuntime").mockResolvedValue({ sessionId: "workspace-runtime" });
    workflowsData.workflows = [];
    renderPage();
    expect(screen.queryByTestId("template-gallery")).toBeNull();
    expect(await screen.findByText("What would you like to automate?")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Workflow request" })).toBeTruthy();
    expect(api.ensureWorkspaceRuntime).toHaveBeenCalledWith("user");
  });

  it("links the workflow directly to its latest failed run", () => {
    workflowsData.workflows[0].latestFailedRun = { runId: "failed_1", failedAt: 1 };
    renderPage();
    expect(screen.getByText("View latest failed run").getAttribute("data-params")).toBe(JSON.stringify({ runId: "failed_1" }));
  });

});

describe("WorkflowsIndexPage — team ownership", () => {
  // The badge opens the assistant that runs the workflow, not a chat with
  // the team. A team row running on the team's unnamed default still reads
  // as the team, which is the name this list showed before.
  it("badges a team-owned workflow with its assistant, linked to the assistant editor", () => {
    renderPage();
    const link = screen.getByText("Platform").closest("a");
    expect(link?.getAttribute("to")).toBe("/chat");
    expect(JSON.parse(link?.getAttribute("data-search") ?? "null")).toEqual({
      workspace: "team_1",
    });
  });

  it("creates the workflow in the workspace being read, with no second question", async () => {
    // The dialog had an Owner select. It repeated the nav's workspace
    // switcher and could contradict it, so the list could show one
    // workspace while Create filed the new workflow under another.
    renderPage("team_1");
    await userEvent.click(screen.getByRole("button", { name: "Workflow options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Manual setup" }));

    expect(screen.queryByLabelText("Owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const call = createMutateAsync.mock.calls.at(-1)![0] as {
      teamId?: string;
      definition: { assistantId: string };
    };
    expect(call.teamId).toBe("team_1");
    expect(call.definition.assistantId).toBeUndefined();
  });

  it("sends no teamId in your own workspace", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Workflow options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Manual setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const call = createMutateAsync.mock.calls.at(-1)![0] as {
      teamId?: string;
      definition: { assistantId: string };
    };
    expect(call.teamId).toBeUndefined();
    expect(call.definition.assistantId).toBeUndefined();
  });
});
