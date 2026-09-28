import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@valet/workflow";
import { appendRemovedEdgeHint, applyWorkflowModelPatch, applyWorkflowPatch } from "./patch.js";

function base(): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "greet", type: "set", values: { hi: "there" } },
      { id: "done", type: "stop" },
    ],
    edges: [
      { from: "trigger", to: "greet" },
      { from: "greet", to: "done" },
    ],
    ui: { nodes: { greet: { position: { x: 10, y: 10 } } } },
  };
}

describe("applyWorkflowPatch", () => {
  it("upserts by id (replace) and appends new nodes", () => {
    const result = applyWorkflowPatch(base(), {
      upsertNodes: [
        { id: "greet", type: "set", values: { hi: "world" } },
        { id: "extra", type: "set", values: {} },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.nodes).toHaveLength(4);
      const greet = result.definition.nodes.find((n) => n.id === "greet");
      expect(greet).toMatchObject({ values: { hi: "world" } });
    }
  });

  it("removes nodes together with their edges and ui position", () => {
    const result = applyWorkflowPatch(base(), { removeNodeIds: ["greet"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.nodes.map((n) => n.id)).toEqual(["trigger", "done"]);
      expect(result.definition.edges).toEqual([]);
      expect(result.definition.ui?.nodes?.greet).toBeUndefined();
    }
  });

  it("adds edges idempotently and removes matching edges", () => {
    const result = applyWorkflowPatch(base(), {
      removeEdges: [{ from: "greet", to: "done" }],
      addEdges: [
        { from: "trigger", to: "done" },
        { from: "trigger", to: "greet" }, // duplicate of existing — no-op
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.edges).toEqual([
        { from: "trigger", to: "greet" },
        { from: "trigger", to: "done" },
      ]);
    }
  });

  it("accepts a patch that removes a node and lists its edges explicitly", () => {
    const result = applyWorkflowPatch(base(), {
      removeNodeIds: ["greet"],
      removeEdges: [
        { from: "trigger", to: "greet" },
        { from: "greet", to: "done" },
      ],
      addEdges: [{ from: "trigger", to: "done" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.nodes.map((n) => n.id)).toEqual(["trigger", "done"]);
      expect(result.definition.edges).toEqual([{ from: "trigger", to: "done" }]);
    }
  });

  it("still rejects a remove_edges entry that matches nothing", () => {
    const result = applyWorkflowPatch(base(), {
      removeNodeIds: ["greet"],
      removeEdges: [{ from: "trigger", to: "ghost" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'remove_edges: no edge matches {"from":"trigger","to":"ghost"}',
      ]);
    }
  });

  it("reports unknown ids/edges instead of silently no-oping", () => {
    const result = applyWorkflowPatch(base(), {
      removeNodeIds: ["ghost"],
      removeEdges: [{ from: "a", to: "b" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('no node with id "ghost"'))).toBe(true);
      expect(result.errors.some((e) => e.includes("no edge matches"))).toBe(true);
    }
  });

  it("rejects upsert entries without a string id", () => {
    const result = applyWorkflowPatch(base(), { upsertNodes: [{ type: "set" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('string "id"'))).toBe(true);
    }
  });

  it("does not mutate the input definition", () => {
    const original = base();
    const snapshot = JSON.parse(JSON.stringify(original));
    applyWorkflowPatch(original, { removeNodeIds: ["greet"], upsertNodes: [{ id: "x", type: "stop" }] });
    expect(original).toEqual(snapshot);
  });
});

describe("applyWorkflowModelPatch", () => {
  const definition: WorkflowDefinition = {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger" },
      { id: "one", type: "llm", model: "old", prompt: "one" },
      { id: "agent", type: "session", mode: "start", model: "legacy", prompt: "two" },
      { id: "orch", type: "thread", prompt: "three" },
      { id: "done", type: "stop" },
    ],
    edges: [],
  };

  it("updates all llm and session nodes without changing orchestrators", () => {
    const result = applyWorkflowModelPatch(definition, "m");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodeIds).toEqual(["one", "agent"]);
    expect(result.definition.nodes.find((node) => node.id === "one")).toMatchObject({ model: "m" });
    expect(result.definition.nodes.find((node) => node.id === "agent")).toMatchObject({ model: "m" });
    expect(result.definition.nodes.find((node) => node.id === "orch")).toEqual(definition.nodes[3]);
  });

  it("updates only selected nodes and preserves legacy explicit models", () => {
    const result = applyWorkflowModelPatch(definition, "xs", ["one"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.nodes.find((node) => node.id === "agent")).toMatchObject({ model: "legacy" });
  });

  it("rejects a selected node that has no per-node model", () => {
    const result = applyWorkflowModelPatch(definition, "s", ["orch"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not an llm or session node");
  });

  /** The editor seeds a new llm or session node from `ui.defaultModel`. */
  function withEditorState(): WorkflowDefinition {
    return { ...structuredClone(definition), ui: { nodes: {}, defaultModel: "old" } };
  }

  it("moves the editor default with a patch that targets every node", () => {
    const result = applyWorkflowModelPatch(withEditorState(), "l");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.ui?.defaultModel).toBe("l");
  });

  it("leaves the editor default alone for a patch that targets a subset", () => {
    const result = applyWorkflowModelPatch(withEditorState(), "l", ["one"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.ui?.defaultModel).toBe("old");
  });

  it("adds no editor state to a definition that carries none", () => {
    const result = applyWorkflowModelPatch(definition, "l");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.ui).toBeUndefined();
  });
});

describe("appendRemovedEdgeHint", () => {
  const unreachable = ['node "done" is unreachable — add an edge path from the trigger ("trigger") to it'];

  it("appends one hint naming the removed edges when the lint reports unreachable nodes", () => {
    const result = appendRemovedEdgeHint(unreachable, [{ from: "greet", to: "done" }]);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(
      "hint: this patch removed edge(s) greet->done; if a removed edge was the only path " +
        "to the unreachable nodes, add a replacement edge in the same patch",
    );
  });

  it("lists every removed edge in the hint", () => {
    const result = appendRemovedEdgeHint(unreachable, [
      { from: "a", to: "b" },
      { from: "b", to: "c", fromOutput: "true" },
    ]);
    expect(result[1]).toContain("a->b, b->c");
  });

  it("leaves the errors alone when the patch removed no edges", () => {
    expect(appendRemovedEdgeHint(unreachable, undefined)).toEqual(unreachable);
    expect(appendRemovedEdgeHint(unreachable, [])).toEqual(unreachable);
  });

  it("leaves the errors alone when nothing is unreachable", () => {
    const other = ['node "x": llm.prompt must be a non-empty string'];
    expect(appendRemovedEdgeHint(other, [{ from: "a", to: "b" }])).toEqual(other);
  });
});
