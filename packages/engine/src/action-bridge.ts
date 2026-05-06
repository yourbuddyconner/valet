import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { RiskLevel, ToolAttachment, ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * Action bridge: V1 migration adapter for existing valet plugin packages.
 *
 * Design (per spec §"Plugin Action Bridge"): we register exactly two
 * engine-visible tools — `list_tools` and `call_tool` — and let the agent
 * discover plugin actions on demand. We do NOT register one LLM-visible
 * tool per action because (a) action ids contain dots and Anthropic rejects
 * them in tool names, (b) dozens of plugins × dozens of actions blows the
 * tool-catalog budget, and (c) most sessions only need a handful of actions
 * and shouldn't pay the prompt cost of all of them.
 */

// ── Plugin shapes (structurally compatible with @valet/sdk) ───────

export interface BridgeActionDefinition<TParams extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  description: string;
  riskLevel: RiskLevel;
  params: TParams;
  /** Raw JSON Schema — when present, bypasses Zod conversion. */
  inputSchema?: Record<string, unknown>;
}

export interface BridgeActionListContext {
  credentials?: Record<string, string>;
}

export interface BridgeActionContext {
  credentials: Record<string, string>;
  userId: string;
  orgId?: string;
  callerIdentity?: { name: string; avatar?: string };
  attribution?: { name: string; email: string };
  guardConfig?: Record<string, unknown>;
  // analytics is intentionally omitted — the engine emits its own observability.
  analytics?: unknown;
}

export interface BridgeActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  images?: Array<{ data: string; mimeType: string; description: string }>;
}

export interface BridgeActionSource {
  listActions(
    ctx?: BridgeActionListContext,
  ): BridgeActionDefinition[] | Promise<BridgeActionDefinition[]>;
  execute(
    actionId: string,
    params: unknown,
    ctx: BridgeActionContext,
  ): Promise<BridgeActionResult>;
}

export type ApprovalMode = "allow" | "require_approval" | "deny";

export interface ActionSourceConfig {
  /** Service id (e.g. "github"). Used as the credential service name. */
  service: string;
  /** The plugin's ActionSource. */
  actions: BridgeActionSource;
  /** Override credential service (defaults to `service`). */
  credentialService?: string;
  /**
   * Default approval policy. Unset = derived from riskLevel:
   * low/medium → allow; high/critical → require_approval.
   */
  defaultApprovalMode?: ApprovalMode;
}

