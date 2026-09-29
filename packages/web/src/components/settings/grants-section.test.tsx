// @vitest-environment jsdom
/**
 * You · Policies — "My active grants" (action-policies plan, Task 5):
 * renders session- and workflow-scoped grants, and revoke addresses the
 * grant by scope + service/actionId (split from `policyKey`), not by row id
 * — matching `DeleteGrantRequest`'s target-addressing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RuntimeGrantWire } from "@valet/api/wire";

const deleteMutate = vi.fn();
let grantsData: { grants: RuntimeGrantWire[] } = { grants: [] };

vi.mock("~/api/policies", async () => {
  const actual = await vi.importActual<typeof import("~/api/policies")>("~/api/policies");
  return {
    ...actual,
    useMyGrants: () => ({ data: grantsData, isLoading: false, error: null }),
    useDeleteMyGrant: () => ({ mutateAsync: deleteMutate, isPending: false }),
  };
});

import { GrantsSection } from "./grants-section";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMutate.mockResolvedValue({ ok: true });
  grantsData = { grants: [] };
});

describe("GrantsSection", () => {
  it("shows the empty state with no grants", () => {
    render(<GrantsSection />);
    expect(screen.getByText("No active grants.")).toBeTruthy();
  });

  it("renders a session-scoped grant and revokes by scope + split policyKey", async () => {
    const user = userEvent.setup();
    grantsData = {
      grants: [
        {
          id: "grant_1",
          sessionId: "sess_1",
          workflowExecutionId: null,
          policyKey: "gmail.gmail.send_email",
          grantedBy: "u1",
          createdAt: 0,
        },
      ],
    };
    render(<GrantsSection />);

    expect(screen.getByText("runtime sess_1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revoke grant gmail.gmail.send_email" }));

    expect(deleteMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Revoke grant" }));
    expect(deleteMutate).toHaveBeenCalledWith(
      {
        sessionId: "sess_1",
        workflowExecutionId: undefined,
        service: "gmail",
        actionId: "gmail.send_email",
      },
    );
  });

  it("renders a workflow-scoped grant", () => {
    grantsData = {
      grants: [
        {
          id: "grant_2",
          sessionId: null,
          workflowExecutionId: "wfrun_1",
          policyKey: "demo.deploy",
          grantedBy: "u1",
          createdAt: 0,
        },
      ],
    };
    render(<GrantsSection />);
    expect(screen.getByText("workflow run wfrun_1")).toBeTruthy();
  });
});
