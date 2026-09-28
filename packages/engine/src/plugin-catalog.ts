import { IsObject, ObjectOptions, Type } from "typebox";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import { matchesSearchQuery, parseSearchQuery, rankSearchResults } from "@valet/shared";
import { builtinTools } from "./builtin-tools/index.js";
import type {
  CredentialProvider,
  DecisionAction,
  DecisionGateRequest,
  DecisionResolution,
  PolicyDecision,
  PolicyInvocationRecord,
  PolicyResolveInput,
  PolicyResolver,
  RiskLevel,
  ToolAttachment,
  ToolContext,
  ToolDef,
  ToolResult,
} from "./types.js";
import { isDecisionGateExpired } from "./decision-gate.js";
import { encodeToolOutput } from "./tool-output.js";

/**
 * Plugin catalog: indirection layer that exposes plugin actions to the LLM
 * through two engine-built-in tools — `list_tools` and `call_tool` — rather
 * than registering one Anthropic-visible tool per action.
 *
 * Why the indirection: Anthropic enforces a tool-name regex of
 * ^[a-zA-Z0-9_-]{1,128}$ (so dotted ids like `github.create_issue` are
 * rejected as tool names but fine as string args), and even with name
 * sanitization, dozens of plugins × dozens of actions blows the LLM's
 * tool-catalog budget. The agent uses list_tools to discover and
 * call_tool to invoke; only the actions in active use pay any prompt cost.
 *
 * This module owns the canonical engine-native plugin shape. It does NOT
 * accept the legacy @valet/sdk Zod-based ActionSource — plugins must emit
 * the engine-native shape (TypeBox parameters, ToolContext-derived
 * ActionContext, ToolAttachment-typed result attachments).
 *
 * PINNED ACTIONS. The indirection has one cost: an action the agent must
 * use on almost every turn is not in the tool list, so the agent can
 * describe the change and never make it. `PluginCatalogOptions.pins` lets
 * the HOST promote a small, fixed set of action ids to direct tools. A
 * pinned tool is a thin wrapper — it calls the same {@link invokeAction}
 * that `call_tool` calls — so the approval gate, the argument validation
 * and the audit record stay identical on both routes. A pinned tool
 * publishes the action's own schema plus one optional `summary` argument,
 * which is the sentence `call_tool` also asks for; the summary is stripped
 * before validation, so the two routes agree about what the action accepts.
 * Pinning is opt-in: with no pins the tool list is exactly
 * `[list_tools, call_tool]`.
 */

// ── Plugin shapes ─────────────────────────────────────────────────

/**
 * One LLM-callable action exposed by a plugin. Parameters are TypeBox
 * schemas — pi-ai/Anthropic both consume JSON Schema directly, so no
 * conversion step is needed at runtime.
 */
export interface PluginAction<TParams extends TSchema = TSchema> {
  /** Fully-qualified id, e.g. "github.create_issue". Stays untouched as a tool_id arg. */
  id: string;
  /** Human-readable label, surfaced in approval gates and catalog listings. */
  name: string;
  description: string;
  riskLevel: RiskLevel;
  parameters: TParams;
  execute: (
    args: Static<TParams>,
    ctx: PluginActionContext,
  ) => Promise<PluginActionResult>;
}

/**
 * Context passed into a plugin action. Inherits everything from
 * `ToolContext` (userId, orgId, sessionId, threadId, sandbox, signal,
 * credentials, requestDecision, etc.) plus plugin-specific fields.
 */
export interface PluginActionContext extends ToolContext {
  /** The fully-qualified action id being invoked (mirrors PluginAction.id). */
  actionId: string;
  /** The plugin service this action belongs to (e.g. "github"). */
  service: string;
  /**
   * Caller-supplied summary string from the call_tool invocation. Used in
   * approval gate bodies and audit logs. Empty when the action is invoked
   * outside the catalog flow.
   */
  summary?: string;
}

export interface PluginActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Attachments to inject into the LLM's vision context or store via BlobStore. */
  attachments?: ToolAttachment[];
}

export type ApprovalMode = "allow" | "require_approval" | "deny";

/**
 * The unit of plugin registration. A plugin emits one ActionPlugin per
 * service it exposes; the engine assembles them into a catalog.
 */
export interface ActionPlugin {
  /** Service id (e.g. "github"). Used as the credential service name and as a routing key. */
  service: string;
  description?: string;
  actions: PluginAction[];
  /** Override credential service name (defaults to `service`). */
  credentialService?: string;
  /**
   * The plugin's actions are unusable without a connected credential.
   * When set and no credential resolves, `list_tools` HIDES this
   * service's tools from unfiltered listings (with a warning naming the
   * fix) — advertising tools that can only fail wastes the agent's turn.
   * An explicit `service:` filter still returns them, so the agent can
   * inspect schemas while asking the user to connect. Leave unset for
   * credential-less plugins (e.g. workflows), which are never probed.
   */
  requiresCredential?: boolean;
  /**
   * Default approval policy. Unset = derived from each action's riskLevel:
   * low/medium → allow; high/critical → require_approval.
   */
  defaultApprovalMode?: ApprovalMode;
  /**
   * Dynamic action discovery seam for MCP-proxy-style plugins whose action
   * list isn't known statically (e.g. depends on what an upstream MCP
   * server advertises for the connected credential). MUST be idempotent —
   * the catalog may call it repeatedly (subject to the TTL cache) — and MAY
   * throw; callers (list_tools/call_tool) turn a throw into a warning or
   * error string rather than propagating it to the LLM turn. Called with a
   * credential provider scoped to this plugin's `credentialService` (or
   * `service` when unset), matching the scoping `call_tool` gives to
   * `execute`.
   */
  resolveActions?: (ctx: { credentials: CredentialProvider }) => Promise<PluginAction[]>;
}

/**
 * One host request to expose a plugin action as a direct, Anthropic-visible
 * tool, in addition to reaching it through `call_tool`.
 */
export interface PinnedActionSpec {
  /**
   * Fully-qualified action id, e.g. "workflows.patch_workflow". It must be
   * lowercase `service.action_name` — see {@link pinnedToolName} for the
   * accepted shape and why it is restricted.
   */
  actionId: string;
  /**
   * Host text appended to the action's own description on the PINNED tool
   * only. Use it for the rule the agent must not forget, e.g. that a change
   * it described but did not apply is not a change. The tool catalog is
   * rebuilt and re-sent on every turn, so text here cannot decay the way a
   * first-turn user message does.
   */
  guidance?: string;
}

/** Why one pin was refused. The host logs this text, so it names the fix. */
export type PinRejectedHandler = (actionId: string, reason: string) => void;

export type ServiceAvailabilityState =
  | "available"
  | "not_connected"
  | "deployment_unconfigured"
  | "disabled_by_org"
  | "load_failed";

export interface ServiceAvailability {
  service: string;
  state: ServiceAvailabilityState;
  reason: string;
  fix?: string;
}

export interface PluginCatalogAvailabilityOptions {
  /** Build-time snapshot used only for the compact tool description. */
  serviceAvailability?: readonly ServiceAvailability[];
  /** Live inventory read. A service narrows the check without caching permissions. */
  resolveServiceAvailability?: (service?: string) =>
    | readonly ServiceAvailability[]
    | Promise<readonly ServiceAvailability[]>;
}