export interface ActionBridgeOptions {
  sources: ActionSourceConfig[];
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Build the [list_tools, call_tool] pair backed by an in-memory catalog
 * assembled from every ActionSource in `opts.sources`. The catalog is
 * resolved at construction time; if plugins can register dynamically later,
 * we'll need a refresh hook.
 */
export async function actionBridgeTools(
  opts: ActionBridgeOptions,
): Promise<ToolDef[]> {
  const catalog = await buildCatalog(opts.sources);
  return [makeListTool(catalog), makeCallTool(catalog)];
}

// ── Catalog ───────────────────────────────────────────────────────

interface CatalogEntry {
  service: string;
  config: ActionSourceConfig;
  def: BridgeActionDefinition;
  parameters: Record<string, unknown>;
}

interface Catalog {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
}

async function buildCatalog(sources: ActionSourceConfig[]): Promise<Catalog> {
  const entries: CatalogEntry[] = [];
  const byId = new Map<string, CatalogEntry>();
  for (const config of sources) {
    const defs = await config.actions.listActions();
    for (const def of defs) {
      const entry: CatalogEntry = {
        service: config.service,
        config,
        def,
        parameters: resolveParameters(def),
      };
      entries.push(entry);
      // Action ids are commonly already qualified (e.g. "github.create_issue").
      // If the plugin emits a bare id, qualify it.
      const fqid = def.id.includes(".") ? def.id : `${config.service}.${def.id}`;
      byId.set(fqid, entry);
      // Register both forms so tool_id="bare_id" works too (when unambiguous).
      if (def.id !== fqid && !byId.has(def.id)) byId.set(def.id, entry);
    }
  }
  return { entries, byId };
}

function resolveParameters(def: BridgeActionDefinition): Record<string, unknown> {
  if (def.inputSchema) return def.inputSchema;
  const json = zodToJsonSchema(def.params, { target: "jsonSchema7" });
  if (typeof json === "object" && json !== null) {
    const obj = json as Record<string, unknown>;
    delete obj.$schema;
    delete obj.$ref;
    delete obj.definitions;
    return obj;
  }
  return { type: "object", properties: {}, required: [] };
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
          const def = e.def;
          return (
            def.id.toLowerCase().includes(q) ||
            def.name.toLowerCase().includes(q) ||
            def.description.toLowerCase().includes(q)
          );
        });
      }

      // Per-service auth warnings: probe each represented service's
      // credentials and report missing ones so the LLM can ask the user to
      // reauthorize.
      const services = new Set(entries.map((e) => e.service));
      const warnings: Array<{ service: string; reason: string }> = [];
      for (const service of services) {
        const credService =
          catalog.entries.find((e) => e.service === service)?.config.credentialService ?? service;
        const cred = await ctx.credentials.get(credService);
        if (!cred) warnings.push({ service, reason: "no credential connected" });
      }

      const tools = entries.slice(0, limit).map((e) => ({
        service: e.service,
        tool_id: qualifiedId(e),
        name: e.def.name,
        description: e.def.description,
        riskLevel: e.def.riskLevel,
        params: e.parameters,
      }));

      const total = entries.length;
      const text = JSON.stringify(
        {
          tools,
          total,
          truncated: total > limit ? total - limit : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
        null,
        2,
      );
      return { text };
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
      // The LLM passes params as an object; we accept any JSON shape.
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
      const a = args as { tool_id: string; params?: Record<string, unknown>; summary: string };
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
          title: `Approve ${entry.def.name}?`,
          body: `${a.summary}\n\ntool_id=${a.tool_id}\nargs=${stableJson(a.params ?? {})}`,
          resumeKey: `${qualifiedId(entry)}:${stableJson(a.params ?? {})}`,
          context: {
            riskLevel: entry.def.riskLevel,
            service: entry.service,
            tool_id: a.tool_id,
            args: a.params,
          },
        });
        if (resolution.actionId !== "approve") {
          return { text: `denied: user did not approve ${a.tool_id}` };
        }
      }

      const credentialService = entry.config.credentialService ?? entry.service;
      const credentials = await resolveCredentials(ctx, credentialService);
      const actionCtx: BridgeActionContext = {
        credentials,
        userId: ctx.userId,
        orgId: ctx.orgId,
        callerIdentity: ctx.actor
          ? { name: ctx.actor.name ?? ctx.actor.id }
          : undefined,
        attribution: ctx.actor?.email
          ? { name: ctx.actor.name ?? ctx.actor.id, email: ctx.actor.email }
          : undefined,
      };

      let result: BridgeActionResult;
      try {
        result = await entry.config.actions.execute(entry.def.id, a.params ?? {}, actionCtx);
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
  if (entry.config.defaultApprovalMode) return entry.config.defaultApprovalMode;
  switch (entry.def.riskLevel) {
    case "low":
    case "medium":
      return "allow";
    case "high":
    case "critical":
      return "require_approval";
  }
}

function qualifiedId(entry: CatalogEntry): string {
  return entry.def.id.includes(".") ? entry.def.id : `${entry.service}.${entry.def.id}`;
}

async function resolveCredentials(
  ctx: ToolContext,
  service: string,
): Promise<Record<string, string>> {
  const cred = await ctx.credentials.get(service);
  if (!cred) return {};
  // Plugins read various keys: access_token, token, api_key. Map our typed
  // Credential into a flat string map matching the legacy IntegrationCredentials shape.
  const creds: Record<string, string> = {};
  if (cred.accessToken) {
    creds.access_token = cred.accessToken;
    creds.token = cred.accessToken;
  }
  if (cred.refreshToken) creds.refresh_token = cred.refreshToken;
  if (cred.metadata) {
    for (const [k, v] of Object.entries(cred.metadata)) {
      if (typeof v === "string") creds[k] = v;
    }
  }
  return creds;
}

function actionResultToToolResult(
  result: BridgeActionResult,
  toolId: string,
): ToolResult {
  const attachments: ToolAttachment[] = [];
  if (result.images) {
    for (const img of result.images) {
      attachments.push({
        type: "image",
        data: base64ToBytes(img.data),
        mimeType: img.mimeType,
        name: img.description,
      });
    }
  }

  if (!result.success) {
    return {
      text: `${toolId} failed: ${result.error ?? "unknown error"}`,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }
  if (result.data === undefined) {
    return {
      text: `${toolId} ok`,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }
  return {
    text: stableJson(result.data),
    attachments: attachments.length > 0 ? attachments : undefined,
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

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const binary = (globalThis as { atob: (s: string) => string }).atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

