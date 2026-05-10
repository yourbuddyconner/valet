import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  RiskLevel,
  ToolAttachment,
  ToolContext,
  ToolDef,
  ToolResult,
} from "./types.js";

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
   * Default approval policy. Unset = derived from each action's riskLevel:
   * low/medium → allow; high/critical → require_approval.
   */
  defaultApprovalMode?: ApprovalMode;
}

export interface PluginCatalogOptions {
  plugins: ActionPlugin[];
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Build the [list_tools, call_tool] pair backed by an in-memory catalog
 * assembled from every ActionPlugin in `opts.plugins`.
 */
export function pluginCatalogTools(opts: PluginCatalogOptions): ToolDef[] {
  const catalog = buildCatalog(opts.plugins);
  return [makeListTool(catalog), makeCallTool(catalog)];
}

// ── Catalog ───────────────────────────────────────────────────────

interface CatalogEntry {
  service: string;
  plugin: ActionPlugin;
  action: PluginAction;
}

interface Catalog {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
}

function buildCatalog(plugins: ActionPlugin[]): Catalog {
  const entries: CatalogEntry[] = [];
  const byId = new Map<string, CatalogEntry>();
  for (const plugin of plugins) {
    for (const action of plugin.actions) {
      const entry: CatalogEntry = { service: plugin.service, plugin, action };
      entries.push(entry);
      const fqid = action.id.includes(".") ? action.id : `${plugin.service}.${action.id}`;
      byId.set(fqid, entry);
      // Allow a bare id lookup when unambiguous.
      if (action.id !== fqid && !byId.has(action.id)) byId.set(action.id, entry);
    }
  }
  return { entries, byId };
}

// ── list_tools ───────────────────────────────────────────────────

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

function makeListTool(catalog: Catalog): ToolDef {
  return {
    name: "list_tools",
    description:
      "List available plugin tools. Filter by service or search by name/description. Returns tool_ids plus their parameter schemas; use call_tool to invoke one.",
    parameters: Type.Object({
      service: Type.Optional(
        Type.String({
          description:
            "Filter by service name (e.g. 'github', 'gmail'). Omit to list across all services.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Case-insensitive substring match against name, id, and description.",
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
      const q = a.query?.toLowerCase();

      let entries = catalog.entries;
      if (a.service) entries = entries.filter((e) => e.service === a.service);
      if (q) {
        entries = entries.filter((e) => {
          const action = e.action;
          return (
            action.id.toLowerCase().includes(q) ||
            action.name.toLowerCase().includes(q) ||
            action.description.toLowerCase().includes(q)
          );
        });
      }

      // Per-service auth warnings: probe each represented service's
      // credentials and report missing ones so the LLM can ask the user.
      const services = new Set(entries.map((e) => e.service));
      const warnings: Array<{ service: string; reason: string }> = [];
      for (const service of services) {
        const credService =
          catalog.entries.find((e) => e.service === service)?.plugin.credentialService ?? service;
        const cred = await ctx.credentials.get(credService);
        if (!cred) warnings.push({ service, reason: "no credential connected" });
      }

      const tools = entries.slice(0, limit).map((e) => ({
        service: e.service,
        tool_id: qualifiedId(e),
        name: e.action.name,
        description: e.action.description,
        riskLevel: e.action.riskLevel,
        params: e.action.parameters,
      }));

      const total = entries.length;
      return {
        text: JSON.stringify(
          {
            tools,
            total,
            truncated: total > limit ? total - limit : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
          null,
          2,
        ),
      };
    },
  };
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
      const entry = catalog.byId.get(a.tool_id);
      if (!entry) {
        return {
          text: `unknown tool_id: "${a.tool_id}". Use list_tools to find available actions.`,
        };
      }

      const approvalMode = approvalModeFor(entry);
      if (approvalMode === "deny") {
        return { text: `denied: ${a.tool_id} is blocked by org policy` };
      }
      if (approvalMode === "require_approval") {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: `Approve ${entry.action.name}?`,
          body: `${a.summary}\n\ntool_id=${a.tool_id}\nargs=${stableJson(a.params ?? {})}`,
          resumeKey: `${qualifiedId(entry)}:${stableJson(a.params ?? {})}`,
          context: {
            riskLevel: entry.action.riskLevel,
            service: entry.service,
            tool_id: a.tool_id,
            args: a.params,
          },
        });
        if (resolution.actionId !== "approve") {
          return { text: `denied: user did not approve ${a.tool_id}` };
        }
      }

      // Build the plugin action context. credentialService routing is
      // per-plugin; the action sees the same ToolContext shape plus
      // actionId/service/summary, with credentials defaulting to the
      // plugin's credentialService.
      const credentialService = entry.plugin.credentialService ?? entry.service;
      const actionCtx: PluginActionContext = {
        ...ctx,
        actionId: entry.action.id,
        service: entry.service,
        summary: a.summary,
        credentials: scopedCredentialProvider(ctx, credentialService),
      };

      let result: PluginActionResult;
      try {
        result = await entry.action.execute(
          (a.params ?? {}) as Static<typeof entry.action.parameters>,
          actionCtx,
        );
      } catch (err) {
        return {
          text: `error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return actionResultToToolResult(result, a.tool_id);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────

function approvalModeFor(entry: CatalogEntry): ApprovalMode {
  if (entry.plugin.defaultApprovalMode) return entry.plugin.defaultApprovalMode;
  switch (entry.action.riskLevel) {
    case "low":
    case "medium":
      return "allow";
    case "high":
    case "critical":
      return "require_approval";
  }
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
    };
  }
  if (result.data === undefined) {
    return {
      text: `${toolId} ok`,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
  }
  return {
    text: stableJson(result.data),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
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