export interface PluginCatalogOptions extends PluginCatalogAvailabilityOptions {
  plugins: ActionPlugin[];
  /** Native tools are outside this integration-action catalog. */
  nativeToolNames?: readonly string[];
  /** Clock used for the dynamic-action-resolution TTL cache. Default: Date.now. */
  clock?: () => number;
  /**
   * Actions to also expose as direct tools. Omit for the default behavior:
   * the tool list stays exactly `[list_tools, call_tool]`.
   */
  pins?: readonly PinnedActionSpec[];
  /**
   * Tool names the CALLER adds after this function returns (the api appends
   * a `skill` tool). A pin whose mapped name hits one of these is refused —
   * nothing dedupes tool names further down, so a collision would ship two
   * same-named tools to the provider.
   */
  reservedToolNames?: readonly string[];
  /**
   * Called once for each refused pin. A refused pin is never fatal: the
   * action stays reachable through `list_tools`/`call_tool`, exactly as it
   * was before the pin was asked for.
   */
  onPinRejected?: PinRejectedHandler;
}

/**
 * Ceiling on how many actions one catalog may pin.
 *
 * A pinned action publishes its full parameter schema on every request.
 * That is the budget the list_tools/call_tool indirection exists to
 * protect, so the budget is bounded by code rather than by convention —
 * a host list that grows past this refuses the extra entries instead of
 * quietly spending the prompt.
 */
export const MAX_PINNED_ACTIONS = 8;

/**
 * The accepted shape of a pinnable action id: lowercase alphanumeric
 * segments, joined by single underscores, in exactly two dot-separated
 * halves.
 */
const PIN_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Longest pinnable id. The transform adds one character, and Anthropic
 * caps a tool name at 128.
 */
const PIN_ID_MAX_LENGTH = 126;

/**
 * Maps a fully-qualified action id to an Anthropic-legal tool name, or
 * returns undefined when the id cannot be mapped.
 *
 * Anthropic enforces ^[a-zA-Z0-9_-]{1,128}$ on a tool name, so the dot must
 * go. The replacement is a double underscore, and the id shape above makes
 * that mapping reversible: no segment contains `__` (segments are joined by
 * SINGLE underscores) and no segment starts or ends with `_`, so the
 * inserted `__` is the only `__` in the result. Two different ids therefore
 * cannot map to one name.
 *
 * The shape is deliberately narrower than what a plugin may declare. An
 * MCP-proxy plugin builds its ids from an upstream server's tool names, so
 * `linear.create-issue` or an uppercase name is possible; those ids are
 * refused rather than mangled into a name that could collide.
 */
export function pinnedToolName(actionId: string): string | undefined {
  if (actionId.length > PIN_ID_MAX_LENGTH) return undefined;
  if (!PIN_ID_PATTERN.test(actionId)) return undefined;
  // The pattern permits exactly one dot, so a first-occurrence replace is
  // the whole transform.
  return actionId.replace(".", "__");
}

/** TTL for the dynamic `resolveActions` cache, keyed per plugin service. */
export const RESOLVE_TTL_MS = 300_000;

/**
 * Applies TypeBox `Value.Default` to a cloned copy of `params`, then
 * validates the result against `schema`. Returns the defaulted+validated
 * args on success, or a compact error string (first 3 Value.Errors paths)
 * on failure. Used by `call_tool` to validate LLM-supplied params before
 * they reach a plugin action's `execute` body, and reused by Task 6's
 * ActionInvoker for the same purpose outside the catalog flow.
 */
