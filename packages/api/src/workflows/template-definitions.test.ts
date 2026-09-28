/**
 * Contract tests for the workflow templates every loaded plugin
 * contributes.
 *
 * A template that names a wrong path does not fail when it is saved. It
 * fails on the first RUN, inside a node, in front of whoever installed it.
 * These tests move that failure to CI.
 *
 * The validator catches most of it (unknown node, unknown action, unknown
 * model, a `nodes.x.data` reference). Four things it provably cannot catch,
 * because the root `trigger` and the shape under `result` are opaque to it,
 * are pinned here instead:
 *
 *   1. `trigger.<field>` — the payload is `{ type, triggerId, timestamp,
 *      data, metadata }`, so an input field lives at `trigger.data.<field>`
 *      and `trigger.<field>` renders null.
 *   2. A scheduled run gets `{ scheduleName, cron, input }` in
 *      `trigger.data`, and NO `dataSchema` defaults — so a field a
 *      scheduled template reads must be gone before the schedule fires.
 *      Install is what removes it: `bakeInputs` rewrites the reference to
 *      a literal for every field it resolved a value for. It resolves one
 *      for a field with a primitive `default`, and refuses the whole
 *      install for a `required` field with no value. A field that is
 *      neither is the silent case this pins.
 *   3. An llm node exposes `result.text` (and `result.output.<f>` only with
 *      an `outputSchema`); an orchestrator or session node exposes
 *      `result.response`. The two are opposites and easy to swap.
 *   4. A foreach node truncates at `maxItems` in silence, so every foreach
 *      must declare the cap AND something downstream must read
 *      `truncatedCount`.
 */
import { describe, expect, it } from "vitest";
import {
  collectTemplatePaths,
  renderTemplate,
  validateWorkflowDefinition,
  type ForeachNode,
  type TemplateContext,
  type WorkflowDefinition,
  type WorkflowInputDefinition,
  type WorkflowNode,
} from "@valet/workflow";
import type { ActionPlugin, ValetPlugin, WorkflowTemplate } from "@valet/engine";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { nextFireAt } from "./schedule-service.js";
import { buildValidateEnvironment } from "./validation-env.js";
import { templateRequirements } from "./templates.js";
import { toolNodesOf } from "./tool-nodes.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const actionPluginByService = new Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>();
for (const plugin of bundledPlugins) {
  for (const actionPlugin of plugin.actions ?? []) {
    actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
  }
}
const env = buildValidateEnvironment(actionPluginByService);

interface OwnedTemplate {
  pluginName: string;
  template: WorkflowTemplate;
  definition: WorkflowDefinition;
}

const owned: OwnedTemplate[] = bundledPlugins.flatMap((plugin) =>
  (plugin.templates ?? []).map((template) => ({
    pluginName: plugin.name,
    template,
    // Narrowed here rather than at the manifest: `WorkflowTemplate.definition`
    // is `unknown` so the engine gains no dependency on @valet/workflow. The
    // "is a dag/v1 definition" assertion runs as its own test below, before
    // anything reads `.nodes`.
    definition: template.definition as WorkflowDefinition,
  })),
);

/** Payload keys a `{{ trigger.… }}` path may name (`WorkflowTriggerPayload`). */
const TRIGGER_PAYLOAD_KEYS = new Set(["type", "triggerId", "timestamp", "data", "metadata"]);

/** `LlmResult` keys. `response` is NOT one of them — that is the session shape. */
const LLM_RESULT_KEYS = new Set(["text", "output", "usage"]);

/** Settled `session`/`orchestrator` result keys. `text` is NOT one — that is the llm shape. */
const SUBMISSION_RESULT_KEYS = new Set(["sessionId", "response", "output"]);

