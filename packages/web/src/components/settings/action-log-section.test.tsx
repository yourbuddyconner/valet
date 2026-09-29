// @vitest-environment jsdom
/**
 * Organization · Action log (action-policies plan, Task 5): renders rows
 * with both `resolvedMode` (decision) and `status` (execution outcome)
 * shown distinctly, expands a row to reveal params/result, filters reset
 * the cursor stack, and Next/Previous walk the keyset cursor forward-only.
 * Mocks `~/api/policies` and `@tanstack/react-router`'s `Link` the same way
 * `thread-tree-new-thread.test.tsx` stubs `Link` as a plain anchor.
 *
 * The applied filters now come in as a prop from the route, which holds
 * them in the URL, and Apply reports the new set back up. The earlier
 * "Apply filters calls useActionLog with the service filter" test asserted
 * the section's own state instead, which no longer exists: it is replaced
 * by one test per half of that round trip.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionLogEntryWire } from "@valet/api/wire";

const useActionLogMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/api/policies", () => ({
  useActionLog: (...args: unknown[]) => useActionLogMock(...args),
}));

import {
  ActionLogSection,
  parseActionLogSearch,
  type ActionLogSearch,
} from "./action-log-section";

const onFiltersChange = vi.fn();

function renderSection(filters: ActionLogSearch = {}) {
  return render(<ActionLogSection filters={filters} onFiltersChange={onFiltersChange} />);
}

function entry(overrides: Partial<ActionLogEntryWire> = {}): ActionLogEntryWire {
  return {
    invocationId: "inv_1",
    createdAt: 0,
    service: "gmail",
    actionId: "gmail.send_email",
    riskLevel: "medium",
    resolvedMode: "allow",
    baseMode: "allow",
    matchedPolicyId: null,
    matchedGrantId: null,
    matchedOverrideId: null,
    status: "completed",
    sessionId: "sess_1",
    workflowExecutionId: null,
    userId: "u1",
    params: { to: "a@b.com" },
    paramsTruncated: false,
    result: { ok: true },
    resultTruncated: false,
    error: null,
    durationMs: 12,
    startedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionLogMock.mockReturnValue({
    data: { entries: [entry()], nextCursor: null },
    isLoading: false,
    error: null,
  });
});

describe("ActionLogSection — rows", () => {
  it("shows resolvedMode and status as distinct fields, not conflated", () => {
    renderSection();
    expect(screen.getByText("allow", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("status: completed")).toBeTruthy();
  });

  it("links session provenance to the session route", () => {
    renderSection();
    const link = screen.getByRole("link", { name: "runtime" });
    expect(link.getAttribute("to")).toBe("/sessions/$sessionId");
  });

  it("keeps the provenance links out of the toggle button", () => {
    // A link inside a button is invalid, and one click would both navigate
    // and expand the row.
    renderSection();
    const toggle = screen.getByRole("button", { name: "Toggle details for inv_1" });
    expect(toggle.querySelector("a")).toBeNull();
  });

  it("expanding a row reveals params and result JSON", async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.queryByText(/"to": "a@b.com"/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Toggle details for inv_1" }));
    expect(screen.getByText(/"to": "a@b.com"/)).toBeTruthy();
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });

  it("shows the empty state when there are no entries", () => {
    useActionLogMock.mockReturnValue({ data: { entries: [], nextCursor: null }, isLoading: false, error: null });
    renderSection();
    expect(screen.getByText("No invocations match these filters.")).toBeTruthy();
  });
});

describe("ActionLogSection — filters", () => {
  it("Apply filters reports the drafted filter set to the route", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText("Service"), "gmail");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(onFiltersChange).toHaveBeenCalledWith({
      service: "gmail",
      resolvedMode: undefined,
      status: undefined,
    });
  });

  it("reads the applied filters from the prop, and seeds the controls with them", () => {
    renderSection({ service: "gmail", resolvedMode: "deny" });

    const lastCall = useActionLogMock.mock.calls[useActionLogMock.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({ service: "gmail", resolvedMode: "deny" });
    expect((screen.getByLabelText("Service") as HTMLInputElement).value).toBe("gmail");
    expect((screen.getByLabelText("Resolved mode") as HTMLSelectElement).value).toBe("deny");
  });

  it("Apply filters resets the pager to the first page", async () => {
    const user = userEvent.setup();
    useActionLogMock.mockReturnValue({
      data: { entries: [entry()], nextCursor: "cursor_abc" },
      isLoading: false,
      error: null,
    });
    renderSection();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    const lastCall = useActionLogMock.mock.calls[useActionLogMock.mock.calls.length - 1];
    expect(lastCall[1]).toBeUndefined();
  });
});

describe("parseActionLogSearch", () => {
  it("keeps known values and drops the rest", () => {
    expect(
      parseActionLogSearch({ service: " gmail ", resolvedMode: "deny", status: "completed" }),
    ).toEqual({ service: "gmail", resolvedMode: "deny", status: "completed" });
  });

  it("drops an unknown mode or status instead of filtering on it", () => {
    expect(parseActionLogSearch({ resolvedMode: "sometimes", status: 7, service: "" })).toEqual({
      service: undefined,
      resolvedMode: undefined,
      status: undefined,
    });
  });
});

describe("ActionLogSection — pagination", () => {
  it("Next advances the cursor to nextCursor from the response", async () => {
    const user = userEvent.setup();
    useActionLogMock.mockReturnValue({
      data: { entries: [entry()], nextCursor: "cursor_abc" },
      isLoading: false,
      error: null,
    });
    renderSection();

    await user.click(screen.getByRole("button", { name: "Next" }));

    const lastCall = useActionLogMock.mock.calls[useActionLogMock.mock.calls.length - 1];
    expect(lastCall[1]).toBe("cursor_abc");
  });

  it("Previous is disabled on the first page", () => {
    renderSection();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Next is disabled when there is no nextCursor", () => {
    renderSection();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
