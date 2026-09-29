// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderTemplate, type TemplateContext } from "@valet/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const createMutateAsync = vi.fn();
let teamId: string | undefined;
vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
  useModelTiers: () => ({ data: { xs: [], s: [], m: [], l: [], xl: [] }, isLoading: false, error: null }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

vi.mock("~/api/workflows", () => ({
  useCreateWorkflow: () => ({ mutateAsync: createMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ teamId }),
}));

import { NewWorkflowDialog } from "./new-workflow-dialog";

// ─── The addressing rule itself ──────────────────────────────────────────

describe("dag/v1 addressing", () => {
  const context: TemplateContext = {
    trigger: { type: "manual", timestamp: "2026-08-15T00:00:00.000Z", data: { q: "hello" }, metadata: {} },
    nodes: {
      think: { result: { text: "T" }, output: { text: "T" } },
      agent: { result: { sessionId: "s1", response: "R" }, output: { sessionId: "s1", response: "R" } },
      search: { result: { total_count: 3, items: [] }, output: { total_count: 3, items: [] } },
    },
  };

  it("reads a trigger input under data, and nothing above it", () => {
    expect(renderTemplate("{{ trigger.data.q }}", context)).toBe("hello");
    expect(renderTemplate("{{ trigger.q }}", context)).toBeNull();
  });

  it("reads an llm node at result.text, and never at result.response", () => {
    expect(renderTemplate("{{ nodes.think.result.text }}", context)).toBe("T");
    expect(renderTemplate("{{ nodes.think.result.response }}", context)).toBeNull();
  });

  it("reads an orchestrator node at result.response, and never at result.text", () => {
    expect(renderTemplate("{{ nodes.agent.result.response }}", context)).toBe("R");
    expect(renderTemplate("{{ nodes.agent.result.text }}", context)).toBeNull();
  });

  it("reads a tool node's own payload fields straight off result", () => {
    expect(renderTemplate("{{ nodes.search.result.total_count }}", context)).toBe(3);
  });
});

// ─── The dialog ──────────────────────────────────────────────────────────

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<NewWorkflowDialog open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

beforeEach(() => {
  teamId = undefined;
  navigate.mockReset();
  createMutateAsync.mockReset();
  createMutateAsync.mockResolvedValue({ id: "wf_new" });
});

describe("NewWorkflowDialog", () => {
  it("trims the name, closes, and lands on the new workflow", async () => {
    const onOpenChange = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Weekly brief  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect((createMutateAsync.mock.calls[0]![0] as { name: string }).name).toBe("Weekly brief");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$workflowId",
      params: { workflowId: "wf_new" },
    });
  });

  it("creates nothing when the name is only spaces", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("stays open when the create fails", async () => {
    createMutateAsync.mockRejectedValue(new Error("name already used"));
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

it("creates workspace-owned workflows without an assistant selector", async () => {
  teamId = "team1";
  renderDialog();
  expect(screen.queryByLabelText("Orchestrator")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
  expect(createMutateAsync.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ teamId: "team1" }));
  expect(createMutateAsync.mock.calls.at(-1)?.[0].definition).not.toHaveProperty("assistantId");
});