/** `ForeachResult` keys. */
const FOREACH_RESULT_KEYS = new Set([
  "items",
  "count",
  "inputCount",
  "truncatedCount",
  "completedCount",
  "skippedCount",
  "failedCount",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** One shipped template, by id. A miss is a failed test rather than an
 * `undefined` that reads as a passing assertion three lines later. */
function ownedById(id: string): OwnedTemplate {
  const found = owned.find((o) => o.template.id === id);
  if (!found) throw new Error(`no shipped template with id "${id}"`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every node a template may reference, keyed by id — top-level nodes plus
 * foreach body nodes, which checkpoint under their own id.
 */
function nodesById(definition: WorkflowDefinition): Map<string, WorkflowNode> {
  const map = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    map.set(node.id, node);
    if (node.type === "foreach") map.set(node.body.id, node.body);
  }
  return map;
}

/** Walk a JSON value and collect the template paths in every string leaf. */
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

/**
 * Every path a definition reads. `if.left` and `edge.when` are bare
 * expressions rather than templates, so they are wrapped before collection —
 * the parser is the same one underneath.
 */
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

/** Declared property names of an `outputSchema`, or null when it declares none. */
function schemaProperties(schema: Record<string, unknown> | undefined): Set<string> | null {
  if (schema === undefined) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  return new Set(Object.keys(properties));
}

function foreachNodes(definition: WorkflowDefinition): ForeachNode[] {
  return definition.nodes.filter((node): node is ForeachNode => node.type === "foreach");
}

/** A field name `bakeInputs` will put in a regular expression, and an
 * expression will read with dot access. One rule covers both. */
const BAKEABLE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why install cannot rewrite one `trigger.data` reference into a literal,
 * or null when it can.
 *
 * This mirrors the two functions in `templates.ts` that do the work.
 * `bakeInputs` rewrites a plain `{{ trigger.data.<field> }}` and nothing
 * longer. `resolveInstallValues` finds a value for that field from what the
 * installer supplied, then from a primitive `default`; a `required` field
 * with neither refuses the whole install, which is loud and therefore safe.
 * Everything else leaves the reference in place, and a scheduled run reads
 * it as null forever.
 */
function unbakeableReason(
  segments: string[],
  schema: Record<string, WorkflowInputDefinition> | undefined,
): string | null {
  const field = segments[2];
  if (field === undefined) return "reads trigger.data whole; install replaces one field at a time";
  if (segments.length > 3) return "reads a path under the field, which the install-time rewrite cannot reach";
  if (!BAKEABLE_FIELD.test(field)) return `"${field}" is not a plain identifier, so the rewrite skips it`;
  const def = schema?.[field];
  if (def === undefined) return `"${field}" is not declared in the trigger's dataSchema`;
  if (def.type !== "string" && def.type !== "number" && def.type !== "boolean") {
    return `"${field}" is declared ${def.type}; install bakes primitives only`;
  }
  if (def.required === true) return null;
  const fallback = def.default;
  if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") return null;
  return `"${field}" is optional with no default, so install has nothing to bake in`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("plugin workflow templates", () => {
  it("at least one plugin contributes a template", () => {
    expect(owned.length).toBeGreaterThan(0);
  });

  it("template ids are unique across every loaded plugin", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, template } of owned) {
      const previous = seen.get(template.id);
      if (previous !== undefined) collisions.push(`"${template.id}" claimed by both ${previous} and ${pluginName}`);
      seen.set(template.id, pluginName);
    }
    expect(collisions).toEqual([]);
  });

  it("every Linear tool node calls list_issues with assignee 'me', never list_my_issues", () => {
    // Linear is a dynamic MCP plugin, so the definition validator provably
    // cannot check its action names against a static list — a wrong name
    // fails only at run time ("unknown action: linear.list_my_issues"). The
    // official server (mcp.linear.app) exposes `list_issues`, whose own
    // description reads "For my issues, use 'me' as the assignee." Pin the
    // verified call here so a regression is caught in CI, not in a run.
    const linearNodes = owned.flatMap(({ definition }) =>
      toolNodesOf(definition).filter((node) => node.service === "linear"),
    );
    expect(linearNodes.length).toBeGreaterThan(0);
    for (const node of linearNodes) {
      expect(node.action).toBe("list_issues");
      expect(node.params.assignee).toBe("me");
    }
  });

  describe.each(owned)("$template.id (from $pluginName)", ({ template, definition }) => {
    it("carries a dag/v1 definition", () => {
      expect(isRecord(template.definition)).toBe(true);
      expect(definition.version).toBe("dag/v1");
      expect(Array.isArray(definition.nodes)).toBe(true);
      expect(Array.isArray(definition.edges)).toBe(true);
    });

    it("passes the definition validator, models and actions included", () => {
      const result = validateWorkflowDefinition(definition, env);
      // Print the validator's own messages on failure — they name the node
      // and the corrected path.
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("reads only real trigger-payload keys", () => {
      const wrong = referencedPaths(definition)
        .filter((segments) => segments[0] === "trigger")
        .filter((segments) => segments.length > 1 && !TRIGGER_PAYLOAD_KEYS.has(segments[1] ?? ""))
        .map((segments) => segments.join("."));
      expect(wrong).toEqual([]);
    });

    it("reads llm, session and foreach results with each one's own shape", () => {
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
            continue;
          }
          if (field === "output") {
            const properties = schemaProperties(node.outputSchema);
            if (properties === null) {
              wrong.push(`${path} — reads .output from a ${node.type} node with no outputSchema`);
            } else if (segments[4] !== undefined && !properties.has(segments[4])) {
              wrong.push(`${path} — "${segments[4]}" is not declared by that node's outputSchema`);
            }
          }
        }

        if (node.type === "foreach" && !FOREACH_RESULT_KEYS.has(field)) {
          wrong.push(`${path} — a foreach result holds ${[...FOREACH_RESULT_KEYS].join(", ")}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it("caps every foreach and reports what the cap dropped", () => {
      const loops = foreachNodes(definition);
      const uncapped = loops.filter((node) => node.maxItems === undefined).map((node) => node.id);
      expect(uncapped).toEqual([]);

      const reported = new Set(
        referencedPaths(definition)
          .filter((segments) => segments[0] === "nodes" && segments[3] === "truncatedCount")
          .map((segments) => segments[1] ?? ""),
      );
      const silent = loops.filter((node) => !reported.has(node.id)).map((node) => node.id);
      expect(silent).toEqual([]);
    });

    it("takes its inputs the way its trigger actually delivers them", () => {
      const triggerNode = definition.nodes.find((node) => node.type === "trigger");
      const schema = triggerNode?.type === "trigger" ? triggerNode.dataSchema : undefined;
      const inputPaths = referencedPaths(definition).filter(
        (segments) => segments[0] === "trigger" && segments[1] === "data",
      );

      if (template.schedule === undefined) {
        // A manual run reads its form values straight out of `trigger.data`,
        // so a field it reads has to be declared for the form to collect it.
        if (inputPaths.length > 0) expect(schema).toBeDefined();
        return;
      }

      // A scheduled run puts { scheduleName, cron, input } in `trigger.data`
      // and applies no dataSchema defaults, so a reference that survives
      // install reads null every night and nothing reports it. Install is
      // what removes it, and `unbakeable` lists every way that rewrite can
      // miss.
      const wrong: string[] = [];
      for (const segments of inputPaths) {
        const reason = unbakeableReason(segments, schema);
        if (reason !== null) wrong.push(`${segments.join(".")} — ${reason}`);
      }
      expect(wrong).toEqual([]);
    });

    it("labels every declared input", () => {
      const triggerNode = definition.nodes.find((node) => node.type === "trigger");
      if (triggerNode?.type !== "trigger" || triggerNode.dataSchema === undefined) return;
      const unlabelled = Object.entries(triggerNode.dataSchema)
        .filter(([, field]) => field.hidden !== true && (field.label === undefined || field.label === ""))
        .map(([name]) => name);
      expect(unlabelled).toEqual([]);
    });

    it("carries card copy the gallery can render", () => {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.category.length).toBeGreaterThan(0);
      expect(template.steps.length).toBeGreaterThan(0);
    });

    it("arms a schedule that parses", () => {
      if (template.schedule === undefined) return;
      const next = nextFireAt(template.schedule.cron, template.schedule.timezone ?? "UTC", Date.now());
      expect(next.ok ? null : next.error).toBeNull();
    });
  });
});

// ─── The install gate ────────────────────────────────────────────────────────

/**
 * A template's tool node is only usable when the credential the action READS
 * is a credential the connect flow can WRITE. Those two keys are computed by
 * different expressions — `ActionPlugin.credentialService ?? .service` for
 * the read, `CredentialDeclaration.service ?? plugin.name` for the write —
 * and when a plugin lets them drift, `credentialServiceFor` finds no
 * declaration, reports the service as not required, and the gallery offers
 * the template to somebody who can never run it. Every service a template
 * names must therefore be reported as required until the caller connects it.
 */
describe("template requirements", () => {
  const nothingConnected = new Set<string>();

  it.each(owned)("$template.id reports every service it needs", ({ definition }) => {
    const services = new Set(toolNodesOf(definition).map((node) => node.service));
    const required = templateRequirements(definition, actionPluginByService, nothingConnected);
    for (const service of services) {
      const entry = actionPluginByService.get(service);
      // A service with no credential declaration at all (the workflows
      // plugin's own actions) needs nothing connected, and is reported
      // connected on purpose.
      const declaresNothing = (entry?.plugin.credentials ?? []).length === 0;
      if (declaresNothing) continue;
      expect(required.find((r) => r.service === service)).toEqual(
        expect.objectContaining({ service, connected: false }),
      );
    }
  });

  it("flips a service to connected once the caller has it", () => {
    const assign = ownedById("github.assign-reviewers");
    const connected = new Set(["github", "google_calendar", "slack"]);
    const required = templateRequirements(assign.definition, actionPluginByService, connected);
    expect(required.filter((r) => !r.connected)).toEqual([]);
    // The calendar service is named by its READ key, which is the key the
    // connect flow writes as well.
    expect(required.map((r) => r.service).sort()).toEqual(["github", "google_calendar", "slack"]);
  });

  /**
   * A service the organization has not configured is not a service the
   * reader can connect: the integrations page hides it. The requirement
   * must therefore carry the two states apart, so the card can offer a
   * connect link for one and name the admin's setup for the other.
   */
  it("marks a service this organization has not configured", () => {
    // The digest reads Slack channel history, so Slack is its DATA and this
    // template cannot lose it. The two templates that used Slack only to
    // tell somebody something deliver through the orchestrator instead, and
    // the test below pins that they name no service for it.
    const digest = ownedById("workflows.daily-triage-digest");
    const required = templateRequirements(
      digest.definition,
      actionPluginByService,
      new Set(["github", "linear"]),
      new Set(["slack"]),
    );
    const slack = required.find((r) => r.service === "slack");
    expect(slack).toEqual({ service: "slack", connected: false, unconfigured: true });
    // Every other service stays as it was: an unconfigured one is reported,
    // not spread.
    expect(required.filter((r) => r.unconfigured === true).map((r) => r.service)).toEqual(["slack"]);
  });

  /**
   * `SERVICES_NOT_READY` (`templates.ts`) no longer names Slack, and this
   * template is the reason it was there: it restores the direct message
   * the original request asked for, on top of the orchestrator report that
   * covered for it while Slack was unavailable. A slack tool node removed
   * from the definition would put this template's own gap back, silently.
   */
  it("github.assign-reviewers needs Slack now, and still reports through the orchestrator too", () => {
    const { definition } = ownedById("github.assign-reviewers");
    const required = templateRequirements(definition, actionPluginByService, nothingConnected);
    expect(required.map((r) => r.service)).toContain("slack");
    expect(toolNodesOf(definition).map((node) => node.service)).toContain("slack");
    expect(definition.nodes.some((node) => node.type === "thread")).toBe(true);
  });
});

// ─── The addressing rule itself ──────────────────────────────────────────────

describe("dag/v1 template addressing", () => {
  const context: TemplateContext = {
    trigger: { type: "manual", timestamp: "2026-08-15T00:00:00.000Z", data: { q: "hello" }, metadata: {} },
    nodes: {
      think: { result: { text: "T", usage: {} }, output: { text: "T", usage: {} } },
      agent: {
        result: { sessionId: "s1", response: "R" },
        output: { sessionId: "s1", response: "R" },
      },
      loop: {
        result: { items: [], count: 0, inputCount: 7, truncatedCount: 2 },
        output: { items: [], count: 0, inputCount: 7, truncatedCount: 2 },
      },
    },
  };

  it("reads a trigger input under data, and nothing above it", () => {
    expect(renderTemplate("{{ trigger.data.q }}", context)).toBe("hello");
    expect(renderTemplate("{{ trigger.q }}", context)).toBeNull();
    expect(renderTemplate("{{ trigger.timestamp }}", context)).toBe("2026-08-15T00:00:00.000Z");
  });

  it("reads an llm node at result.text, through either alias", () => {
    expect(renderTemplate("{{ nodes.think.result.text }}", context)).toBe("T");
    expect(renderTemplate("{{ nodes.think.output.text }}", context)).toBe("T");
  });

  it("does not resolve the shapes v1 used", () => {
    expect(renderTemplate("{{ nodes.think.result.data }}", context)).toBeNull();
    expect(renderTemplate("{{ nodes.think.result.response }}", context)).toBeNull();
  });

  it("reads a session or orchestrator node at result.response", () => {
    expect(renderTemplate("{{ nodes.agent.result.response }}", context)).toBe("R");
    expect(renderTemplate("{{ nodes.agent.result.text }}", context)).toBeNull();
  });

  it("reads a foreach aggregate, truncation included", () => {
    expect(renderTemplate("{{ nodes.loop.result.inputCount }}", context)).toBe(7);
    expect(renderTemplate("{{ nodes.loop.result.truncatedCount }}", context)).toBe(2);
  });

  it("keeps the value's type in a single-expression field and stringifies in mixed text", () => {
    expect(renderTemplate("{{ nodes.loop.result.items }}", context)).toEqual([]);
    expect(renderTemplate("count: {{ nodes.loop.result.inputCount }}", context)).toBe("count: 7");
  });
});
