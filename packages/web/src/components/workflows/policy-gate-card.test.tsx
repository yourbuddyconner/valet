// @vitest-environment jsdom
/**
 * PolicyGateCard tests (plan decision 19 — policy gate approval with scopes).
 * The component is tested with mocked hooks so no real HTTP fires.
 * vi.mock is hoisted, so all factory functions must be synchronous.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowPendingGate } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { PolicyGateCard } from "./policy-gate-card";

// ── shared mock state ───────────────────────────────────────────────────────

const mutate = vi.fn();
let mockOrgRole: string | undefined = "member";
let mockIsError = false;
let mockError: ApiError | null = null;

vi.mock("~/api/workflows", () => ({
  useResolveApproval: () => ({
    mutate,
    isPending: false,
    isError: mockIsError,
    error: mockError,
  }),
  qkWorkflows: { run: (id: string) => ["workflows", "runs", id] },
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: mockOrgRole != null ? { orgRole: mockOrgRole } : undefined }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGate(overrides: Partial<WorkflowPendingGate> = {}): WorkflowPendingGate {
  return {
    nodeId: "node_1",
    kind: "policy_gate",
    service: "linear",
    action: "save_issue",
    riskLevel: "high",
    provenance: "plugin_default",
    onDeny: "fail",
    ...overrides,
  };
}

describe("PolicyGateCard", () => {
  beforeEach(() => {
    mutate.mockClear();
    mockOrgRole = "member";
    mockIsError = false;
    mockError = null;
  });

  // ── Case 1: structure ──────────────────────────────────────────────────────

  it("renders service.action in mono, risk badge, and params details section", () => {
    const gate = makeGate({ gateParams: { title: "Fix bug" }, gateParamsTruncated: false });
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    expect(screen.getByText("linear.save_issue")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText(/Parameters/i)).toBeTruthy();
  });

  it("shows truncation notice when gateParamsTruncated is true", () => {
    const gate = makeGate({ gateParams: { x: 1 }, gateParamsTruncated: true });
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);
    expect(screen.getByText(/truncated/i)).toBeTruthy();
  });

  // ── Case 2: Approve once ───────────────────────────────────────────────────

  it("Approve once fires with scope=once and the gate iteration", () => {
    const gate = makeGate({ iteration: 3 });
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));

    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: true, scope: "once", note: undefined, iteration: 3 },
    });
  });

  // ── Case 3: Approve for rest of run ───────────────────────────────────────

  it("Approve for rest of run fires with scope=run and sublabel names the action", async () => {
    const user = userEvent.setup();
    const gate = makeGate();
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    // Open the dropdown first
    await user.click(screen.getByRole("button", { name: "More approval options" }));

    expect(
      screen.getByText(/Covers every later call to linear\.save_issue in this run/i),
    ).toBeTruthy();

    await user.click(screen.getByRole("menuitem", { name: /Approve for rest of run/i }));

    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: true, scope: "run", note: undefined, iteration: undefined },
    });
  });

  it("confirms a persistent permission confined to this workflow", async () => {
    const user = userEvent.setup();
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    await user.click(screen.getByRole("button", { name: "Allow for this workflow" }));
    expect(screen.getByText(/future runs of this workflow only/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Allow action" }));
    expect(mutate).toHaveBeenCalledWith({ nodeId: "node_1", body: { approved: true, scope: "workflow", note: undefined, iteration: undefined } });
    expect(screen.queryByText("Always allow")).toBeNull();
  });

  // ── Case 5: Deny microcopy ────────────────────────────────────────────────

  it("Deny button shows fail microcopy when onDeny=fail", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate({ onDeny: "fail" })} />);
    expect(screen.getByText(/Denying fails this node/i)).toBeTruthy();
  });

  it("Deny button shows skip microcopy when onDeny=skip", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate({ onDeny: "skip" })} />);
    expect(screen.getByText(/Denying skips this node/i)).toBeTruthy();
  });

  it("Deny fires approved:false", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    fireEvent.click(screen.getByRole("button", { name: /Deny/i }));
    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: false, scope: "once", note: undefined, iteration: undefined },
    });
  });

  // ── Case 6: mutation errors ───────────────────────────────────────────────

  it("shows already-resolved banner on 409 ApiError (detected by status, not message text)", () => {
    mockIsError = true;
    // The server returns { error: "this approval gate has already been resolved" }
    // but ApiError.message is "POST … → 409" — the component must detect via status.
    mockError = new ApiError(409, "POST /api/workflows/runs/x/approvals/y → 409", {
      error: "this approval gate has already been resolved",
    });
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    expect(screen.getByText(/This gate was already resolved\. Refreshing/i)).toBeTruthy();
    // The raw "POST … → 409" message must NOT appear in the error area.
    expect(screen.queryByText(/→ 409/)).toBeNull();
  });

  it("shows apiErrorMessage body for non-409 ApiErrors", () => {
    mockIsError = true;
    mockError = new ApiError(500, "POST /api/workflows/runs/x/approvals/y → 500", {
      error: "internal server error",
    });
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    expect(screen.getByText("internal server error")).toBeTruthy();
  });

  it("shows server error fallback for a generic Error", () => {
    mockIsError = true;
    mockError = new ApiError(400, "Something unexpected went wrong.", undefined);
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    // Falls back to err.message since payload has no { error } key.
    expect(screen.getByText("Something unexpected went wrong.")).toBeTruthy();
  });

  // ── Case 7: resolver_error provenance ─────────────────────────────────────

  it("shows resolver_error banner when provenance is resolver_error", () => {
    render(
      <PolicyGateCard runId="wfrun_1" gate={makeGate({ provenance: "resolver_error" })} />,
    );
    expect(
      screen.getByText(/Policy check failed — approval requested as a safe fallback/i),
    ).toBeTruthy();
  });

  // ── Case 8: timeoutAt + iteration ─────────────────────────────────────────

  it("shows timeout text in footer when timeoutAt is set", () => {
    render(
      <PolicyGateCard runId="wfrun_1" gate={makeGate({ timeoutAt: Date.now() + 60_000 })} />,
    );
    expect(screen.getByText(/times out/i)).toBeTruthy();
  });

  it("shows iteration label when gate.iteration is set", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate({ iteration: 4 })} />);
    expect(screen.getByText(/Iteration 4/i)).toBeTruthy();
  });
});
