// @vitest-environment jsdom
/**
 * The create dialog's presets.
 *
 * Two things are under test, and the first is the expensive one.
 *
 * A preset is the first workflow most people ever read, so whatever it
 * ships they copy. A wrong template path is NOT a validation error past the
 * third segment: `{{ trigger.request }}` and `{{ nodes.x.result.response }}`
 * on an llm node both save cleanly, run cleanly, and render empty into the
 * middle of a prompt. So every preset is held to the real validator and to
 * the four addressing rules the runtime actually implements:
 *
 *   1. a trigger input lives at `trigger.data.<field>`;
 *   2. an llm node exposes `result.text`, plus `result.output.<f>` only
 *      when it declares an `outputSchema`;
 *   3. an orchestrator or session node exposes `result.response`;
 *   4. a tool node's result is the action's own payload.
 *
 * `dag/v1 addressing` at the bottom pins rules 1 and 2 against
 * `renderTemplate` itself, so the checks above are measured against the
 * runtime rather than against this file's own belief.
 *
 * The second thing is the dialog: the chosen preset must be the definition
 * that gets created, and a name somebody typed must survive changing their
 * mind about the shape.
 *
 * `useNavigate` needs router context — mocked the way
 * `import-workflow-dialog.test.tsx` does, since these tests care that
 * navigation was requested, not that a router resolved it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListAssistantsResponse } from "@valet/api/wire";
import {
  collectTemplatePaths,
  renderTemplate,
  validateWorkflowDefinition,
  type TemplateContext,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowInputDefinition,
  type WorkflowNode,
} from "@valet/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const createMutateAsync = vi.fn();
let teamId: string | undefined;
let assistantsResult: { data?: ListAssistantsResponse; isLoading: boolean; error: Error | null };
vi.mock("~/api/assistants", () => ({ useAssistants: () => ({ ...assistantsResult, refetch: vi.fn() }) }));
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

import { NewWorkflowDialog, withWorkflowModel, WORKFLOW_PRESETS } from "./new-workflow-dialog";

// ─── Validation environment ──────────────────────────────────────────────

/**
 * The models and actions a preset may name.
 *
 * Both hooks are stated here rather than imported from the server, because
 * a preset that names a model or an action this list does not hold is a
 * decision, not an accident: adding it here is the moment somebody confirms
 * the runtime really offers it.
 */
const KNOWN_MODELS = new Set(["xs", "s", "m", "l", "xl"]);
const KNOWN_ACTIONS = new Set(["github.search_issues"]);

const env: ValidateEnvironment = {
  isKnownModel: (spec) => KNOWN_MODELS.has(spec),
  isKnownAction: (service, action) => {
    if (!KNOWN_ACTIONS.has(`${service}.${action}`)) return "unknown-action";
    return "ok";
  },
};

// ─── Path helpers ────────────────────────────────────────────────────────

/** Payload keys a `{{ trigger.… }}` path may name (`WorkflowTriggerPayload`). */
const TRIGGER_PAYLOAD_KEYS = new Set(["type", "triggerId", "timestamp", "data", "metadata"]);

/** `LlmResult` keys. `response` is NOT one of them — that is the session shape. */
const LLM_RESULT_KEYS = new Set(["text", "output", "usage"]);

