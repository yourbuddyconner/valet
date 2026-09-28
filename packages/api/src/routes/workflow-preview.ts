/**
 * `POST /api/workflows/:id/preview` — what each node would receive, before
 * the workflow runs.
 *
 * The dag/v1 template language has no undefined. `{{nodes.draft.result.text}}`
 * renders as `null` in a single-expression field and as `""` inside mixed
 * text, so a mistyped path produces a run that SUCCEEDS with wrong output.
 * This route resolves every path against real data and reports what came
 * back, which is the part authors get wrong and the part no run page can
 * show them until after the money is spent.
 *
 * Honesty is the whole design. Two rules hold it up:
 *
 *   1. A node is EXECUTED or DESCRIBED, never faked. Only the pure node
 *      types run: `trigger`, `set`, `if`, `stop`. They are run through the
 *      REAL executors against a throwaway in-memory store, so a preview and
 *      a run can never disagree about what a `set` produces or which branch
 *      an `if` takes. Every other type is described from its declared
 *      shape. Nothing that sends a prompt, calls an action, starts a
 *      session, or starts a child run is ever invoked.
 *   2. Every value names its source. `sample.fromRun` lists the nodes whose
 *      values came from a real run; `sample.fromPreview` lists the nodes
 *      this preview computed itself. A described node carries
 *      `describedReason` so nobody reads a shape as a result.
 *
 * The engine handed to the executors refuses every call (see
 * {@link refusingEngine}). That makes a side effect structurally
 * impossible rather than merely unintended: if a future node type joins the
 * executed set and does reach for the engine, the preview fails loudly
 * instead of, say, posting to Slack.
 */
