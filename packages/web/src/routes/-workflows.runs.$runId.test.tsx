// @vitest-environment jsdom
/**
 * `/workflows/runs/$runId` body rendering (plan decision 19): a parked run
 * waiting on an approval signal shows the approval card; a settled run
 * hides the Cancel button. `RunDetailBody` is props-driven (see
 * `workflows.runs.$runId.tsx`) so this renders it directly without router
 * wiring — only `ApprovalCard`/`PolicyGateCard`'s `useResolveApproval` needs
 * mocking.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { WorkflowPendingGate, WorkflowRunDetail } from "@valet/api/wire";
import { RunDetailBody } from "./workflows.runs.$runId";

vi.mock("~/api/workflows", () => ({
  useResolveApproval: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  qkWorkflows: { run: (id: string) => ["workflows", "runs", id] },
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { orgRole: "member" } }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

function baseRun(
  overrides: Partial<WorkflowRunDetail["run"]> = {},
  pendingGates: WorkflowPendingGate[] = [],
): WorkflowRunDetail {
  return {
    run: {
      runId: "wfrun_1",
      workflowId: "wf_1",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      waitingOn: [],
      definition: { version: "dag/v1", nodes: [], edges: [] },
      params: {},
      ...overrides,
    },
    owner: { type: "user", id: "u1" },
    checkpoints: [],
    signals: [],
    pendingGates,
  };
}

/** Router context, needed only by the checkpoint-link case: `Link` reads the
 * router store, and the rest of this file renders `RunDetailBody` bare. */
