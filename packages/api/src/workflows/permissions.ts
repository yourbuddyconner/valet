/** Permission preview and durable grants scoped to one workflow and its owner.
 * Explicit policy restrictions remain authoritative; human approval nodes are separate.
 */
import type { AppQueryable } from "../lib/drizzle.js";
import { and, eq } from "drizzle-orm";
import { workflowActionGrants } from "../schema/index.js";
import { canAdministerTeam } from "../services/teams.js";
import { resolvePolicyDecision } from "../policies/resolution.js";
import { loadPolicyRows } from "../policies/service.js";
import { findAction, qualifiedActionId } from "../plugins/action-invoker.js";
import type {
  AllowWorkflowPermissionsResponse,
  WorkflowNodePermissionWire,
  WorkflowDefinitionSummary,
} from "../wire/types.js";
import { getWorkflowDefinition, type WorkflowOwner, type WorkflowServiceDeps } from "./service.js";

/** A tool node's identity, narrowed from the stored definition JSON. The
 * definition was validated at save time, but tool-node rows can predate the
 * catalog or be inserted by imports, so this narrows instead of casting. */
interface ToolNodeRef {
  nodeId: string;
  service: string;
  action: string;
  params: Record<string, unknown> | undefined;
}

function toolNodeRefs(definition: unknown): ToolNodeRef[] {
  if (typeof definition !== "object" || definition === null) return [];
  const nodes = (definition as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const refs: ToolNodeRef[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as Record<string, unknown>;
    if (typeof n.id !== "string") continue;
    if (n.type === "tool") {
      const ref = toToolRef(n.id, n);
      if (ref) refs.push(ref);
      continue;
    }
    // A foreach body can be a tool node, and the foreach executor dispatches
    // it through the same policy enforcement as a top-level tool node. The
    // ref carries the FOREACH node's id so the editor badge lands on the
    // card that is actually drawn. Body nesting depth is 1 by the dag/v1
    // types — a foreach cannot contain another foreach.
    if (n.type === "foreach" && typeof n.body === "object" && n.body !== null) {
      const body = n.body as Record<string, unknown>;
      if (body.type !== "tool") continue;
      const ref = toToolRef(n.id, body);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** Narrows one tool-node object to a ref, or null when service/action are
 * not both strings. `nodeId` is the DISPLAYED node's id — for a foreach
 * body that is the foreach node itself. */
function toToolRef(nodeId: string, n: Record<string, unknown>): ToolNodeRef | null {
  if (typeof n.service !== "string" || typeof n.action !== "string") return null;
  const params =
    typeof n.params === "object" && n.params !== null && !Array.isArray(n.params)
      ? (n.params as Record<string, unknown>)
      : undefined;
  return { nodeId, service: n.service, action: n.action, params };
}

/** Predicts the policy resolution of every tool node for the stored owner.
 * Returns null when the workflow does not exist for this owner (the caller
 * 404s). Actions absent from the static plugin catalog (dynamic MCP
 * actions) report `mode: "unknown"` — no risk level exists to resolve with
 * until discovery runs, and discovery touches credentials, which a read
 * endpoint must not do. */
export async function analyzeWorkflowPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<WorkflowNodePermissionWire[] | null> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary) return null;
  return analyzeDefinitionPermissions(deps, owner, summary);
}

async function analyzeDefinitionPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  summary: WorkflowDefinitionSummary,
): Promise<WorkflowNodePermissionWire[]> {
  const refs = toolNodeRefs(summary.definition);
  if (refs.length === 0) return [];

  const now = Date.now();
  // One row load for the whole definition: the scope has no per-node
  // component (no session/execution id — a run that has not started has no
  // grants), so a per-node `resolveActionPolicy` would re-read the same two
  // row sets N times. The pure core then decides per node from one
  // consistent snapshot.
  const rows = await loadPolicyRows(deps.db, {
    orgId: owner.orgId,
    workflowId: summary.id,
    userId: summary.ownerType === "user" ? summary.ownerId : owner.userId,
    teamId: summary.ownerType === "team" ? summary.ownerId : undefined,
  });
  const nodes: WorkflowNodePermissionWire[] = [];
  for (const ref of refs) {
    const entry = deps.actionPluginByService?.get(ref.service);
    const action = entry ? findAction(entry.actionPlugin.actions, ref.service, ref.action) : undefined;
    if (!entry || !action) {
      nodes.push({ nodeId: ref.nodeId, service: ref.service, action: ref.action, actionId: null, mode: "unknown" });
      continue;
    }
    const actionId = qualifiedActionId(ref.service, action);
    const decision = resolvePolicyDecision(
      rows,
      {
        service: ref.service,
        actionId,
        riskLevel: action.riskLevel,
        params: ref.params,
        appliesIn: "workflow",
        now,
      },
      entry.actionPlugin.defaultApprovalMode,
    );
    nodes.push({
      nodeId: ref.nodeId,
      service: ref.service,
      action: ref.action,
      actionId,
      riskLevel: action.riskLevel,
      mode: decision.mode,
      provenance: decision.provenance.source,
    });
  }
  return nodes;
}

export type AllowWorkflowPermissionsOutcome =
  | { ok: true; result: AllowWorkflowPermissionsResponse; grants: (typeof workflowActionGrants.$inferInsert)[] }
  | { ok: false; badRequest: string }
  | null;

/** Grants only the stored workflow's declared gating actions, never caller-invented actions. */
export async function prepareWorkflowPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  actionIds: string[] | undefined,
): Promise<AllowWorkflowPermissionsOutcome> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary) return null;
  if (!(await canGrantWorkflowPermissions(deps, owner, summary))) {
    return { ok: false, badRequest: "Only the workflow owner or a team admin can manage its permissions." };
  }
  const analysis = await analyzeDefinitionPermissions(deps, owner, summary);

  // Dedupe: one override per qualified actionId, however many nodes call it.
  const gating = new Map<string, string>();
  for (const node of analysis) {
    if (node.mode === "require_approval" && node.actionId !== null) {
      gating.set(node.actionId, node.service);
    }
  }

  let targets: string[];
  if (actionIds === undefined) {
    targets = [...gating.keys()];
  } else {
    for (const id of actionIds) {
      if (!gating.has(id)) {
        return {
          ok: false,
          badRequest:
            `"${id}" is not a gating action of this workflow. ` +
            `Request only actionIds reported with mode "require_approval" by GET .../permissions.`,
        };
      }
    }
    targets = [...new Set(actionIds)];
  }

  const now = Date.now();
  const allowed: string[] = [];
  const grants: (typeof workflowActionGrants.$inferInsert)[] = [];
  const blocked: { actionId: string; reason: string }[] = [];
  for (const actionId of targets) {
    const node = analysis.find((node) => node.actionId === actionId);
    if (node?.provenance === "org_policy" || node?.provenance === "team_policy" || node?.provenance === "override") {
      blocked.push({ actionId, reason: "An explicit policy requires approval. Ask its administrator to review it." });
      continue;
    }
    grants.push({
      id: JSON.stringify([owner.orgId, workflowId, summary.ownerType, summary.ownerId, actionId]),
      orgId: owner.orgId, workflowId, ownerType: summary.ownerType, ownerId: summary.ownerId,
      actionId, grantedBy: owner.userId, createdAt: now,
    });
    allowed.push(actionId);
  }
  return { ok: true, result: { allowed, blocked }, grants };
}