import { Hono } from "hono";
import {
  InMemoryWorkflowStore,
  collectUnresolvedTemplatePaths,
  executeIf,
  executeSet,
  executeStop,
  executeTrigger,
  renderTemplate,
  resolveTriggerInput,
  triggerDataSchema,
  type NodeCheckpoint,
  type TemplateContext,
  type TriggerInputError,
  type WorkflowDefinition,
  type WorkflowEngineDeps,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowStore,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { AppEnv } from "../env.js";
import {
  ownedDefinitionRow,
  validateDefinitionInput,
  type WorkflowOwner,
} from "../workflows/service.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";
import type {
  PreviewField,
  PreviewNode,
  PreviewOutputShape,
  PreviewUnresolvedPath,
  PreviewWorkflowRequest,
  PreviewWorkflowResponse,
} from "../wire/types.js";

export const workflowPreviewRouter = new Hono<AppEnv>();

/** Runs scanned for sample data. A newer run with no completed node teaches
 * nothing, so the search falls through to the one behind it. */
const SAMPLE_RUN_SCAN = 5;

/** Reference paths listed per node. A wide result would otherwise bury the
 * one path the reader is looking for. */
const MAX_REFERENCE_PATHS = 24;

/** Depth walked when deriving reference paths from an observed result. */
const MAX_REFERENCE_DEPTH = 3;

/** Keys named when a path misses. Past this the reader is scanning, not reading. */
const MAX_AVAILABLE_KEYS = 20;

/** The built-in `foreach` ceiling (`nodes/foreach.ts` `DEFAULT_MAX_ITEMS`). */
const FOREACH_DEFAULT_MAX_ITEMS = 100;

/** Node types with no side effect, which this route runs for real. */
const EXECUTABLE_TYPES: ReadonlySet<string> = new Set(["trigger", "set", "if", "stop"]);

// ── Refusing engine ─────────────────────────────────────────────────────────

/**
 * A `WorkflowEngineDeps` whose every method throws.
 *
 * The four executed node types touch no engine method, so nothing here is
 * ever called on the happy path. It exists as a barrier: a preview must not
 * be able to reach the outside world even by mistake, and a throw is a
 * failed preview, not a sent message.
 */
function refusingEngine(): WorkflowEngineDeps {
  const refuse = (what: string): never => {
    throw new Error(
      `A preview does not ${what}. Start a run to do that, or read this node's described output shape instead.`,
    );
  };
  return {
    createSession: async () => refuse("create sessions"),
    prompt: async () => refuse("send prompts"),
    awaitResult: async () => refuse("wait for session results"),
    abort: async () => refuse("abort sessions"),
    isSettled: async () => refuse("read session state"),
    llmComplete: async () => refuse("call models"),
    promptOrchestrator: async () => refuse("prompt the orchestrator"),
    invokeAction: async () => refuse("call integration actions"),
    resolveWorkflow: async () => refuse("resolve other workflows"),
  };
}

// ── Sample data ─────────────────────────────────────────────────────────────

/** One node's slot in the template context, in the interpreter's shape. */
interface ContextNodeSlot {
  result?: unknown;
  output?: unknown;
  error?: string;
}

interface SampleData {
  trigger: WorkflowTriggerPayload;
  nodes: Record<string, ContextNodeSlot>;
  runId?: string;
  runCreatedAt?: number;
  fromRun: string[];
  inputErrors: TriggerInputError[];
  /** Trigger fields the caller supplied, which override the run's payload. */
  overrides: string[];
}

/**
 * The template context, in the shape `interpreter.ts`'s own
 * `buildTemplateContext` produces: `trigger` plus `nodes.<id>.result` and
 * its `output` alias. The two must agree, or a preview resolves paths a run
 * does not.
 */
function toTemplateContext(sample: SampleData): TemplateContext {
  return { trigger: sample.trigger, nodes: sample.nodes };
}

/**
 * Sample data for one preview: the newest run that produced anything, with
 * the caller's sample input laid over its trigger payload.
 *
 * A workflow that has never run still previews. It gets a synthetic trigger
 * payload built from the declared `dataSchema` defaults and the sample
 * input, which is exactly what a manual run would build.
 */
async function buildSample(
  store: WorkflowStore,
  workflowId: string,
  definition: WorkflowDefinition,
  request: PreviewWorkflowRequest,
): Promise<SampleData> {
  const resolved = resolveTriggerInput(triggerDataSchema(definition), request.input ?? {});
  const nodes: Record<string, ContextNodeSlot> = {};
  const fromRun: string[] = [];
  let runTrigger: WorkflowTriggerPayload | undefined;
  let runId: string | undefined;
  let runCreatedAt: number | undefined;

  const definedIds = new Set(definition.nodes.map((n) => n.id));

  if (request.sample !== "none") {
    const page = await store.listRuns({ workflowIds: [workflowId], limit: SAMPLE_RUN_SCAN });
    for (const run of page.runs) {
      const checkpoints = await store.getCheckpoints(run.runId);
      // Iteration 0 only, and only ids the definition still holds — the
      // same two filters `loadCheckpoints` applies in the interpreter. A
      // foreach body's per-item checkpoints are not addressable by
      // `nodes.<id>`, and a node deleted since that run would otherwise
      // make a dead path look like it resolves.
      const completed = checkpoints.filter(
        (cp) => cp.iteration === 0 && cp.status === "completed" && definedIds.has(cp.nodeId),
      );
      if (completed.length === 0) continue;
      for (const cp of completed) {
        nodes[cp.nodeId] = { result: cp.result, output: cp.result };
        fromRun.push(cp.nodeId);
      }
      runTrigger = triggerPayloadOf(completed, definition);
      runId = run.runId;
      runCreatedAt = run.createdAt;
      break;
    }
  }

  const trigger = layerInput(runTrigger, resolved.input);
  // The definition's own trigger node reads back as the payload too, so
  // `{{nodes.<triggerId>.result.data.x}}` resolves the same as
  // `{{trigger.data.x}}`. A run writes exactly this checkpoint.
  const triggerNode = definition.nodes.find((n) => n.type === "trigger");
  if (triggerNode) nodes[triggerNode.id] = { result: trigger, output: trigger };

  return {
    trigger,
    nodes,
    runId,
    runCreatedAt,
    fromRun: [...new Set(fromRun)],
    inputErrors: resolved.errors,
    overrides: Object.keys(request.input ?? {}),
  };
}

/** The run's trigger payload, read off the trigger node's own checkpoint. */
function triggerPayloadOf(
  completed: NodeCheckpoint[],
  definition: WorkflowDefinition,
): WorkflowTriggerPayload | undefined {
  const triggerNode = definition.nodes.find((n) => n.type === "trigger");
  const cp = triggerNode ? completed.find((c) => c.nodeId === triggerNode.id) : undefined;
  return isTriggerPayload(cp?.result) ? cp.result : undefined;
}

function isTriggerPayload(value: unknown): value is WorkflowTriggerPayload {
  return isRecord(value) && isRecord(value.data) && typeof value.type === "string";
}

/** The sample input laid over a run's payload — one field at a time, so a
 * caller who names one field keeps the rest of the real payload. */
function layerInput(
  base: WorkflowTriggerPayload | undefined,
  input: Record<string, unknown>,
): WorkflowTriggerPayload {
  if (!base) {
    return { type: "manual", timestamp: new Date().toISOString(), data: input, metadata: {} };
  }
  return { ...base, data: { ...base.data, ...input } };
}

// ── Template fields ─────────────────────────────────────────────────────────

interface TemplateSource {
  field: string;
  source: string;
}

/**
 * Every templated field on a node, as `field` → template text.
 *
 * The node's own JSON is walked and every string leaf holding `{{` is taken
 * as a template. A per-type field list would be the other option, and it is
 * the option that rots: a new field on a node type is a field the preview
 * silently stops reading. The renderer treats any `{{ ... }}` in any string
 * as a template, so this walk and the runtime agree by construction.
 *
 * A `foreach` body is skipped. It renders against per-iteration aliases
 * (`item`, `index`) that do not exist before the loop runs, so auditing it
 * here would report misses that are not real.
 */
export function collectTemplateFields(node: WorkflowNode): TemplateSource[] {
  const out: TemplateSource[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "id" || key === "type") continue;
    if (node.type === "foreach" && key === "body") continue;
    walkTemplates(out, key, value);
  }
  return out;
}