/** Settled `session`/`orchestrator` result keys. `text` is NOT one of them. */
const SUBMISSION_RESULT_KEYS = new Set(["sessionId", "response", "output"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathsInJson(value: unknown, out: string[][]): void {
  if (typeof value === "string") {
    out.push(...collectTemplatePaths(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) pathsInJson(entry, out);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) pathsInJson(entry, out);
  }
}

/** Every path a definition reads. `if.left` is a bare expression rather
 * than a template, so it is wrapped before collection — the parser
 * underneath is the same one. */
function referencedPaths(definition: WorkflowDefinition): string[][] {
  const out: string[][] = [];
  for (const node of definition.nodes) {
    if (node.type === "if") {
      for (const condition of node.conditions) out.push(...collectTemplatePaths(`{{ ${condition.left} }}`));
      continue;
    }
    pathsInJson(node, out);
  }
  return out;
}

function schemaProperties(schema: Record<string, unknown> | undefined): Set<string> | null {
  if (schema === undefined) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  return new Set(Object.keys(properties));
}

function triggerSchema(definition: WorkflowDefinition): Record<string, WorkflowInputDefinition> | undefined {
  const trigger = definition.nodes.find((node) => node.type === "trigger");
  return trigger?.type === "trigger" ? trigger.dataSchema : undefined;
}

function nodesById(definition: WorkflowDefinition): Map<string, WorkflowNode> {
  const map = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    map.set(node.id, node);
    if (node.type === "foreach") map.set(node.body.id, node.body);
  }
  return map;
}

// ─── Preset contract ─────────────────────────────────────────────────────

describe("workflow presets", () => {
  it("offers the four starting shapes, with stable ids", () => {
    expect(WORKFLOW_PRESETS.map((preset) => preset.id)).toEqual([
      "blank",
      "simple",
      "parallel",
      "api-automation",
    ]);
  });

  it("gives every preset a distinct id", () => {
    expect(new Set(WORKFLOW_PRESETS.map((p) => p.id)).size).toBe(WORKFLOW_PRESETS.length);
  });

  describe.each(WORKFLOW_PRESETS)("$id", (preset) => {
    const definition = preset.build();

    it("passes the definition validator, models and actions included", () => {
      const result = validateWorkflowDefinition(definition, env);
      // Print the validator's own messages on failure — they name the node
      // and the corrected path.
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("builds a fresh definition each time, so one editor cannot mutate the next", () => {
      const again = preset.build();
      expect(again).toEqual(definition);
      expect(again).not.toBe(definition);
    });

    it("reads only real trigger-payload keys", () => {
      const wrong = referencedPaths(definition)
        .filter((segments) => segments[0] === "trigger")
        .filter((segments) => segments.length > 1 && !TRIGGER_PAYLOAD_KEYS.has(segments[1] ?? ""))
        .map((segments) => segments.join("."));
      expect(wrong).toEqual([]);
    });

    it("declares every trigger input it reads, and labels it", () => {
      const schema = triggerSchema(definition);
      const undeclared: string[] = [];
      for (const segments of referencedPaths(definition)) {
        if (segments[0] !== "trigger" || segments[1] !== "data") continue;
        const field = segments[2];
        if (field === undefined || schema?.[field] === undefined) undeclared.push(segments.join("."));
      }
      expect(undeclared).toEqual([]);

      const unlabelled = Object.entries(schema ?? {})
        .filter(([, field]) => field.hidden !== true && (field.label === undefined || field.label === ""))
        .map(([name]) => name);
      expect(unlabelled).toEqual([]);
    });

    it("reads llm and orchestrator results with each one's own shape", () => {
      const byId = nodesById(definition);
      const wrong: string[] = [];
      for (const segments of referencedPaths(definition)) {
        if (segments[0] !== "nodes") continue;
        const node = byId.get(segments[1] ?? "");
        if (node === undefined) continue; // the validator already reports this
        const field = segments[3];
        if (field === undefined) continue; // whole result — always valid
        const path = segments.join(".");

        if (node.type === "llm") {
          if (!LLM_RESULT_KEYS.has(field)) {
            wrong.push(`${path} — an llm result holds ${[...LLM_RESULT_KEYS].join(", ")}`);
            continue;
          }
          if (field === "output" && schemaProperties(node.outputSchema) === null) {
            wrong.push(`${path} — reads .output from an llm node with no outputSchema`);
          }
        }

        if ((node.type === "orchestrator" || node.type === "session") && !SUBMISSION_RESULT_KEYS.has(field)) {
          wrong.push(`${path} — a ${node.type} result holds ${[...SUBMISSION_RESULT_KEYS].join(", ")}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it("caps every foreach and reports what the cap dropped", () => {
      // A foreach truncates at `maxItems` in silence, so a starter graph
      // must never leave the cap implicit.
      const loops = definition.nodes.filter((node) => node.type === "foreach");
      expect(loops.filter((node) => node.type === "foreach" && node.maxItems === undefined)).toEqual([]);

      const reported = new Set(
        referencedPaths(definition)
          .filter((segments) => segments[0] === "nodes" && segments[3] === "truncatedCount")
          .map((segments) => segments[1] ?? ""),
      );
      const silent = loops.filter((node) => !reported.has(node.id)).map((node) => node.id);
      expect(silent).toEqual([]);
    });

    it("places every node, so the canvas never stacks them at the origin", () => {
      const placed = new Set(Object.keys(definition.ui?.nodes ?? {}));
      const unplaced = definition.nodes.filter((node) => !placed.has(node.id)).map((node) => node.id);
      expect(unplaced).toEqual([]);
    });

    it("ends at a stop node on every path the graph can take", () => {
      const outgoing = new Set(definition.edges.map((edge) => edge.from));
      const dangling = definition.nodes
        .filter((node) => node.type !== "stop" && !outgoing.has(node.id))
        .map((node) => node.id);
      expect(dangling).toEqual([]);
    });
  });

  it("makes the parallel preset fan out, rather than run one after another", () => {
    const definition = WORKFLOW_PRESETS.find((p) => p.id === "parallel")!.build();
    const trigger = definition.nodes.find((node) => node.type === "trigger")!;
    const fromTrigger = definition.edges.filter((edge) => edge.from === trigger.id);
    // Three edges leaving the trigger is what puts the branches in one wave.
    expect(fromTrigger.length).toBe(3);

    const aggregate = definition.edges.filter((edge) => edge.to === "summary").map((edge) => edge.from);
    expect(aggregate.sort()).toEqual(["evidence", "options", "risks"]);
  });

  it("gives the API preset both branches of its conditional", () => {
    const definition = WORKFLOW_PRESETS.find((p) => p.id === "api-automation")!.build();
    const branches = definition.edges.filter((edge) => edge.from === "any_matches");
    expect(branches.map((edge) => edge.fromOutput).sort()).toEqual(["false", "true"]);
    // The empty branch must still settle the run, or an empty search parks
    // it forever.
    const empty = branches.find((edge) => edge.fromOutput === "false")!;
    expect(definition.nodes.find((node) => node.id === empty.to)?.type).toBe("stop");
  });

  it("leaves the blank preset a bare trigger and stop", () => {
    const definition = WORKFLOW_PRESETS.find((p) => p.id === "blank")!.build();
    expect(definition.nodes.map((node) => node.type).sort()).toEqual(["stop", "trigger"]);
  });

  it("persists the blank preset recommendation for model-capable nodes added later", () => {
    const blank = WORKFLOW_PRESETS.find((preset) => preset.id === "blank")!;
    const definition = withWorkflowModel(blank.build(), blank.recommendedModel);
    expect(definition.ui?.defaultModel).toBe("s");
    expect(definition.nodes.map((node) => node.type).sort()).toEqual(["stop", "trigger"]);
  });
});

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
  assistantsResult = { data: { assistants: [
    { id: "personal", owner: { type: "user", id: "user1" }, name: "Personal", sessionId: "assistant:personal", isDefault: true, createdAt: 1 },
    { id: "team-a", owner: { type: "team", id: "team1" }, name: "Team default", sessionId: "assistant:team-a", isDefault: true, createdAt: 1 },
    { id: "team-b", owner: { type: "team", id: "team1" }, name: "Release bot", sessionId: "assistant:team-b", isDefault: false, createdAt: 1 },
    { id: "other", owner: { type: "team", id: "team2" }, name: "Other team", sessionId: "assistant:other", isDefault: true, createdAt: 1 },
  ] }, isLoading: false, error: null };
  navigate.mockReset();
  createMutateAsync.mockReset();
  createMutateAsync.mockResolvedValue({ id: "wf_new" });
});

describe("NewWorkflowDialog", () => {
  it("offers every preset, with Blank chosen first", () => {
    renderDialog();
    for (const preset of WORKFLOW_PRESETS) {
      expect(screen.getByRole("radio", { name: new RegExp(preset.name) })).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: /Blank/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("creates the definition of the preset that was chosen", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Parallel with summary/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as { name: string; definition: WorkflowDefinition };
    const parallel = WORKFLOW_PRESETS.find((preset) => preset.id === "parallel")!;
    expect(body.definition).toEqual({
      ...withWorkflowModel(parallel.build(), parallel.recommendedModel),
    });
  });

  it("shows a recommendation and keeps an explicit model override across preset changes", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Simple/ }));
    const model = screen.getByRole("combobox", { name: "Default model" });
    expect((model as HTMLInputElement).value).toContain("Medium");

    fireEvent.focus(model);
    fireEvent.click(screen.getByRole("option", { name: "Large" }));
    fireEvent.click(screen.getByRole("radio", { name: /API automation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const definition = (createMutateAsync.mock.calls[0]![0] as { definition: WorkflowDefinition }).definition;
    expect(definition.nodes.filter((node) => node.type === "llm").map((node) => node.model)).toEqual(["l"]);
  });

  it("suggests the preset's name, and keeps a name that was typed", () => {
    renderDialog();
    const field = screen.getByLabelText("Name");

    fireEvent.click(screen.getByRole("radio", { name: /Simple/ }));
    expect((field as HTMLInputElement).value).toBe("Answer a request");

    fireEvent.change(field, { target: { value: "Support triage" } });
    fireEvent.click(screen.getByRole("radio", { name: /API automation/ }));
    // Replacing a name somebody wrote is worse than a dull default.
    expect((field as HTMLInputElement).value).toBe("Support triage");
  });

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
