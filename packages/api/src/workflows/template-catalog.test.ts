/**
 * Contract tests for the seeded catalog — the templates the host ships
 * itself (`template-definitions.ts`), and the aggregation that puts them
 * beside the plugin-contributed ones.
 *
 * `template-definitions.test.ts` runs the same class of check over every
 * PLUGIN template, reading them off `bundledPlugins`. A seeded template
 * belongs to no plugin, so it never enters that suite. This one covers it,
 * and adds the three rules the seeded catalog holds itself to on top:
 *
 *   1. It calls no integration action. A seeded template must install on a
 *      deployment whatever set of plugins is loaded, and must run for a
 *      person who has connected nothing.
 *   2. It arms no schedule. A scheduled run puts `{ scheduleName, cron,
 *      input }` in `trigger.data` and applies NO `dataSchema` defaults, so
 *      a cron on any of these would read null every night forever.
 *   3. It hard-codes no person. Ownership and routing data arrive as
 *      workflow inputs, because a name baked into a shipped template is
 *      wrong within a month and takes a release to correct.
 */
import { describe, expect, it } from "vitest";
import {
  collectTemplatePaths,
  renderTemplate,
  validateWorkflowDefinition,
  type TemplateContext,
  type WorkflowDefinition,
  type WorkflowInputDefinition,
  type WorkflowNode,
} from "@valet/workflow";
import type { ActionPlugin, ValetPlugin, WorkflowTemplate } from "@valet/engine";
import { buildValidateEnvironment } from "./validation-env.js";
import { builtinWorkflowTemplates } from "./template-definitions.js";
import { bundledPlugins } from "../plugins/registry.gen.js";
import {
  CATALOG_SOURCE,
  bakeInputs,
  findCatalogTemplate,
  listCatalogTemplates,
  templateInputs,
} from "./templates.js";
import { toolNodesOf } from "./tool-nodes.js";

// A seeded template names no action, so the environment needs no action
// hook. The model hook is real: a model id that leaves the catalog must
// fail here rather than on somebody's first run.
const env = buildValidateEnvironment();

interface Seeded {
  template: WorkflowTemplate;
  definition: WorkflowDefinition;
}