function walkTemplates(out: TemplateSource[], field: string, value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("{{")) out.push({ field, source: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, entry] of value.entries()) walkTemplates(out, `${field}[${i}]`, entry);
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) walkTemplates(out, `${field}.${key}`, entry);
  }
}

/**
 * `if` conditions read a bare expression, not `{{ ... }}`, so the walk above
 * never sees them. They are collected separately and reported as
 * `conditions[i].left`.
 */
function collectConditionFields(node: WorkflowNode): TemplateSource[] {
  if (node.type !== "if" || !Array.isArray(node.conditions)) return [];
  const out: TemplateSource[] = [];
  for (const [i, condition] of node.conditions.entries()) {
    const left = isRecord(condition) ? condition.left : undefined;
    if (typeof left !== "string" || left === "") continue;
    // Wrapped so one resolver reads both surfaces. `{{ ... }}` around a bare
    // expression changes nothing about which paths it dereferences.
    out.push({ field: `conditions[${i}].left`, source: `{{${left}}}` });
  }
  return out;
}

// ── Path diagnostics ────────────────────────────────────────────────────────

/**
 * Findings for the paths in one field that resolve to nothing.
 *
 * The unresolved paths come from the workflow package's own resolver
 * (`collectUnresolvedTemplatePaths`), so this route never decides for itself
 * what "resolves" means. The prefix walk below only adds the part a reader
 * needs next: how far the path DID get, and what was there.
 *
 * `packages/workflow/src/dag/path-diagnostics.ts` produces a richer finding
 * — a verified correction to write instead — but is not on the package's
 * public export surface. Route this through `diagnosePath` once it is.
 */