export function prepareActionArgs(
  schema: TSchema,
  params: Record<string, unknown> | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  // Value.Default's return type is `unknown` by design (see typebox docs) —
  // callers are expected to Check before use, which we do immediately below.
  const withDefaults = Value.Default(schema, structuredClone(params ?? {})) as Record<
    string,
    unknown
  >;
  if (Value.Check(schema, withDefaults)) {
    return { ok: true, args: withDefaults };
  }
  const errors = [...Value.Errors(schema, withDefaults)].slice(0, 3);
  const detail = errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
  return { ok: false, error: detail || "params did not match the schema" };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Opaque catalog handle shared by the call_tool tool path and the
 * slash-command path. Build it once with {@link buildPluginCatalog}, then
 * pass it to {@link pluginCatalogTools} (LLM tool path) and/or hold it for
 * {@link invokeAction} (slash-command path). Its internals — the id index and
 * the dynamic-resolution TTL cache — stay private to this module.
 */
export type PluginCatalog = Catalog;

/**
 * Assemble an in-memory catalog from every ActionPlugin in `plugins`.
 * Both the LLM `call_tool` path and the slash-command path route through
 * the SAME catalog so approval policy and arg validation stay identical.
 */
export function buildPluginCatalog(
  plugins: ActionPlugin[],
  clock?: () => number,
  availability: PluginCatalogAvailabilityOptions = {},
): PluginCatalog {
  return buildCatalog(plugins, clock ?? Date.now, availability);
}

/**
 * Build the [list_tools, call_tool] pair backed by an in-memory catalog
 * assembled from every ActionPlugin in `opts.plugins`, plus one direct tool
 * for each accepted entry of `opts.pins`.
 *
 * With no pins the result is exactly the two catalog tools, in that order.
 */
export function pluginCatalogTools(opts: PluginCatalogOptions): ToolDef[] {
  const now = opts.clock ?? Date.now;
  const catalog = buildCatalog(opts.plugins, now, opts);
  const pinned = resolvePins(catalog, opts);
  return [makeListTool(catalog, pinned.nameByActionId, opts), makeCallTool(catalog), ...pinned.tools];
}

/**
 * Outcome of {@link invokeAction}. The tool path and the slash-command path
 * both consume this and render it into their own transport shape
 * (`ToolResult` text vs. a `command_result` markdown output).
 */
export type InvokeActionResult =
  | { kind: "ok"; result: PluginActionResult }
  | { kind: "unknown"; toolId: string }
  | { kind: "invalid-args"; error: string }
  | { kind: "denied-policy"; scope?: "team" }
  | { kind: "denied-approval"; reason?: "approval-processing-failed" }
  | { kind: "expired-approval" }
  | { kind: "pending-approval" }
  | { kind: "missing-credential"; service: string }
  | {
      kind: "service-unavailable";
      service: string;
      state: ServiceAvailabilityState;
      reason: string;
      fix?: string;
    }
  | { kind: "error"; message: string }
  | { kind: "resolve-failed"; service: string; message: string };

/**
 * The executable core shared by `call_tool` and the slash-command path:
 * look up the action, apply approval policy (deny / require_approval via
 * `ctx.requestDecision`), validate + default the args, then run the
 * action's `execute`. Never duplicated — the call_tool tool wraps this and
 * renders `InvokeActionResult` into a `ToolResult`, and the command path
 * renders it into a `command_result` entry.
 *
 * `args` are the caller-supplied parameters (already mapped from CLI args on
 * the command path, or the LLM-supplied `params` on the tool path).
 * `summary` is the approval-gate body line.
 */
/**
 * Request an approval decision, treating gate expiry as a terminal outcome.
 * A propagated expiry throw surfaces to the model as a retryable tool error;
 * the model then re-issues the call, which used to mint a fresh 72h gate on
 * every retry. Withdrawal still propagates — it unwinds an aborted or
 * steered turn and must not reach the model as a result.
 */
async function requestApprovalDecision(
  ctx: ToolContext,
  req: DecisionGateRequest,
): Promise<
  | { kind: "resolved"; resolution: DecisionResolution }
  | { kind: "expired"; gateOrdinal?: number }
> {
  try {
    return { kind: "resolved", resolution: await ctx.requestDecision(req) };
  } catch (err) {
    // Carry the expired gate's ordinal into the audit record — the policy
    // sink derives its deterministic invocation id from it.
    if (isDecisionGateExpired(err)) return { kind: "expired", gateOrdinal: err.ordinal };
    throw err;
  }
}

/**
 * The typed view of the context `approvalGateRequest` stamps on a tool
 * approval gate. `DecisionGate.context` is an untyped record in the store,
 * so readers (the api's channel gate digest) narrow through
 * {@link toolApprovalGateContext} instead of sniffing raw keys — writer and
 * reader then share this one definition and cannot silently drift.
 */
export interface ToolApprovalGateContext {
  toolId: string;
  riskLevel?: string;
  service?: string;
  args?: Record<string, unknown>;
  summary?: string;
}

/** Narrow a gate's context to {@link ToolApprovalGateContext}; `null` when
 * the gate is not a tool approval (e.g. `ask_approval`, question gates). */
export function toolApprovalGateContext(
  context: Record<string, unknown> | undefined,
): ToolApprovalGateContext | null {
  if (!context || typeof context.tool_id !== "string") return null;
  const args = context.args;
  return {
    toolId: context.tool_id,
    riskLevel: typeof context.riskLevel === "string" ? context.riskLevel : undefined,
    service: typeof context.service === "string" ? context.service : undefined,
    args: args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined,
    summary: typeof context.summary === "string" ? context.summary : undefined,
  };
}

/**
 * The shared head of the approval-gate request both invokeAction paths open.
 * `dedupeKey` is the qualified tool id: terminal outcomes stick per tool id,
 * not per (tool id, args) — a re-issued call with tweaked args must not
 * dodge a deny/expiry. Safe for the prefix rule because every approval
 * resumeKey is `${qualifiedId}:<argsHash>`.
 */
function approvalGateRequest(
  entry: CatalogEntry,
  actionId: string,
  args: Record<string, unknown> | undefined,
  summary: string,
  resumeKey: string,
): DecisionGateRequest {
  return {
    type: "approval",
    title: `Approve ${entry.action.name}?`,
    body: `${summary}\n\ntool_id=${actionId}\nargs=${stableJson(args ?? {})}`,
    resumeKey,
    dedupeKey: qualifiedId(entry),
    context: {
      riskLevel: entry.action.riskLevel,
      service: entry.service,
      tool_id: actionId,
      args,
      // The one-line human summary, separate from the machine-readable body
      // above. Channel deliverers render it instead of the tool_id/args dump.
      summary,
    },
  };
}

export async function invokeAction(
  catalog: PluginCatalog,
  actionId: string,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext,
  summary: string,
): Promise<InvokeActionResult> {
  let availabilityCheckedService: string | undefined;
  const dotIdx = actionId.indexOf(".");
  if (dotIdx > 0) {
    const prefix = actionId.slice(0, dotIdx);
    const availability = await checkServiceAvailability(
      catalog,
      prefix,
      serviceRequiresCredential(catalog, prefix),
    );
    const outcome = availabilityOutcome(availability);
    if (outcome) return outcome;
    availabilityCheckedService = prefix;
  }

  let entry = catalog.byId.get(actionId);
  if (!entry && availabilityCheckedService) {
    const plugin = catalog.dynamicPlugins.find((p) => p.service === availabilityCheckedService);
    if (plugin) {
      try {
        const resolvedDyn = await resolveDynamic(catalog, plugin, ctx);
        entry = resolvedDyn.byId.get(actionId);
      } catch (err) {
        return {
          kind: "resolve-failed",
          service: availabilityCheckedService,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  if (!entry) return { kind: "unknown", toolId: actionId };

  if (availabilityCheckedService !== entry.service) {
    const availability = await checkServiceAvailability(
      catalog,
      entry.service,
      entry.plugin.requiresCredential === true,
    );
    const outcome = availabilityOutcome(availability);
    if (outcome) return outcome;
  }

  const resolver = ctx.policyResolver;
  // Deterministic per-(tool_id, args) key — identical to the resumeKey handed
  // to ctx.requestDecision when a gate opens for this call. Recorded on every
  // audit record (even allow/deny, which never open a gate) so a host sink
  // can correlate all records for one (tool, args) pair. Large args hash into
  // a bounded suffix: the key is embedded in the engine_decision_gates and
  // action_invocations primary keys, and Postgres btree index rows cap at
  // ~2704 bytes.
  const resumeKey = `${qualifiedId(entry)}:${boundedArgsKey(stableJson(args ?? {}))}`;

  // ── Decision phase ────────────────────────────────────────────
  // Absent resolver: byte-identical to pre-policy behavior — derive the
  // approval mode from riskLevel and open the engine's default gate. No
  // policy machinery runs and no audit records are emitted.
  if (!resolver) {
    const approvalMode = approvalModeFor(entry);
    if (approvalMode === "deny") return { kind: "denied-policy" };
    if (approvalMode === "require_approval") {
      const gateOutcome = await requestApprovalDecision(
        ctx,
        approvalGateRequest(entry, actionId, args, summary, resumeKey),
      );
      if (gateOutcome.kind === "expired") return { kind: "expired-approval" };
      const resolution = gateOutcome.resolution;
      // No resolution / an explicit "pending" action means the gate has not
      // yet been decided — distinct from an outright deny.
      if (resolution.actionId === "pending") return { kind: "pending-approval" };
      if (resolution.actionId !== "approve") return { kind: "denied-approval" };
      const availability = await checkServiceAvailability(
        catalog,
        entry.service,
        entry.plugin.requiresCredential === true,
      );
      const outcome = availabilityOutcome(availability);
      if (outcome) return outcome;
    }
    return executeAction(entry, actionId, args, summary, ctx);
  }

  // Present resolver: consult the host policy port. The policy-facing
  // actionId is ALWAYS the fully-qualified `service.action` id (the same
  // fqid convention list_tools reports and the workflow path resolves) —
  // never the plugin's raw `PluginAction.id`, which may be bare. One
  // canonical form means one actionId an admin can target that matches both
  // the session and workflow paths.
  const policyActionId = qualifiedId(entry);
  const input: PolicyResolveInput = {
    teamId: ctx.owner?.type === "team" ? ctx.owner.id : undefined,
    service: entry.service,
    actionId: policyActionId,
    riskLevel: entry.action.riskLevel,
    params: args,
    userId: ctx.userId,
    orgId: ctx.orgId,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    appliesIn: "session",
  };
  const baseRecord: BaseInvocationRecord = {
    service: entry.service,
    actionId: policyActionId,
    toolId: actionId,
    riskLevel: entry.action.riskLevel,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    orgId: ctx.orgId,
    appliesIn: "session",
    summary,
    resumeKey,
    queueItemId: ctx.queueItemId,
    params: args,
  };

  let decision: PolicyDecision;
  try {
    decision = await resolver.resolve(input);
  } catch {
    // A failed read cannot establish whether the team has an absolute deny.
    if (ctx.owner?.type === "team") {
      return { kind: "error", message: "Could not check this team's action policies. Retry the action when policy checks are available." };
    }
    // Fail closed but keep a human in the loop — degrade to an approval
    // gate rather than hard-deny on a transient resolver/store error.
    decision = {
      mode: "require_approval",
      provenance: { baseMode: "require_approval", source: "resolver_error" },
    };
  }

  if (decision.mode === "deny") {
    emitInvocation(resolver, {
      ...baseRecord,
      status: "denied",
      resolvedMode: "deny",
      provenance: decision.provenance,
    });
    return decision.provenance.source === "team_policy" ? { kind: "denied-policy", scope: "team" } : { kind: "denied-policy" };
  }

  // Populated only when a gate actually opens below (require_approval), so
  // the terminal audit record can carry it — absent for allow/deny.
  let gateOrdinal: number | undefined;

  if (decision.mode === "require_approval") {
    // Reject reserved ids up front: "approve"/"deny" are the engine's own
    // default gate actions (added below), so a host extra reusing one would
    // silently collide with — or shadow — the built-in approve/deny
    // semantics. A host-config bug must NOT crash the tool/command path —
    // return a controlled error outcome (fails closed: the action never
    // runs, no gate opens) instead of throwing through execute().
    for (const extra of decision.extraGateActions ?? []) {
      if (extra.id === "approve" || extra.id === "deny") {
        return {
          kind: "error",
          message:
            `policy misconfiguration: PolicyDecision.extraGateActions id "${extra.id}" is reserved ` +
            `for the engine's built-in approve/deny actions and cannot be reused by a host action`,
        };
      }
    }
    // Pass `approves` through to the gate — DecisionAction persists it on
    // the row so denial stickiness classifies host rejection actions the
    // same way isApprovedResolution does.
    const extras: DecisionAction[] = decision.extraGateActions ?? [];
    const baseReq = approvalGateRequest(entry, actionId, args, summary, resumeKey);
    const gateOutcome = await requestApprovalDecision(ctx, {
      ...baseReq,
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
        ...extras,
      ],
      context: { ...baseReq.context, provenance: decision.provenance },
    });
    if (gateOutcome.kind === "expired") {
      // The gate opened and nobody answered before the deadline — a terminal
      // non-approval. Audit it like a rejection so the invocation trail shows
      // the action never ran. gateOrdinal links the record to the expired
      // gate row and lets the sink dedupe sticky-expired retries.
      emitInvocation(resolver, {
        ...baseRecord,
        status: "rejected",
        resolvedMode: "require_approval",
        provenance: decision.provenance,
        gateOrdinal: gateOutcome.gateOrdinal,
      });
      return { kind: "expired-approval" };
    }
    const resolution = gateOutcome.resolution;
    // An undecided gate (command path): no resolution happened, so no
    // onResolution side effects run and no audit record is emitted here —
    // the re-driven invocation after the gate resolves emits the terminal
    // record.
    if (resolution.actionId === "pending") return { kind: "pending-approval" };
    gateOrdinal = resolution.gateOrdinal;
    // onResolution is awaited BEFORE the outcome is interpreted; a throw
    // fails the approval closed (treated as not-approved).
    let onResolutionThrew = false;
    if (resolver.onResolution) {
      try {
        await resolver.onResolution(input, decision, resolution);
      } catch {
        onResolutionThrew = true;
      }
    }
    const approved =
      !onResolutionThrew && isApprovedResolution(resolution, decision.extraGateActions);
    if (!approved) {
      emitInvocation(resolver, {
        ...baseRecord,
        status: "rejected",
        resolvedMode: "require_approval",
        provenance: decision.provenance,
        gateOrdinal,
      });
      return onResolutionThrew
        ? { kind: "denied-approval", reason: "approval-processing-failed" }
        : { kind: "denied-approval" };
    }
    const availability = await checkServiceAvailability(
      catalog,
      entry.service,
      entry.plugin.requiresCredential === true,
    );
    const outcome = availabilityOutcome(availability);
    if (outcome) {
      emitInvocation(resolver, {
        ...baseRecord,
        status: outcome.kind === "service-unavailable" ? "rejected" : "error",
        resolvedMode: "require_approval",
        provenance: decision.provenance,
        gateOrdinal,
        ...(outcome.kind === "error" ? { error: outcome.message } : {}),
      });
      return outcome;
    }
  }

  // allow, or an approved require_approval → execute with audit.
  return executeAction(entry, actionId, args, summary, ctx, {
    resolver,
    record: {
      ...baseRecord,
      resolvedMode: decision.mode,
      provenance: decision.provenance,
      gateOrdinal,
    },
  });

}

// ── Catalog ───────────────────────────────────────────────────────

interface CatalogEntry {
  service: string;
  plugin: ActionPlugin;
  action: PluginAction;
}

interface ResolvedDynamic {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  fetchedAt: number;
}

interface Catalog {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  /** Plugins with a `resolveActions` seam, resolved on demand (not eagerly at catalog build). */
  dynamicPlugins: ActionPlugin[];
  /** TTL cache of resolved dynamic actions, keyed by plugin service. */
  resolved: Map<string, ResolvedDynamic>;
  serviceAvailability: readonly ServiceAvailability[];
  resolveServiceAvailability?: PluginCatalogAvailabilityOptions["resolveServiceAvailability"];
  now: () => number;
}

function buildEntries(
  service: string,
  plugin: ActionPlugin,
  actions: PluginAction[],
): { entries: CatalogEntry[]; byId: Map<string, CatalogEntry> } {
  const entries: CatalogEntry[] = [];
  const byId = new Map<string, CatalogEntry>();
  for (const action of actions) {
    const entry: CatalogEntry = { service, plugin, action };
    entries.push(entry);
    const fqid = action.id.includes(".") ? action.id : `${service}.${action.id}`;
    byId.set(fqid, entry);
    // Allow a bare id lookup when unambiguous.
    if (action.id !== fqid && !byId.has(action.id)) byId.set(action.id, entry);
  }
  return { entries, byId };
}

function buildCatalog(
  plugins: ActionPlugin[],
  now: () => number,
  availability: PluginCatalogAvailabilityOptions = {},
): Catalog {
  const entries: CatalogEntry[] = [];
  const byId = new Map<string, CatalogEntry>();
  const dynamicPlugins: ActionPlugin[] = [];
  for (const plugin of plugins) {
    for (const action of plugin.actions) {
      const entry: CatalogEntry = { service: plugin.service, plugin, action };
      entries.push(entry);
      const fqid = action.id.includes(".") ? action.id : `${plugin.service}.${action.id}`;
      byId.set(fqid, entry);
      // Allow a bare id lookup when unambiguous.
      if (action.id !== fqid && !byId.has(action.id)) byId.set(action.id, entry);
    }
    if (plugin.resolveActions) dynamicPlugins.push(plugin);
  }
  return {
    entries,
    byId,
    dynamicPlugins,
    resolved: new Map(),
    serviceAvailability: availability.serviceAvailability ?? [],
    resolveServiceAvailability: availability.resolveServiceAvailability,
    now,
  };
}

interface ServiceAvailabilityCheck {
  unavailable?: ServiceAvailability;
  error?: string;
}

function serviceRequiresCredential(catalog: Catalog, service: string): boolean {
  return [
    ...catalog.entries.map((entry) => entry.plugin),
    ...catalog.dynamicPlugins,
  ].some((plugin) => plugin.service === service && plugin.requiresCredential === true);
}

async function checkServiceAvailability(
  catalog: Catalog,
  service: string,
  requiresCredential: boolean,
): Promise<ServiceAvailabilityCheck> {
  try {
    const availability = catalog.resolveServiceAvailability
      ? await catalog.resolveServiceAvailability(service)
      : catalog.serviceAvailability;
    return {
      unavailable: availability.find((item) => item.service === service && item.state !== "available"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hasStaticUnavailable = catalog.serviceAvailability.some(
      (item) => item.service === service && item.state !== "available",
    );
    return requiresCredential || hasStaticUnavailable
      ? { error: `could not verify service availability: ${message}; retry` }
      : {};
  }
}

function availabilityOutcome(check: ServiceAvailabilityCheck): InvokeActionResult | undefined {
  if (check.unavailable) return serviceUnavailableOutcome(check.unavailable);
  return check.error ? { kind: "error", message: check.error } : undefined;
}

function serviceUnavailableOutcome(
  availability: ServiceAvailability,
): InvokeActionResult {
  return {
    kind: "service-unavailable",
    service: availability.service,
    state: availability.state,
    reason: availability.reason,
    ...(availability.fix ? { fix: availability.fix } : {}),
  };
}

/**
 * Resolve (with TTL caching) the dynamic action set for one plugin.
 * Throws propagate to the caller — list_tools turns them into a warning,
 * call_tool turns them into an error-text tool result.
 */
async function resolveDynamic(
  catalog: Catalog,
  plugin: ActionPlugin,
  ctx: ToolContext,
): Promise<ResolvedDynamic> {
  const now = catalog.now();
  const cached = catalog.resolved.get(plugin.service);
  if (cached && now - cached.fetchedAt < RESOLVE_TTL_MS) {
    return cached;
  }
  // resolveActions is guaranteed present on every entry of dynamicPlugins.
  const resolveActions = plugin.resolveActions;
  if (!resolveActions) throw new Error(`plugin ${plugin.service} has no resolveActions`);
  const credentialService = plugin.credentialService ?? plugin.service;
  const actions = await resolveActions({
    credentials: scopedCredentialProvider(ctx, credentialService),
  });
  const built = buildEntries(plugin.service, plugin, actions);
  const result: ResolvedDynamic = { ...built, fetchedAt: now };
  catalog.resolved.set(plugin.service, result);
  return result;
}

// ── list_tools ───────────────────────────────────────────────────

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/**
 * `pinnedNames` maps a fully-qualified action id to the direct tool that
 * also invokes it. A pinned action stays listed here: `list_tools` is the
 * only complete inventory, and `call_tool` keeps accepting the id whatever
 * the host pins, so hiding the row would make the same catalog answer
 * differently in two deployments. The row names its direct tool instead.
 */
function makeListTool(
  catalog: Catalog,
  pinnedNames: ReadonlyMap<string, string>,
  opts: PluginCatalogOptions,
): ToolDef {
  // Name every service in the description. The catalog indirection hides
  // integration actions from the visible tool list, so this line is the only
  // zero-cost signal the model gets that a service exists at all — without
  // it, the model must guess that list_tools is worth calling before it
  // tells the user a capability is missing.
  const services = [
    ...new Set([
      ...catalog.entries.map((e) => e.service),
      ...catalog.dynamicPlugins.map((p) => p.service),
    ]),
  ].sort();
  const initialUnavailable = new Map(
    (opts.serviceAvailability ?? [])
      .filter((item) => item.state !== "available")
      .map((item) => [item.service, item]),
  );
  const availableServices = services.filter((service) => !initialUnavailable.has(service));
  const configurableServices = [...initialUnavailable.values()]
    .filter((item) => item.state === "not_connected" || item.state === "deployment_unconfigured")
    .map((item) => item.service)
    .sort();
  const gatedServices = [...initialUnavailable.values()]
    .filter((item) => item.state !== "not_connected" && item.state !== "deployment_unconfigured")
    .map((item) => `${item.service} (${item.state})`)
    .sort();
  const serviceLine = [
    availableServices.length > 0 ? ` Available services: ${availableServices.join(", ")}.` : "",
    configurableServices.length > 0
      ? ` Configurable but not connected: ${configurableServices.join(", ")}.`
      : "",
    gatedServices.length > 0 ? ` Unavailable services: ${gatedServices.join(", ")}.` : "",
  ].join("");
  return {
    name: "list_tools",
    description:
      "List integration actions only. Native tools are already on your own tool list and are not listed here. " +
      "Filter by service or search by name/description. Returns tool_ids plus parameter schemas; use call_tool to invoke one." +
      serviceLine +
      " If a request could be covered by one of these services, check here before " +
      "you say it is not possible. A service that is not connected is reported " +
      "here with the corrective action, so a check is never wasted.",
    parameters: Type.Object({
      service: Type.Optional(
        Type.String({
          description:
            "Filter by service name (e.g. 'github', 'gmail'). Omit to list across all services.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            "Case-insensitive search against name, id, and description. Positive terms use OR. A leading - excludes a term. Uppercase OR is optional. Quotes preserve a phrase. Only-negative queries return no results. Search uses the first 1,024 characters and 16 unique terms, with 128 characters per term.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: LIST_LIMIT_MAX,
          description: `Cap results (default ${LIST_LIMIT_DEFAULT}, max ${LIST_LIMIT_MAX}).`,
        }),
      ),
    }),
    execute: async (args, ctx): Promise<ToolResult> => {
      const a = args as { service?: string; query?: string; limit?: number };
      const limit = clamp(a.limit ?? LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
      const query = parseSearchQuery(a.query ?? "");
      const actionFields = (action: PluginAction): string[] => [
        action.id,
        action.name,
        action.description,
      ];
      const matchesQuery = (action: PluginAction): boolean =>
        matchesSearchQuery(query, actionFields(action));

      let entries = catalog.entries;
      if (a.service) entries = entries.filter((e) => e.service === a.service);
      if (query.hasInput) entries = entries.filter((e) => matchesQuery(e.action));

      const warnings: Array<{
        service: string;
        reason: string;
        state?: ServiceAvailabilityState;
        fix?: string;
      }> = [];
      let availability = catalog.serviceAvailability;
      try {
        availability = catalog.resolveServiceAvailability
          ? await catalog.resolveServiceAvailability(a.service || undefined)
          : catalog.serviceAvailability;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push({
          service: a.service ?? "catalog",
          reason: `availability check failed: ${message} — availability states may be incomplete; retry`,
        });
      }
      const unavailable = availability.filter((item) => item.state !== "available");
      for (const item of unavailable) {
        entries = entries.filter((entry) => entry.service !== item.service);
      }
      const warnedUnavailable = unavailable.filter(
        (item) =>
          (!a.service || item.service === a.service) &&
          (!query.hasInput || matchesSearchQuery(query, [item.service])),
      );
      for (const item of warnedUnavailable) {
        warnings.push({
          service: item.service,
          state: item.state,
          reason: item.reason,
          ...(item.fix ? { fix: item.fix } : {}),
        });
      }

      // Merge in dynamic (resolveActions-backed) plugins whose service
      // passes the filter. Discovery failures become warnings, not throws.
      const dynamicServicesConsidered = new Set<string>();
      for (const plugin of catalog.dynamicPlugins) {
        if (unavailable.some((item) => item.service === plugin.service)) continue;
        if (a.service && plugin.service !== a.service) continue;
        dynamicServicesConsidered.add(plugin.service);
        try {
          const resolvedDyn = await resolveDynamic(catalog, plugin, ctx);
          const dynEntries =
            query.hasInput
              ? resolvedDyn.entries.filter((e) => matchesQuery(e.action))
              : resolvedDyn.entries;
          entries = entries.concat(dynEntries);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push({ service: plugin.service, reason: `action discovery failed: ${message}` });
        }
      }

      // Per-service auth handling — only services whose plugin declares
      // `requiresCredential` are probed (credential-less plugins like
      // workflows would otherwise produce "no credential connected"
      // noise). Unconnected services' tools are HIDDEN from unfiltered
      // listings: advertising tools that can only fail wastes the agent's
      // turn. An explicit `service:` filter still returns them alongside
      // the warning, so schemas stay inspectable.
      const services = new Set(entries.map((e) => e.service));
      for (const service of dynamicServicesConsidered) services.add(service);
      for (const service of services) {
        const plugin =
          catalog.entries.find((e) => e.service === service)?.plugin ??
          catalog.dynamicPlugins.find((p) => p.service === service);
        if (!plugin?.requiresCredential) continue;
        const credService = plugin.credentialService ?? service;
        let cred: Awaited<ReturnType<typeof ctx.credentials.get>>;
        let probeReason: string | undefined;
        try {
          cred = await ctx.credentials.get(credService);
        } catch (err) {
          // A resolver may throw instead of returning null (e.g. a
          // GitHubAuthError when the org has no installation). Treat that
          // the same as "no credential connected" so one throwing probe
          // can't abort discovery for every other service — but surface
          // the resolver's own message: it names the actual fix (e.g.
          // "App created but not installed — Install on GitHub").
          cred = null;
          probeReason = err instanceof Error ? err.message : String(err);
        }
        if (!cred) {
          if (a.service === service) {
            warnings.push({
              service,
              state: "not_connected",
              reason: probeReason ?? "not connected",
              fix: `Connect ${service} on the Integrations page (/integrations). After connecting, call list_tools (service: "${service}") to confirm — actions appear when the connection worked; otherwise this warning returns with the reason.`,
            });
          } else {
            entries = entries.filter((e) => e.service !== service);
            warnings.push({
              service,
              state: "not_connected",
              reason: `not connected; tools hidden. ${probeReason ?? ""}`.trim(),
              fix: `Connect ${service} on the Integrations page (/integrations). After connecting, call list_tools (service: "${service}") to confirm — actions appear when the connection worked; otherwise this warning returns with the reason.`,
            });
          }
        }
      }

      if (query.hasInput) {
        entries = rankSearchResults(query, entries, (entry) => actionFields(entry.action));
      }

      const tools = entries.slice(0, limit).map((e) => {
        const toolId = qualifiedId(e);
        const directTool = pinnedNames.get(toolId);
        return {
          service: e.service,
          tool_id: toolId,
          name: e.action.name,
          description: e.action.description,
          riskLevel: e.action.riskLevel,
          params: e.action.parameters,
          ...(directTool ? { direct_tool: directTool } : {}),
        };
      });

      const total = entries.length;
      const nativeMatches = nativeToolMatches(a.query, opts.nativeToolNames ?? []);
      if (total === 0) {
        const matched = nativeMatches.length > 0 ? ` (matched: ${nativeMatches.join(", ")})` : "";
        warnings.push({
          service: "catalog",
          reason: `no integration action matched; native tools are not listed here — check your own tool list${matched}`,
        });
      }
      return {
        text: encodeToolOutput({
          tools,
          total,
          ...(total > limit ? { truncated: total - limit } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        }),
      };
    },
  };
}

function nativeToolMatches(query: string | undefined, names: readonly string[]): string[] {
  const terms =
    (query ?? "")
      .toLowerCase()
      .match(/[a-z0-9_*.-]+/g)
      ?.filter((term) => term !== "or" && !term.startsWith("-"))
      .map((term) => term.replaceAll("*", ""))
      .filter((term) => term.length > 0) ?? [];
  if (terms.length === 0) return [];
  return [...new Set(names)]
    .filter((name) => terms.some((term) => name.toLowerCase().includes(term)))
    .sort();
}

function resolveFailurePrefix(message: string): string {
  return /(?:auth|unauthori[sz]ed|forbidden|credential|token|\b401\b|\b403\b)/i.test(message)
    ? "authentication failed: "
    : "upstream failure: ";
}

// ── call_tool ────────────────────────────────────────────────────

function makeCallTool(catalog: Catalog): ToolDef {
  return {
    name: "call_tool",
    description:
      "Invoke a plugin action by tool_id (discovered via list_tools). Approval gates may suspend execution for high/critical risk actions.",
    parameters: Type.Object({
      tool_id: Type.String({
        description: "Fully-qualified action id from list_tools (e.g. 'github.create_issue').",
      }),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            "Action parameters, matching the schema reported by list_tools for this tool_id.",
        }),
      ),
      summary: Type.String({
        description:
          "One-line human-readable summary of what this call does. Shown in approval gates and audit logs.",
      }),
    }),
    execute: async (args, ctx): Promise<ToolResult> => {
      const a = args as {
        tool_id: string;
        params?: Record<string, unknown>;
        summary: string;
      };
      const outcome = await invokeAction(catalog, a.tool_id, a.params, ctx, a.summary);
      return renderInvokeOutcome(outcome, a.tool_id);
    },
  };
}

/**
 * Renders one {@link InvokeActionResult} into the `ToolResult` the LLM
 * reads. `call_tool` and every pinned tool share this function, so the
 * denial, validation and credential wording cannot drift apart between the
 * two routes.
 */
function renderInvokeOutcome(outcome: InvokeActionResult, toolId: string): ToolResult {
  switch (outcome.kind) {
    case "ok":
      return actionResultToToolResult(outcome.result, toolId);
    case "unknown":
      return {
        text: `unknown tool_id: "${toolId}". Use list_tools to find available actions.`,
      };
    case "resolve-failed":
      return {
        text: `error resolving ${outcome.service} tools: ${resolveFailurePrefix(outcome.message)}${outcome.message}`,
      };
    case "denied-policy":
      return { text: `denied: ${toolId} is blocked by ${outcome.scope === "team" ? "team" : "org"} policy` };
    // The LLM tool path has no distinct "pending" state — requestDecision
    // blocks until the gate resolves — so both approval outcomes collapse
    // to the same "did not approve" text.
    case "denied-approval":
      return {
        text:
          outcome.reason === "approval-processing-failed"
            ? `denied: approval processing failed, so ${toolId} did not approve`
            : `denied: user did not approve ${toolId}. This denial is final for the current turn — do not call ${toolId} again, with these or modified arguments. Tell the user what was denied; they can ask again in a new message.`,
      };
    case "expired-approval":
      return {
        text: `denied: the approval request for ${toolId} expired before anyone answered. This outcome is final for the current turn — do not call ${toolId} again. Tell the user the action did not run; they can ask again in a new message.`,
      };
    case "pending-approval":
      return { text: `denied: user did not approve ${toolId}` };
    case "invalid-args":
      return { text: `invalid params for ${toolId}: ${outcome.error}` };
    case "missing-credential":
      return {
        text: `${toolId} failed: credential ${outcome.service} not connected — Connect ${outcome.service} on the Integrations page (/integrations). After connecting, call list_tools (service: "${outcome.service}") to confirm — actions appear when the connection worked; otherwise this warning returns with the reason.`,
      };
    case "service-unavailable":
      return {
        text: `${toolId} unavailable: ${outcome.reason}${outcome.fix ? ` ${outcome.fix}` : ""}`,
      };
    case "error":
      return { text: `error: ${outcome.message}` };
  }
}

// ── pinned tools ─────────────────────────────────────────────────

interface ResolvedPins {
  tools: ToolDef[];
  /** Fully-qualified action id → the direct tool name that also invokes it. */
  nameByActionId: Map<string, string>;
}

/**
 * Turns the host's pin list into direct tools, and refuses every entry it
 * cannot map safely.
 *
 * A refusal is never a throw. `pluginCatalogTools` runs on every session
 * build with no try/catch above it, so a throw here would stop a person
 * starting any session because of a host config mistake. A refused pin
 * costs nothing: the action stays reachable through `list_tools` and
 * `call_tool`.
 */
function resolvePins(catalog: Catalog, opts: PluginCatalogOptions): ResolvedPins {
  const tools: ToolDef[] = [];
  const nameByActionId = new Map<string, string>();
  const pins = opts.pins ?? [];
  if (pins.length === 0) return { tools, nameByActionId };

  const reject = opts.onPinRejected;
  // Every name that must stay unique in the final tool array: the engine's
  // own builtins, the two catalog tools, and the names the caller appends
  // after this function returns. `Thread.buildTools` concatenates the
  // builtins with the session tools and does NOT dedupe, so a repeat would
  // ship two same-named tools to the provider.
  //
  // No builtin name contains `__` today, so no mapped name can equal one.
  // The builtins are listed anyway: the uniqueness rule then holds from the
  // set itself, and a future builtin cannot break it in silence.
  const taken = new Set<string>([
    ...builtinTools.map((t) => t.name),
    "list_tools",
    "call_tool",
    ...(opts.reservedToolNames ?? []),
  ]);

  for (const pin of pins) {
    const { actionId } = pin;
    if (tools.length >= MAX_PINNED_ACTIONS) {
      reject?.(
        actionId,
        `the pin list is over the ceiling of ${MAX_PINNED_ACTIONS} actions. ` +
          `Remove a pin before you add this one; the action still works through call_tool.`,
      );
      continue;
    }

    const name = pinnedToolName(actionId);
    if (!name) {
      reject?.(
        actionId,
        `the id cannot become a tool name. Pin an id of the form ` +
          `"service.action_name" — lowercase letters, digits and single ` +
          `underscores only, at most ${PIN_ID_MAX_LENGTH} characters.`,
      );
      continue;
    }

    if (taken.has(name)) {
      reject?.(
        actionId,
        `the tool name "${name}" is already in use. Rename the action, or ` +
          `drop this pin and reach the action through call_tool.`,
      );
      continue;
    }

    // `catalog.byId` holds only statically declared actions. A plugin whose
    // actions come from `resolveActions` has none at build time, so its
    // actions are unpinnable and land here.
    const entry = catalog.byId.get(actionId);
    if (!entry) {
      reject?.(
        actionId,
        `no plugin declares this action. Check the id against list_tools, ` +
          `and note that a dynamically resolved action cannot be pinned.`,
      );
      continue;
    }

    taken.add(name);
    nameByActionId.set(qualifiedId(entry), name);
    tools.push(makePinnedTool(catalog, entry, actionId, name, pin.guidance));
  }

  return { tools, nameByActionId };
}

/**
 * The argument a pinned tool adds so the model can write its own summary.
 * Same name and same meaning as `call_tool`'s own `summary` argument.
 */
const PINNED_SUMMARY_ARG = "summary";

/** Published on the added argument. Matches `call_tool`'s wording. */
const PINNED_SUMMARY_DESCRIPTION =
  "One-line human-readable summary of what this call does. Shown in approval gates and audit logs.";

/**
 * Publishes the action's schema with a `summary` argument added.
 *
 * WHY. The summary is the first line of an approval gate body and the
 * `summary` field of every audit record. `call_tool` takes it from the
 * model. A pinned tool that derived a constant instead would ask a person
 * to approve an action with no statement of intent, and would write the
 * same constant on every audit row for that action. An action can move to
 * `require_approval` at any time through an org policy, so a pinned tool
 * must carry the model's own sentence.
 *
 * The added argument is optional and it is stripped before validation, so
 * the two routes still agree about what the ACTION accepts. `carriesSummary`
 * is false in two cases, and the caller then falls back to a derived
 * constant: the schema is not an object, or the action already declares its
 * own `summary` property. The second case is what stops a collision with a
 * real parameter of the same name.
 */
function withSummaryArg(schema: TSchema): { schema: TSchema; carriesSummary: boolean } {
  if (!IsObject(schema)) return { schema, carriesSummary: false };
  if (Object.hasOwn(schema.properties, PINNED_SUMMARY_ARG)) {
    return { schema, carriesSummary: false };
  }
  const published = Type.Object(
    {
      ...schema.properties,
      [PINNED_SUMMARY_ARG]: Type.Optional(
        Type.String({ description: PINNED_SUMMARY_DESCRIPTION }),
      ),
    },
    // Keeps `description`, `additionalProperties` and every other keyword
    // the action set on its own object schema. `ObjectOptions` discards the
    // four keywords `Type.Object` recomputes.
    ObjectOptions(schema),
  );
  return { schema: published, carriesSummary: true };
}

/**
 * Splits the model's `summary` argument off the action's own parameters.
 *
 * The summary never reaches `prepareActionArgs` or the plugin's `execute`,
 * and it never lands in the audit record's `params`. A blank or non-string
 * value becomes undefined, so the caller's fallback applies.
 */
function splitSummaryArg(args: Record<string, unknown> | undefined): {
  params: Record<string, unknown> | undefined;
  summary: string | undefined;
} {
  if (!args) return { params: undefined, summary: undefined };
  const raw = args[PINNED_SUMMARY_ARG];
  const params = { ...args };
  delete params[PINNED_SUMMARY_ARG];
  const summary = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  return { params, summary };
}

/**
 * One direct tool for one catalog action.
 *
 * The body holds no execution logic of its own — it calls
 * {@link invokeAction}, the same core `call_tool` and the slash-command
 * path call. That is what keeps the approval gate, `prepareActionArgs`
 * validation, credential scoping and the audit record identical on both
 * routes. `requiresApproval` is deliberately NOT set: nothing in the engine
 * reads that field, so setting it would look like a gate and do nothing.
 */
function makePinnedTool(
  catalog: Catalog,
  entry: CatalogEntry,
  actionId: string,
  name: string,
  guidance: string | undefined,
): ToolDef {
  const parts = [entry.action.description];
  if (guidance) parts.push(guidance);
  parts.push(`Same action as \`${actionId}\` through call_tool.`);
  const published = withSummaryArg(entry.action.parameters);
  // The constant the gate body and the audit record fall back to. It names
  // the action and the tool, so a record is still readable when the model
  // sends no summary or the schema cannot carry one.
  const derivedSummary = `${entry.action.name} (${name})`;
  return {
    name,
    description: parts.join(" "),
    parameters: published.schema,
    riskLevel: entry.action.riskLevel,
    execute: async (args, ctx): Promise<ToolResult> => {
      const record = isParamRecord(args) ? args : undefined;
      const split = published.carriesSummary
        ? splitSummaryArg(record)
        : { params: record, summary: undefined };
      const outcome = await invokeAction(
        catalog,
        actionId,
        split.params,
        ctx,
        split.summary ?? derivedSummary,
      );
      return renderInvokeOutcome(outcome, actionId);
    },
  };
}

/**
 * True when tool args are the plain object `invokeAction` expects.
 * Anything else becomes undefined at the call site, which
 * `prepareActionArgs` then defaults and validates like an empty call.
 */
function isParamRecord(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

// ── helpers ──────────────────────────────────────────────────────

/** The invocation-record fields known before an audit status is decided. */
type BaseInvocationRecord = Omit<
  PolicyInvocationRecord,
  "status" | "resolvedMode" | "provenance" | "durationMs" | "error"
>;

/**
 * Validate params, build the action context, run the plugin action, and map
 * the result. When `audit` is supplied (present-resolver path), emit exactly
 * one fire-and-forget `onInvocation` record for the terminal disposition
 * (`error` for a param-validation failure or a thrown execute, `completed`
 * otherwise). Absent-resolver callers pass no `audit` and emit nothing.
 */
async function executeAction(
  entry: CatalogEntry,
  actionId: string,
  args: Record<string, unknown> | undefined,
  summary: string,
  ctx: ToolContext,
  audit?: { resolver: PolicyResolver; record: BaseAuditedRecord },
): Promise<InvokeActionResult> {
  // Validate (and apply schema defaults to) LLM-supplied params before they
  // reach the plugin action's execute body — closes the gap where unvalidated
  // params flowed straight into plugin code.
  const prepared = prepareActionArgs(entry.action.parameters, args);
  if (!prepared.ok) {
    if (audit) {
      emitInvocation(audit.resolver, {
        ...audit.record,
        status: "error",
        error: `invalid params: ${prepared.error}`,
      });
    }
    return { kind: "invalid-args", error: prepared.error };
  }

  // Build the plugin action context. credentialService routing is per-plugin;
  // the action sees the same ToolContext shape plus actionId/service/summary,
  // with credentials defaulting to the plugin's credentialService.
  const credentialService = entry.plugin.credentialService ?? entry.service;
  // Bind the plugin store to THIS action's owning plugin so the action reads
  // and writes only its own rows (plugin-store design). The base ToolContext is
  // turn-scoped and plugin-agnostic; the factory it carries re-scopes here.
  const pluginStore = ctx.pluginStoreFactory?.(entry.service);
  const actionCtx: PluginActionContext = {
    ...ctx,
    actionId: entry.action.id,
    service: entry.service,
    summary,
    credentials: scopedCredentialProvider(ctx, credentialService),
    ...(pluginStore ? { pluginStore } : {}),
  };

  const startedAt = Date.now();
  try {
    const result = await entry.action.execute(
      prepared.args as Static<typeof entry.action.parameters>,
      actionCtx,
    );
    if (audit) {
      emitInvocation(audit.resolver, {
        ...audit.record,
        status: "completed",
        durationMs: Date.now() - startedAt,
        result,
      });
    }
    return { kind: "ok", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (audit) {
      emitInvocation(audit.resolver, {
        ...audit.record,
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      });
    }
    // A plugin action that needs a credential calls `credentials.request`,
    // which throws "credential <service> not connected: <reason>" (store
    // present, no cred) or "credential <service> not available (no store)"
    // (no store at all). Both mean the same thing to the user — surface a
    // missing-credential outcome so callers can name the corrective action.
    if (/credential .* not (connected|available)/.test(message)) {
      return { kind: "missing-credential", service: credentialService };
    }
    return { kind: "error", message };
  }
}

/** Base record plus the resolved mode + provenance carried into execution. */
type BaseAuditedRecord = BaseInvocationRecord &
  Pick<PolicyInvocationRecord, "resolvedMode" | "provenance">;

/** Approved iff the human chose `approve` or a host `approves: true` action. */
function isApprovedResolution(
  resolution: DecisionResolution,
  extraGateActions: PolicyDecision["extraGateActions"],
): boolean {
  if (resolution.actionId === "approve") return true;
  return !!extraGateActions?.some((x) => x.approves && x.id === resolution.actionId);
}

/**
 * Emit an audit record fire-and-forget. `onInvocation` must never throw into
 * the tool path — a rejected promise is swallowed here.
 */
function emitInvocation(resolver: PolicyResolver, record: PolicyInvocationRecord): void {
  if (!resolver.onInvocation) return;
  try {
    void Promise.resolve(resolver.onInvocation(record)).catch(() => {});
  } catch {
    // A sink that throws synchronously must not break the tool path either.
  }
}

/**
 * The approval rule, as a pure function of the two inputs that decide it.
 *
 * Exported because the connect UI states — before a user connects — how many
 * of a service's tools stop and ask them first. That claim has to be the same
 * rule the gate below actually applies, so it is resolved through this
 * function rather than re-derived from `riskLevel` at the wire or in the
 * client. A plugin that pins `defaultApprovalMode` overrides risk entirely,
 * and a caller that forgot that would advertise a gate that never fires.
 */
export function approvalModeForAction(
  riskLevel: RiskLevel,
  defaultApprovalMode?: ApprovalMode,
): ApprovalMode {
  if (defaultApprovalMode) return defaultApprovalMode;
  switch (riskLevel) {
    case "low":
    case "medium":
      return "allow";
    case "high":
    case "critical":
      return "require_approval";
  }
}

function approvalModeFor(entry: CatalogEntry): ApprovalMode {
  return approvalModeForAction(entry.action.riskLevel, entry.plugin.defaultApprovalMode);
}

function qualifiedId(entry: CatalogEntry): string {
  return entry.action.id.includes(".") ? entry.action.id : `${entry.service}.${entry.action.id}`;
}

/**
 * Wrap the engine's CredentialProvider to default lookups to the
 * plugin's credential service. The plugin still gets a CredentialProvider
 * (so it can call .get() and .request() the same way), but a bare
 * `.get()` (or `.get(service)` for the same service) routes to the
 * plugin's `credentialService` setting rather than the bare
 * action.service.
 */
function scopedCredentialProvider(
  ctx: ToolContext,
  defaultService: string,
): ToolContext["credentials"] {
  return {
    get: (service?: string) => ctx.credentials.get(service ?? defaultService),
    request: (service: string, reason: string) => ctx.credentials.request(service, reason),
  };
}

function actionResultToToolResult(
  result: PluginActionResult,
  toolId: string,
): ToolResult {
  const attachments = result.attachments;
  if (!result.success) {
    return {
      text: `${toolId} failed: ${result.error ?? "unknown error"}`,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      ok: false,
    };
  }
  if (result.data === undefined) {
    return {
      text: `${toolId} ok`,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      ok: true,
    };
  }
  return {
    text: typeof result.data === "string" ? result.data : encodeToolOutput(result.data),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    ok: true,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Args JSON at or under this length passes through raw, so small keys stay
// human-readable and byte-identical to the pre-bound format. The threshold
// keeps the worst-case UTF-8 gate id well under the ~2704-byte btree cap.
const RESUME_KEY_ARGS_MAX_CHARS = 256;

/**
 * Returns the args portion of a resumeKey, bounded in length. JSON longer
 * than the threshold is replaced with its UTF-8 byte length plus a 64-bit
 * FNV-1a hash over the UTF-8 bytes — deterministic, so restart replay
 * re-derives the identical key. TextEncoder is a web-standard global (no
 * node:crypto): the engine stays portable.
 */
function boundedArgsKey(json: string): string {
  if (json.length <= RESUME_KEY_ARGS_MAX_CHARS) return json;
  const bytes = new TextEncoder().encode(json);
  return `fnv1a64:${bytes.length}:${fnv1a64Hex(bytes)}`;
}

function fnv1a64Hex(bytes: Uint8Array): string {
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