const seeded: Seeded[] = builtinWorkflowTemplates.map((template) => ({
  template,
  // Narrowed here rather than at the manifest: `WorkflowTemplate.definition`
  // is `unknown` so the engine gains no dependency on @valet/workflow. The
  // "is a dag/v1 definition" assertion runs as its own test below.
  definition: template.definition as WorkflowDefinition,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

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

/** Every path a definition reads. `if.left` and `edge.when` are bare
 * expressions rather than templates, so they are wrapped before collection
 * — the parser underneath is the same one. */
function referencedPaths(definition: WorkflowDefinition): string[][] {
  const out: string[][] = [];
  for (const node of definition.nodes) {
    if (node.type === "if") {
      for (const condition of node.conditions) out.push(...collectTemplatePaths(`{{ ${condition.left} }}`));
      continue;
    }
    pathsInJson(node, out);
  }
  for (const edge of definition.edges) {
    if (edge.when !== undefined) out.push(...collectTemplatePaths(`{{ ${edge.when} }}`));
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

// ─── The catalog ─────────────────────────────────────────────────────────

describe("seeded workflow catalog", () => {
  it("ships at least one template", () => {
    expect(seeded.length).toBeGreaterThan(0);
  });

  it("namespaces every id, so a plugin cannot claim one by accident", () => {
    const unnamespaced = seeded.map((s) => s.template.id).filter((id) => !id.startsWith("catalog."));
    expect(unnamespaced).toEqual([]);
  });

  it("gives every template a distinct id", () => {
    const ids = seeded.map((s) => s.template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(seeded)("$template.id", ({ template, definition }) => {
    it("carries a dag/v1 definition", () => {
      expect(isRecord(template.definition)).toBe(true);
      expect(definition.version).toBe("dag/v1");
      expect(Array.isArray(definition.nodes)).toBe(true);
      expect(Array.isArray(definition.edges)).toBe(true);
    });

    it("passes the definition validator, models included", () => {
      const result = validateWorkflowDefinition(definition, env);
      // Print the validator's own messages on failure — they name the node
      // and the corrected path.
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("calls no integration action, so a deployment can always offer it", () => {
      expect(toolNodesOf(definition).map((node) => `${node.service}.${node.action}`)).toEqual([]);
    });

    it("arms no schedule, because a scheduled run delivers none of its inputs", () => {
      expect(template.schedule).toBeUndefined();
    });

    it("reads only real trigger-payload keys", () => {
      const wrong = referencedPaths(definition)
        .filter((segments) => segments[0] === "trigger")
        .filter((segments) => segments.length > 1 && !TRIGGER_PAYLOAD_KEYS.has(segments[1] ?? ""))
        .map((segments) => segments.join("."));
      expect(wrong).toEqual([]);
    });

    it("declares and labels every trigger input it reads", () => {
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
          if (field === "output") {
            const properties = schemaProperties(node.outputSchema);
            if (properties === null) {
              wrong.push(`${path} — reads .output from an llm node with no outputSchema`);
            } else if (segments[4] !== undefined && !properties.has(segments[4])) {
              wrong.push(`${path} — "${segments[4]}" is not declared by that node's outputSchema`);
            }
          }
        }

        if (node.type === "thread" || node.type === "session") {
          if (!SUBMISSION_RESULT_KEYS.has(field)) {
            wrong.push(`${path} — a ${node.type} result holds ${[...SUBMISSION_RESULT_KEYS].join(", ")}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it("carries card copy the gallery can render", () => {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.category.length).toBeGreaterThan(0);
      expect(template.steps.length).toBeGreaterThan(0);
    });

    it("settles every path at a stop node", () => {
      const outgoing = new Set(definition.edges.map((edge) => edge.from));
      const dangling = definition.nodes
        .filter((node) => node.type !== "stop" && !outgoing.has(node.id))
        .map((node) => node.id);
      expect(dangling).toEqual([]);
    });
  });
});

// ─── Aggregation ─────────────────────────────────────────────────────────

const seededIds = builtinWorkflowTemplates.map((t) => t.id);

function templateWith(id: string, rank?: number): WorkflowTemplate {
  return {
    id,
    name: id,
    description: id,
    category: "test",
    apps: [],
    steps: ["one"],
    ...(rank !== undefined ? { rank } : {}),
    definition: { version: "dag/v1", nodes: [{ id: "t", type: "trigger" }], edges: [] },
  };
}

function pluginWith(id: string): ValetPlugin {
  return { name: "fixture", version: "0.0.1", templates: [templateWith(id)] };
}

/** One plugin holding several templates, so the order under test is the
 * aggregation's own and not an accident of plugin order. */
function pluginHolding(templates: WorkflowTemplate[]): ValetPlugin {
  return { name: "fixture", version: "0.0.1", templates };
}

describe("listCatalogTemplates", () => {
  it("puts plugin templates first and the seeded catalog after them", () => {
    const owned = listCatalogTemplates([pluginWith("fixture.one")]);
    expect(owned.map((o) => o.template.id)).toEqual(["fixture.one", ...seededIds]);
    expect(owned[0]!.pluginName).toBe("fixture");
    expect(owned[1]!.pluginName).toBe(CATALOG_SOURCE);
  });

  it("offers the seeded catalog even when no plugin is loaded", () => {
    expect(listCatalogTemplates([]).map((o) => o.template.id)).toEqual(seededIds);
  });

  it("throws when a plugin claims a seeded id, naming both sides", () => {
    expect(() => listCatalogTemplates([pluginWith(seededIds[0]!)])).toThrow(
      new RegExp(`${seededIds[0]!.replace(".", "\\.")}.*fixture.*${CATALOG_SOURCE}`, "s"),
    );
  });
});

// ─── Order ───────────────────────────────────────────────────────────────

/**
 * Gallery order is `WorkflowTemplate.rank` and nothing else.
 *
 * Before this field the order fell out of plugin registration order and
 * array position: no author could read it, and no author could change it
 * without editing the host. These tests pin the three rules a reader has to
 * be able to rely on — ranked first, unranked after, and source order
 * everywhere the ranks say nothing.
 */
describe("gallery order", () => {
  it("puts a ranked template before every unranked one, wherever it was declared", () => {
    const owned = listCatalogTemplates([
      pluginHolding([templateWith("fixture.one"), templateWith("fixture.two"), templateWith("fixture.last", 1)]),
    ]);
    expect(owned[0]!.template.id).toBe("fixture.last");
  });

  it("sorts ranked templates by their number", () => {
    const owned = listCatalogTemplates([
      pluginHolding([templateWith("fixture.third", 30), templateWith("fixture.first", 1), templateWith("fixture.second", 20)]),
    ]);
    expect(owned.slice(0, 3).map((o) => o.template.id)).toEqual([
      "fixture.first",
      "fixture.second",
      "fixture.third",
    ]);
  });

  it("leaves unranked templates in aggregation order, so one rank moves one card", () => {
    const unranked = listCatalogTemplates([
      pluginHolding([templateWith("fixture.one"), templateWith("fixture.two"), templateWith("fixture.three")]),
    ]).map((o) => o.template.id);

    const ranked = listCatalogTemplates([
      pluginHolding([templateWith("fixture.one"), templateWith("fixture.two"), templateWith("fixture.three", 1)]),
    ]).map((o) => o.template.id);

    expect(unranked).toEqual(["fixture.one", "fixture.two", "fixture.three", ...seededIds]);
    expect(ranked).toEqual(["fixture.three", "fixture.one", "fixture.two", ...seededIds]);
  });

  it("keeps two templates that claim one rank in source order", () => {
    const owned = listCatalogTemplates([
      pluginHolding([templateWith("fixture.a", 1), templateWith("fixture.b", 1)]),
    ]);
    expect(owned.slice(0, 2).map((o) => o.template.id)).toEqual(["fixture.a", "fixture.b"]);
  });

  it("puts the shipped assign-reviewers template first", () => {
    // The gallery's first card, and the reason `rank` exists. Read off the
    // real registry, not a fixture: a rank another template takes later
    // must fail here.
    expect(listCatalogTemplates(bundledPlugins)[0]!.template.id).toBe("github.assign-reviewers");
  });
});

// ─── What install leaves on the run form ─────────────────────────────────

/**
 * Install BAKES a supplied value into the definition and drops the field
 * from `dataSchema`. A workflow left with no `dataSchema` gets no run form
 * at all, so a field baked by accident is a field the person can never
 * answer again.
 *
 * The install dialog sends every DECLARED DEFAULT plus whatever the reader
 * typed, so a per-run field that declares a default is baked on every
 * install without anybody choosing it. That is the shape this pins, on the
 * real registry rather than a fixture.
 */
describe("install keeps the hidden event payload, and bakes everything else", () => {
  const owned = findCatalogTemplate(bundledPlugins, "github.assign-reviewers");
  const template = owned!.template;
  // Narrowed here rather than at the manifest, the same way `seeded` above
  // narrows: `WorkflowTemplate.definition` is `unknown` so the engine gains
  // no dependency on @valet/workflow. The first test below checks the shape
  // this assumes.
  const definition = template.definition as WorkflowDefinition;

  // Unlike `env` above, this one carries the action map, so the save-time
  // param lint runs against the real action schemas.
  const actionPluginByService = new Map<
    string,
    { plugin: ValetPlugin; actionPlugin: ActionPlugin }
  >();
  for (const plugin of bundledPlugins) {
    for (const actionPlugin of plugin.actions ?? []) {
      actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
    }
  }
  const actionEnv = buildValidateEnvironment(actionPluginByService);

  /** What the dialog posts: declared defaults, plus the install-time
   * answers a reader gives. There is no per-run field left to leave empty —
   * an event trigger fills `payload`, and no install dialog collects a
   * `hidden` field at all. */
  function dialogPayload(): Record<string, string | number | boolean> {
    const values: Record<string, string | number | boolean> = {};
    for (const input of templateInputs(triggerSchema(definition))) {
      if (input.default !== undefined) values[input.name] = input.default;
    }
    values.repository = "example-org/platform";
    values.rosterOwner = "example-org";
    values.rosterRepository = "handbook";
    return values;
  }

  it("carries a dag/v1 definition, which the narrowing above assumes", () => {
    expect(isRecord(template.definition)).toBe(true);
    expect(definition.version).toBe("dag/v1");
  });

  it("bakes every install-time field, and leaves only the hidden event payload", () => {
    const baked = bakeInputs(definition, dialogPayload());
    expect(Object.keys(triggerSchema(baked) ?? {})).toEqual(["payload"]);
    expect(triggerSchema(baked)?.payload?.hidden).toBe(true);
  });

  it("writes the baked roster location into the roster read, not a run-form value", () => {
    const baked = bakeInputs(definition, dialogPayload());
    const roster = nodesById(baked).get("roster");
    const params = roster && "params" in roster ? roster.params : undefined;
    expect(isRecord(params) ? params.owner : "").toBe("example-org");
    expect(isRecord(params) ? params.repo : "").toBe("handbook");
  });

  it("leaves the pull request's own repository to the event, and never bakes one in", () => {
    // The failure this pins: a baked owner/repo would read CODEOWNERS from
    // one fixed repository regardless of which one the webhook names.
    const baked = bakeInputs(definition, dialogPayload());
    const codeowners = nodesById(baked).get("codeowners");
    const params = codeowners && "params" in codeowners ? codeowners.params : undefined;
    expect(isRecord(params) ? params.owner : "").toBe("{{ trigger.data.payload.repository.owner.login }}");
  });

  it("still validates once the install-time values are written in", () => {
    // Baking rewrites the very params the save-time action-schema lint
    // reads, and install re-validates before it writes anything. The
    // environment carries the real action map, so `getActionParams` runs —
    // a bare environment skips that lint and would prove nothing.
    const baked = bakeInputs(definition, dialogPayload());
    const result = validateWorkflowDefinition(baked, actionEnv);
    // Print the validator's own messages on failure — they name the node
    // and the corrected path.
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe("findCatalogTemplate", () => {
  it("finds a seeded template by id", () => {
    const found = findCatalogTemplate([], seededIds[0]!);
    expect(found?.template.id).toBe(seededIds[0]);
    expect(found?.pluginName).toBe(CATALOG_SOURCE);
  });

  it("finds a plugin template by id", () => {
    expect(findCatalogTemplate([pluginWith("fixture.one")], "fixture.one")?.pluginName).toBe("fixture");
  });

  it("reports an unknown id as not found", () => {
    expect(findCatalogTemplate([], "nope")).toBeNull();
  });
});

// ─── The addressing rule itself ──────────────────────────────────────────

describe("dag/v1 addressing", () => {
  const context: TemplateContext = {
    trigger: { type: "manual", timestamp: "2026-08-15T00:00:00.000Z", data: { area: "billing" }, metadata: {} },
    nodes: {
      route: {
        result: { text: "raw", output: { matched: true, reviewer: "@reviewer-one" } },
        output: { text: "raw", output: { matched: true, reviewer: "@reviewer-one" } },
      },
      notify: { result: { sessionId: "s1", response: "sent" }, output: { sessionId: "s1", response: "sent" } },
    },
  };

  it("reads a trigger input under data, and nothing above it", () => {
    expect(renderTemplate("{{ trigger.data.area }}", context)).toBe("billing");
    expect(renderTemplate("{{ trigger.area }}", context)).toBeNull();
  });

  it("reads a schema'd llm node under result.output", () => {
    expect(renderTemplate("{{ nodes.route.result.output.reviewer }}", context)).toBe("@reviewer-one");
    // The v1 shape. It resolves to nothing here, which is why a template
    // that uses it produces an empty prompt instead of an error.
    expect(renderTemplate("{{ nodes.route.data.reviewer }}", context)).toBeNull();
  });

  it("reads an orchestrator node at result.response, and never at result.text", () => {
    expect(renderTemplate("{{ nodes.notify.result.response }}", context)).toBe("sent");
    expect(renderTemplate("{{ nodes.notify.result.text }}", context)).toBeNull();
  });
});