function diagnoseField(
  ctx: TemplateContext,
  source: TemplateSource,
): { unresolved: PreviewUnresolvedPath[]; paths: string[] } {
  const paths = collectUnresolvedTemplatePaths(source.source, ctx);
  const unresolved = paths.map((path) => {
    const walked = walkPrefix(ctx, path);
    return {
      path,
      field: source.field,
      resolvedPrefix: walked.prefix,
      availableKeys: walked.keys,
      message: missMessage(path, walked),
    };
  });
  return { unresolved, paths };
}

interface PrefixWalk {
  /** The longest leading part of the path that holds a value. */
  prefix: string;
  /** Keys at `prefix`. Empty when the value there holds no keys. */
  keys: string[];
  /** True when `prefix` holds a value that cannot be indexed at all. */
  leaf: boolean;
}

/**
 * How far a path gets before it stops resolving.
 *
 * Each prefix is resolved by rendering it, so the answer comes from the
 * same evaluator the run uses. A prefix that will not parse — a quoted or
 * bracketed segment, which the dotted form does not round-trip — ends the
 * walk, and the reader gets the last prefix that did work.
 */
function walkPrefix(ctx: TemplateContext, path: string): PrefixWalk {
  const segments = path.split(".");
  let prefix = "";
  let keys = Object.keys(ctx);
  let leaf = false;
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(0, i + 1).join(".");
    const value = renderOrUndefined(`{{${candidate}}}`, ctx);
    if (value === undefined || value === null) break;
    prefix = candidate;
    if (!isRecord(value) && !Array.isArray(value)) {
      keys = [];
      leaf = true;
      break;
    }
    keys = Array.isArray(value) ? value.map((_, index) => String(index)) : Object.keys(value);
  }
  return { prefix, keys: keys.slice(0, MAX_AVAILABLE_KEYS), leaf };
}

function missMessage(path: string, walked: PrefixWalk): string {
  const at = walked.prefix === "" ? "the template context" : `"${walked.prefix}"`;
  const head = `"${path}" resolved to nothing.`;
  const action = "Correct the path, or read it with exists(...) when the value is optional.";
  if (walked.leaf) {
    return `${head} ${at} holds a single value, so nothing can be read out of it. ${action}`;
  }
  if (walked.keys.length === 0) {
    return `${head} ${at} has no keys. ${action}`;
  }
  return `${head} Keys at ${at}: ${walked.keys.join(", ")}. ${action}`;
}

/** Renders a template, or `undefined` when it will not parse. A parse error
 * belongs to the validator; repeating it here would double the noise. */