function renderInRouter(ui: React.ReactElement) {
  const rootRoute = createRootRoute({ component: () => ui });
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId",
    component: () => null,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: () => null,
  });
  const runRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/runs/$runId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sessionRoute, threadRoute, runRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("RunDetailBody", () => {
  it("shows the approval card when a pendingGate of kind approval exists", () => {
    const data = baseRun(
      {
        status: "parked",
        definition: {
          version: "dag/v1",
          nodes: [{ id: "deploy", type: "approval", prompt: "Ship it?" }],
          edges: [],
        },
      },
      [{ nodeId: "deploy", kind: "approval", prompt: "Ship it?" }],
    );
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByText("Ship it?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("shows the legacy approval card when parked on an approval signal (no pendingGates)", () => {
    const data = baseRun({
      status: "parked",
      waitingOn: [{ kind: "signal", nodeId: "deploy", signalType: "approval:deploy" }],
      definition: {
        version: "dag/v1",
        nodes: [{ id: "deploy", type: "approval", prompt: "Ship it?" }],
        edges: [],
      },
    });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByText("Ship it?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("does not show the approval card when parked on a timer", () => {
    const data = baseRun({
      status: "parked",
      waitingOn: [{ kind: "timer", nodeId: "wait1", wakeAt: Date.now() }],
    });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows the Cancel button while the run is non-terminal", () => {
    const data = baseRun({ status: "running" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  it("asks before cancelling, and only cancels once confirmed", async () => {
    const onCancel = vi.fn();
    const data = baseRun({ status: "running" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={onCancel} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(onCancel).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("names the pending action on the run controls rather than only disabling them", () => {
    const { unmount } = render(
      <RunDetailBody
        runId="wfrun_1"
        data={baseRun({ status: "running" })}
        onCancel={vi.fn()}
        cancelPending
        onRetry={vi.fn()}
        retryPending={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeTruthy();
    unmount();

    render(
      <RunDetailBody
        runId="wfrun_1"
        data={baseRun({ status: "settled", outcome: "failed" })}
        onCancel={vi.fn()}
        cancelPending={false}
        onRetry={vi.fn()}
        retryPending
      />,
    );
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeTruthy();
  });

  it("hides the Cancel button once the run has settled", () => {
    const data = baseRun({ status: "settled", outcome: "completed" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("shows the Retry button for a settled failed run and wires the click", () => {
    const onRetry = vi.fn();
    const data = baseRun({ status: "settled", outcome: "failed" });
    render(
      <RunDetailBody
        runId="wfrun_1"
        data={data}
        onCancel={vi.fn()}
        cancelPending={false}
        onRetry={onRetry}
        retryPending={false}
      />,
    );
    const button = screen.getByRole("button", { name: "Retry run" });
    button.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the Retry button for a settled cancelled run", () => {
    const data = baseRun({ status: "settled", outcome: "cancelled" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByRole("button", { name: "Retry run" })).toBeTruthy();
  });

  it("hides the Retry button while the run is non-terminal and when it completed", () => {
    for (const overrides of [
      { status: "running" as const },
      { status: "settled" as const, outcome: "completed" as const },
    ]) {
      const { unmount } = render(
        <RunDetailBody
          runId="wfrun_1"
          data={baseRun(overrides)}
          onCancel={vi.fn()}
          cancelPending={false}
          onRetry={vi.fn()}
          retryPending={false}
        />,
      );
      expect(screen.queryByRole("button", { name: "Retry run" })).toBeNull();
      unmount();
    }
  });

  it("links checkpoints to their thread, legacy runtime, and child run", async () => {
    const data = baseRun({ status: "settled", outcome: "failed" });
    data.checkpoints = [
      {
        nodeId: "ask",
        iteration: 0,
        status: "failed",
        error: "session failed",
        sessionId: "s_abc",
        createdAt: Date.now(),
      },
      { nodeId: "thread-step", iteration: 0, status: "completed", sessionId: "s_abc", threadId: "thread_abc", createdAt: Date.now() },
      { nodeId: "sub", iteration: 0, status: "completed", childRunId: "wfrun_sub_1", createdAt: Date.now() },
      { nodeId: "set1", iteration: 0, status: "completed", createdAt: Date.now() },
    ];
    renderInRouter(
      <RunDetailBody
        runId="wfrun_1"
        data={data}
        onCancel={vi.fn()}
        cancelPending={false}
        onRetry={vi.fn()}
        retryPending={false}
      />,
    );
    expect((await screen.findByText("Open runtime")).getAttribute("href")).toBe("/sessions/s_abc");
    expect(screen.getByText("Open thread").getAttribute("href")).toBe("/threads/thread_abc");
    expect(screen.getByText("Open child run").getAttribute("href")).toBe(
      "/workflows/runs/wfrun_sub_1",
    );
    // A checkpoint carrying neither id gets no link row.
    expect(screen.getAllByText("Open runtime")).toHaveLength(1);
  });

  it("renders checkpoints with status and a result preview", () => {
    const data = baseRun({ status: "settled", outcome: "completed" });
    data.checkpoints = [
      { nodeId: "set1", iteration: 0, status: "completed", result: { ok: true }, createdAt: Date.now() },
    ];
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByText("set1")).toBeTruthy();
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });

  it("renders a PolicyGateCard for a policy_gate pending gate", () => {
    const data = baseRun(
      { status: "parked" },
      [
        {
          nodeId: "node_save",
          kind: "policy_gate",
          service: "linear",
          action: "save_issue",
          riskLevel: "high",
          onDeny: "fail",
        },
      ],
    );
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByText("linear.save_issue")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
  });

  it("renders RunStatusChip showing 'Needs approval' when parked with pending gates", () => {
    const data = baseRun(
      { status: "parked" },
      [{ nodeId: "n1", kind: "policy_gate", service: "gh", action: "create_pr", onDeny: "fail" }],
    );
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByText("Needs approval")).toBeTruthy();
  });

  it("puts a settled run's stop message and output above the steps", () => {
    const data = baseRun({
      status: "settled",
      outcome: "completed",
      definition: {
        version: "dag/v1",
        nodes: [{ id: "done", type: "stop" }],
        edges: [],
      },
    });
    data.checkpoints = [
      {
        nodeId: "done",
        iteration: 0,
        status: "completed",
        result: { outcome: "success", message: "Opened 3 issues.", output: { count: 3 } },
        createdAt: Date.now(),
      },
    ];
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);

    const panel = screen.getByRole("region", { name: "Run result" });
    expect(within(panel).getByText("Opened 3 issues.")).toBeTruthy();
    expect(within(panel).getByText(/"count"/)).toBeTruthy();

    // The panel must come before the checkpoint list in document order, so
    // the answer is the first thing on the page.
    const list = screen.getByText("Checkpoints");
    expect(panel.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("promotes a failed run's reason and does not repeat it open in the step row", () => {
    const data = baseRun({
      status: "settled",
      outcome: "failed",
      definition: { version: "dag/v1", nodes: [{ id: "done", type: "stop" }], edges: [] },
    });
    data.checkpoints = [
      {
        nodeId: "done",
        iteration: 0,
        status: "failed",
        error: "The pull request has no reviewer.",
        result: { outcome: "failure", message: "The pull request has no reviewer." },
        createdAt: Date.now(),
      },
    ];
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);

    const panel = screen.getByRole("region", { name: "Run result" });
    expect(within(panel).getByText("Failure reason")).toBeTruthy();
    expect(within(panel).getByText("The pull request has no reviewer.")).toBeTruthy();
    // The step row keeps its result collapsed: the panel already shows it.
    expect(screen.getByText("Result").closest("details")?.open).toBe(false);
  });

  it("shows no result panel while the run is still in flight", () => {
    const data = baseRun({ status: "running" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.queryByRole("region", { name: "Run result" })).toBeNull();
  });

  it("keeps timings subordinate to the result and only claims a duration once settled", () => {
    const running = baseRun({ status: "running", createdAt: 1_000, updatedAt: 5_000 });
    running.checkpoints = [{ nodeId: "a", iteration: 0, status: "completed", createdAt: 2_000 }];
    const { unmount } = render(
      <RunDetailBody runId="wfrun_1" data={running} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />,
    );
    expect(screen.getByText(/1 checkpoint/)).toBeTruthy();
    expect(screen.queryByText(/Ran for/)).toBeNull();
    unmount();

    const settled = baseRun({
      status: "settled",
      outcome: "completed",
      createdAt: 1_000,
      updatedAt: 5_200,
    });
    render(
      <RunDetailBody runId="wfrun_1" data={settled} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />,
    );
    expect(screen.getByText(/Ran for 4\.2s/)).toBeTruthy();
  });

  it("renders 'Denied by' line for a checkpoint with policyDenied=true in the result", () => {
    const data = baseRun({ status: "settled", outcome: "completed" });
    data.checkpoints = [
      {
        nodeId: "act1",
        iteration: 0,
        status: "completed",
        result: { policyDenied: true, resolvedBy: "alice@example.com" },
        createdAt: Date.now(),
      },
    ];
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} onRetry={vi.fn()} retryPending={false} />);
    expect(screen.getByText(/Denied by alice@example\.com/i)).toBeTruthy();
    // Result preview must NOT show the success treatment
    expect(screen.queryByText(/"policyDenied"/)).toBeNull();
  });
});