async function canGrantWorkflowPermissions(deps: WorkflowServiceDeps, owner: WorkflowOwner, summary: WorkflowDefinitionSummary) {
  if (owner.principal?.type === "team") return false;
  return summary.ownerType === "user" ? summary.ownerId === owner.userId
    : summary.ownerType === "team" && await canAdministerTeam(deps.db, summary.ownerId, owner.userId);
}

export async function revokeWorkflowPermissions(deps: WorkflowServiceDeps, owner: WorkflowOwner, workflowId: string): Promise<boolean> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary || !(await canGrantWorkflowPermissions(deps, owner, summary))) return false;
  await deps.db.delete(workflowActionGrants).where(and(eq(workflowActionGrants.orgId, owner.orgId), eq(workflowActionGrants.workflowId, workflowId)));
  return true;
}

export async function persistWorkflowPermissions(db: AppQueryable, grants: (typeof workflowActionGrants.$inferInsert)[]) {
  if (grants.length) await db.insert(workflowActionGrants).values(grants).onConflictDoNothing();
}

export async function allowWorkflowPermissions(deps: WorkflowServiceDeps, owner: WorkflowOwner, workflowId: string, actionIds: string[] | undefined): Promise<AllowWorkflowPermissionsOutcome> {
  const prepared = await prepareWorkflowPermissions(deps, owner, workflowId, actionIds);
  if (prepared?.ok) await persistWorkflowPermissions(deps.db, prepared.grants);
  return prepared;
}