function renderOrUndefined(source: string, ctx: TemplateContext): unknown {
  try {
    const value = renderTemplate(source, ctx);
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

// ── Output shape ────────────────────────────────────────────────────────────

/**
 * What a node produces, and the paths a downstream node reads it by.
 *
 * `observed` beats every other origin: when the sample run recorded a real
 * result for this node, the paths are read off that value and are therefore
 * exact. Only a node with no recorded result falls back to its declared
 * schema or to its type's documented result.
 */
function describeOutputShape(node: WorkflowNode, observed: ContextNodeSlot | undefined): PreviewOutputShape {
  if (observed && observed.result !== undefined) {
    return {
      origin: "observed",
      example: observed.result,
      paths: referencePaths(`nodes.${node.id}.result`, observed.result),
      note: "Read from this node's own result in the sample run.",
    };
  }
  return staticShape(node);
}

/** The paths that reach into `value`, rooted at `root`. */
function referencePaths(root: string, value: unknown): string[] {
  const out: string[] = [root];
  const visit = (prefix: string, current: unknown, depth: number): void => {
    if (out.length >= MAX_REFERENCE_PATHS || depth >= MAX_REFERENCE_DEPTH) return;
    if (Array.isArray(current)) {
      // One index stands for the whole list: the shape repeats, and listing
      // 100 rows would bury every other path on the node.
      if (current.length > 0) visit(`${prefix}[0]`, current[0], depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, entry] of Object.entries(current)) {
      if (out.length >= MAX_REFERENCE_PATHS) return;
      const path = `${prefix}.${key}`;
      out.push(path);
      visit(path, entry, depth + 1);
    }
  };
  visit(root, value, 0);
  return out;
}

/**
 * The result each node type produces, from the executors themselves.
 *
 * Every entry here is read off the executor that writes the checkpoint:
 * `llm.ts` `LlmResult`, `session.ts`/`orchestrator.ts` their two result
 * shapes, `foreach.ts` `ForeachResult`, `workflow-call.ts`
 * `WorkflowCallResult`, `approval.ts` `ApprovalResult`, `wait.ts`
 * `WaitResult`. The two families name their text differently — an `llm`
 * node produces `text`, a `session` or `orchestrator` node produces
 * `response` — and writing one for the other is the single most common way
 * to get an empty value out of a successful run.
 *
 * Exported because this table IS the preview's contract with the node
 * types. It has to be checkable on its own when an executor's result shape
 * changes.
 */
export function staticShape(node: WorkflowNode): PreviewOutputShape {
  const root = `nodes.${node.id}.result`;
  switch (node.type) {
    case "llm": {
      const paths = [`${root}.text`, ...schemaPaths(`${root}.output`, node.outputSchema)];
      return {
        origin: node.outputSchema ? "declared" : "known",
        example: { text: "the model's reply", ...(node.outputSchema ? { output: {} } : {}) },
        paths,
        note: node.outputSchema
          ? "The structured fields live under `output`, not at the top of the result."
          : "This node declares no outputSchema, so it produces text only. Add an outputSchema to read named fields.",
      };
    }
    case "session":
    case "thread": {
      const dispatchOnly = node.wait?.mode === "none";
      const threadFields = node.type === "thread" ? { threadId: "thr_..." } : {};
      const threadPaths = node.type === "thread" ? [`${root}.threadId`] : [];
      if (dispatchOnly) {
        return {
          origin: "known",
          example: { sessionId: "ses_...", ...threadFields, receipt: { threadId: "thr_...", queueItemId: "q_..." } },
          paths: [`${root}.sessionId`, ...threadPaths],
          note: "wait.mode is 'none', so this node completes at dispatch and produces no response. Set wait.mode to 'until_idle' to read what the session returns.",
        };
      }
      const paths = [`${root}.sessionId`, ...threadPaths, `${root}.response`, ...schemaPaths(`${root}.output`, node.outputSchema)];
      return {
        origin: node.outputSchema ? "declared" : "known",
        example: { sessionId: "ses_...", ...threadFields, response: "the session's reply" },
        paths,
        note: "A session or thread node names its text `response`. An llm node names it `text`.",
      };
    }
    case "tool":
      return {
        origin: "unknown",
        paths: [root],
        note: `The shape is whatever ${node.service}.${node.action} returns. Run this node once to see it, then read the observed paths.`,
      };
    case "workflow":
      return {
        origin: "known",
        example: { runId: "wfr_...", output: {} },
        paths: [`${root}.runId`, `${root}.output`],
        note: "`output` is the child run's own output.",
      };
    case "foreach":
      return {
        origin: "known",
        example: { items: [{ status: "completed", data: {} }], count: 0, inputCount: 0 },
        paths: [`${root}.items`, `${root}.items[0].data`, `${root}.count`, `${root}.failedCount`],
        note: "Each item's body result is under `data`, not on the item itself.",
      };
    case "approval":
      return {
        origin: "known",
        example: { approved: true, resolvedBy: "usr_..." },
        paths: [`${root}.approved`, `${root}.resolvedBy`],
        note: "A person decides this. A preview cannot.",
      };
    case "wait":
      return {
        origin: "known",
        example: { wakeAt: 0 },
        paths: [`${root}.wakeAt`],
      };
    case "if":
      return {
        origin: "known",
        example: { result: true, matched: [0], combinator: "and" },
        paths: [`${root}.result`, `${root}.matched`],
        note: "Edges out of an if node select on `fromOutput`, not on this path.",
      };
    case "stop":
      return {
        origin: "known",
        example: { outcome: "success", output: {}, message: "" },
        paths: [`${root}.outcome`, `${root}.output`],
        note: "The run ends here. Nothing downstream of this node runs.",
      };
    case "set":
      return { origin: "known", paths: [root] };
    case "trigger":
      return {
        origin: "known",
        paths: [`${root}.data`, "trigger.data"],
        note: "Trigger fields live under `data`: write `trigger.data.<field>`, not `trigger.<field>`.",
      };
  }
}

/** `root.<field>` for each property a JSON-schema `outputSchema` declares. */
function schemaPaths(root: string, schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  const properties = schema.properties;
  if (!isRecord(properties)) return [root];
  return Object.keys(properties).map((key) => `${root}.${key}`);
}

// ── Node preview ────────────────────────────────────────────────────────────

/** Why a node type cannot be previewed by running it. */
function describedReason(node: WorkflowNode): string {
  switch (node.type) {
    case "llm":
      return `Running this would call ${node.model} and bill for it.`;
    case "tool":
      return `Running this would call ${node.service}.${node.action} for real.`;
    case "session":
      return "Running this would start a session.";
    case "thread":
      return "Running this would send a prompt to the workspace thread.";
    case "workflow":
      return "Running this would start a child run.";
    case "approval":
      return "This node waits for a person to decide.";
    case "wait":
      return "This node waits for time to pass.";
    case "foreach":
      return "The loop body has side effects. Its items expression is resolved below.";
    default:
      // Only the pure types reach here, and they are executed. So this
      // reads exactly when one of their templates could not be parsed.
      return "A template on this step could not be read, so the preview did not run it.";
  }
}

/**
 * Facts about the resolved values that change what the node does, and that
 * a resolved-value list alone would not say.
 */
function collectWarnings(node: WorkflowNode, ctx: TemplateContext, sample: SampleData): string[] {
  const warnings: string[] = [];
  if (node.type === "trigger" && sample.overrides.length > 0 && sample.runId !== undefined) {
    warnings.push(
      `These fields come from the sample input, not from run ${sample.runId}: ${sample.overrides.join(", ")}.`,
    );
  }
  if (node.type === "foreach") {
    const items = renderOrUndefined(node.items, ctx);
    if (!Array.isArray(items)) {
      warnings.push(
        `items resolved to ${describeType(items)}, not a list, so this node would fail before any iteration. ` +
          "A node output only iterates when that node declares an outputSchema.",
      );
    } else {
      const ceiling = node.maxItems ?? FOREACH_DEFAULT_MAX_ITEMS;
      warnings.push(`items resolved to ${items.length} item(s).`);
      if (items.length > ceiling) {
        warnings.push(
          `${items.length - ceiling} item(s) would be dropped at the ceiling of ${ceiling}. ` +
            "Raise maxItems, or narrow the items expression.",
        );
      }
    }
  }
  if ((node.type === "session" || node.type === "thread") && node.wait?.mode === "none") {
    warnings.push(
      "wait.mode is 'none', so this node does not wait for the session. Downstream reads of `response` resolve to nothing.",
    );
  }
  return warnings;
}

function describeType(value: unknown): string {
  if (value === undefined || value === null) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "an object";
  return `a ${typeof value}`;
}

/** Everything the preview can say about one node. */
async function previewNode(
  node: WorkflowNode,
  ctx: TemplateContext,
  sample: SampleData,
  store: WorkflowStore,
  run: WorkflowRun,
  attempt: number,
): Promise<PreviewNode> {
  const sources = [...collectTemplateFields(node), ...collectConditionFields(node)];
  const fields: PreviewField[] = [];
  const unresolved: PreviewUnresolvedPath[] = [];
  let error: string | undefined;

  for (const source of sources) {
    const diagnosis = diagnoseField(ctx, source);
    unresolved.push(...diagnosis.unresolved);
    let resolved: unknown;
    try {
      resolved = renderTemplate(source.source, ctx);
    } catch (err) {
      // A template that will not parse is a save-time validation error. The
      // preview reports it rather than resolving around it.
      error = err instanceof Error ? err.message : String(err);
    }
    fields.push({
      field: source.field,
      source: source.source,
      resolved,
      unresolvedPaths: diagnosis.paths,
    });
  }

  const observed = sample.nodes[node.id];
  const preview: PreviewNode = {
    nodeId: node.id,
    type: node.type,
    fidelity: "described",
    describedReason: describedReason(node),
    fields,
    unresolved,
    outputShape: describeOutputShape(node, observed),
    warnings: collectWarnings(node, ctx, sample),
    ...(error !== undefined ? { error } : {}),
  };

  if (error !== undefined || !EXECUTABLE_TYPES.has(node.type)) return preview;

  const executed = await executePure(node, ctx, store, run, attempt);
  if (executed.error !== undefined) {
    return { ...preview, error: executed.error };
  }
  return {
    ...preview,
    fidelity: "executed",
    describedReason: undefined,
    output: executed.output,
    outputShape: {
      origin: "observed",
      example: executed.output,
      paths: referencePaths(`nodes.${node.id}.result`, executed.output),
      note: "This node has no side effect, so the preview ran it. This is its real output.",
    },
    warnings: [...preview.warnings, ...executed.warnings],
  };
}

interface PureResult {
  output?: unknown;
  warnings: string[];
  error?: string;
}

/**
 * Runs one pure node through its REAL executor.
 *
 * The executor writes its checkpoints to the throwaway store this request
 * owns, and reads its engine from {@link refusingEngine}. Reusing the
 * executor rather than re-deriving what it computes is the point: an `if`
 * node's comparison tables are long, and a second copy of them would
 * eventually disagree with the one that decides real branches.
 */
async function executePure(
  node: WorkflowNode,
  ctx: TemplateContext,
  store: WorkflowStore,
  run: WorkflowRun,
  attempt: number,
): Promise<PureResult> {
  const base = {
    run,
    attempt,
    iteration: 0,
    templateContext: ctx,
    store,
    clock: () => Date.now(),
    engine: refusingEngine(),
  };
  try {
    switch (node.type) {
      case "trigger": {
        const result = await executeTrigger({ ...base, node });
        return { output: resultOf(result), warnings: [] };
      }
      case "set": {
        const result = await executeSet({ ...base, node });
        return { output: resultOf(result), warnings: [] };
      }
      case "if": {
        const result = await executeIf({ ...base, node });
        return { output: resultOf(result), warnings: [branchWarning(result)] };
      }
      case "stop": {
        const result = await executeStop({ ...base, node });
        const warnings = ["The run ends at this node. Nothing downstream of it runs."];
        if (result.status === "failed") warnings.push(`The run would end failed: ${result.error}`);
        return { output: resultOf(result), warnings };
      }
      default:
        return { warnings: [], error: `Node type "${node.type}" is not executed in a preview.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { warnings: [], error: message };
  }
}

/** The checkpoint value out of an executor result, whatever its status. */
function resultOf(result: { status: string; result?: unknown }): unknown {
  return result.result;
}

/** Which edges an `if` node's real output activates. */
function branchWarning(result: { status: string; result?: unknown }): string {
  const value = result.result;
  const taken = isRecord(value) && value.result === true;
  return taken
    ? "Conditions pass. Edges with fromOutput 'true' activate."
    : "Conditions fail. Edges with fromOutput 'false' activate.";
}

// ── Node ordering ───────────────────────────────────────────────────────────

/**
 * Definition nodes in an order where a node follows the nodes it reads.
 *
 * A preview chains: an executed pure node's real output enters the context
 * for the nodes after it, which is what lets a brand-new workflow preview
 * anything downstream of its first `set`. That only holds if the nodes are
 * previewed in edge order. Nodes in a cycle, or with edges the compiler
 * would reject, keep definition order at the end — a preview must still
 * answer for a definition that does not yet run.
 */
export function orderNodes(definition: WorkflowDefinition): WorkflowNode[] {
  const remaining = new Map(definition.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, Set<string>>();
  for (const node of definition.nodes) incoming.set(node.id, new Set());
  for (const edge of definition.edges) {
    if (!remaining.has(edge.from) || !remaining.has(edge.to)) continue;
    incoming.get(edge.to)?.add(edge.from);
  }
  const ordered: WorkflowNode[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of definition.nodes) {
      if (!remaining.has(node.id)) continue;
      const deps = incoming.get(node.id);
      if (deps && [...deps].some((from) => remaining.has(from))) continue;
      ordered.push(node);
      remaining.delete(node.id);
      progressed = true;
    }
  }
  return [...ordered, ...remaining.values()];
}

// ── Route ───────────────────────────────────────────────────────────────────

workflowPreviewRouter.post("/:id/preview", async (c) => {
  const { db, workflowStore, actionPluginByService } = c.var.providers;
  const owner: WorkflowOwner = { userId: c.var.user.id, orgId: c.var.user.orgId, principal: c.var.principal };
  const workflowId = c.req.param("id");

  let body: PreviewWorkflowRequest;
  try {
    body = (await c.req.json()) as PreviewWorkflowRequest;
  } catch {
    // An empty body is a legitimate preview: the stored definition against
    // the last run, with no sample input.
    body = {};
  }

  const row = await ownedDefinitionRow(db, owner, workflowId);
  if (!row) return c.json({ error: "workflow not found" }, 404);

  const source = body.definition ?? row.definition;
  const validation = validateDefinitionInput(source, buildValidateEnvironment(actionPluginByService));
  if (!validation.ok) {
    return c.json(
      { error: "invalid workflow definition", errors: validation.errors },
      400,
    );
  }
  const definition = validation.definition;

  if (body.nodeId !== undefined && !definition.nodes.some((n) => n.id === body.nodeId)) {
    return c.json(
      { error: `no node "${body.nodeId}" in this definition. Send a node id from the definition, or omit nodeId to preview every node.` },
      400,
    );
  }

  const sample = await buildSample(workflowStore, workflowId, definition, body);
  const context = toTemplateContext(sample);

  // A throwaway store, discarded with the request. The executors below need
  // a claimed run to write their checkpoints against; nothing reads them.
  const previewStore = new InMemoryWorkflowStore();
  const runId = `preview:${workflowId}`;
  const run = await previewStore.createRun(
    runId,
    { workflowId, definitionVersionId: "preview", input: sample.trigger },
    definition,
    "preview",
  );
  const claim = await previewStore.claimRun(runId, "preview", 60_000);
  const attempt = claim?.attempt ?? 1;

  const nodes: PreviewNode[] = [];
  const fromPreview: string[] = [];
  for (const node of orderNodes(definition)) {
    const result = await previewNode(node, context, sample, previewStore, run, attempt);
    // Every node is previewed even when the caller asked for one: a node's
    // inputs come from the nodes before it, so the ones upstream still have
    // to run. Only the reply is narrowed.
    if (body.nodeId === undefined || body.nodeId === node.id) nodes.push(result);
    // An executed node's real output feeds the nodes after it, but never
    // replaces a value the sample run actually recorded.
    if (result.fidelity === "executed" && !sample.fromRun.includes(node.id)) {
      sample.nodes[node.id] = { result: result.output, output: result.output };
      if (node.type !== "trigger") fromPreview.push(node.id);
    }
  }

  const response: PreviewWorkflowResponse = {
    sample: {
      kind: sample.runId === undefined ? "sample_only" : "last_run",
      ...(sample.runId !== undefined ? { runId: sample.runId } : {}),
      ...(sample.runCreatedAt !== undefined ? { runCreatedAt: sample.runCreatedAt } : {}),
      fromRun: sample.fromRun,
      fromPreview,
      inputErrors: sample.inputErrors,
    },
    nodes,
  };
  return c.json(response);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
