/**
 * Agent-facing workflow actions (spec:
 * docs/specs/2026-07-31-workflow-chat-rendering-design.md). Exposed through
 * the plugin catalog (`list_tools`/`call_tool`) so the orchestrator can
 * create, inspect, and run dag/v1 workflows conversationally. Every result
 * carries the ids (`workflowId`/`runId`) the web chat renderer fetches by.
 */
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import { ValetError } from "@valet/shared";
import { WorkflowCursorError, type WorkflowDefinition, type WorkflowEdge } from "@valet/workflow";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import {
  appendRemovedEdgeHint,
  applyWorkflowModelPatch,
  applyWorkflowPatch,
  type WorkflowEdgeRef,
} from "./patch.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
} from "./schedule-service.js";
import {
  addAggregateNode,
  cancelWorkflowRun,
  copyWorkflowDefinition,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  isRunStatus,
  listRunsForOwner,
  listWorkflowDefinitions,
  resolveWorkflowApproval,
  RUN_STATUS_VALUES,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "./service.js";
import type { TeamServiceReadinessDeps } from "./team-service-readiness.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
  updateWorkflowTrigger,
} from "./trigger-service.js";
import { buildOrgValidateEnvironment, buildValidateEnvironment } from "./validation-env.js";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
  workflowWebhookUrl,
} from "./webhook-service.js";

/** Cap + bullet the validator's lint output for the LLM. The validator can
 * emit dozens of errors on a badly-shaped definition; the first ~20 are
 * plenty to act on and keep the tool result readable. */
export function formatLintErrors(errors: string[], cap = 20): string {
  const shown = errors.slice(0, cap).map((e) => `- ${e}`);
  const more = errors.length > cap ? `\n… and ${errors.length - cap} more` : "";
  return `workflow definition failed validation (fix these and retry):\n${shown.join("\n")}${more}`;
}

/** One sentence naming what to do about an error the caller did not cause. */
const PRE_EXISTING_ADVICE =
  "The workflow already held the error(s) below before this edit, so this edit did not cause them. " +
  "Fix them in the same call, or open the workflow in the editor and correct them first.";

/**
 * The clauses the validator appends to a message as advice, and the edge
 * index it puts in front of one. Both move when a DIFFERENT part of the
 * definition changes — see `findingKey`.
 */
const HINT_MARKERS = [" — ", " (available:", " (did you mean "];
const EDGE_INDEX = /^edge\[\d+\]/;

/**
 * An identity for one validator finding that holds across two validation
 * runs of two different definitions.
 *
 * The validator builds its advice from the WHOLE definition: the near-match
 * suggestion reads every node id, the "available roots" list reads every
 * alias root, and an edge carries its index in the edge array. An edit to
 * one node therefore rewrites the message of a finding in a different node
 * that the edit never touched. A raw string compare reads the rewritten text
 * as a new finding and tells the caller it caused an error that was already
 * there — the exact mistake this file exists to prevent. So cut the message
 * at the first advice clause and drop the edge index.
 *
 * The key is coarse on purpose. If two findings collapse onto one key, the
 * second one reads as pre-existing. That is the safe direction: the reply
 * still lists the finding in full and still refuses the edit.
 */
export function findingKey(message: string): string {
  let head = message;
  for (const marker of HINT_MARKERS) {
    const at = head.indexOf(marker);
    if (at !== -1) head = head.slice(0, at);
  }
  return head.replace(EDGE_INDEX, "edge");
}

/**
 * Format the lint output of an edit that does NOT re-send the whole
 * definition, such as a patch or an appended node. Such an edit revalidates
 * the merged whole, so an error in a node the caller never touched blocks it.
 * Without the split below the caller reads a stale trigger path in some other
 * node as its own mistake, and retries the same edit until it gives up.
 *
 * @param blocking every error that blocks the edit.
 * @param preExisting the errors the stored definition already carried.
 */
export function formatEditLintErrors(blocking: string[], preExisting: string[], cap = 20): string {
  const carried = new Set(preExisting.map(findingKey));
  const introduced = blocking.filter((e) => !carried.has(findingKey(e)));
  const inherited = blocking.filter((e) => carried.has(findingKey(e)));
  if (inherited.length === 0) return formatLintErrors(blocking, cap);

  const bullets = (list: string[]): string => {
    const shown = list.slice(0, cap).map((e) => `- ${e}`);
    const more = list.length > cap ? `\n… and ${list.length - cap} more` : "";
    return `${shown.join("\n")}${more}`;
  };
  const inheritedBlock = `${PRE_EXISTING_ADVICE}\n${bullets(inherited)}`;
  if (introduced.length === 0) {
    return `workflow definition failed validation (fix these and retry):\n${inheritedBlock}`;
  }
  return (
    `workflow definition failed validation (fix these and retry):\n` +
    `${bullets(introduced)}\n\n${inheritedBlock}`
  );
}

export function ownerFromContext(ctx: PluginActionContext): WorkflowOwner | null {
  const { userId, orgId } = ctx as { userId?: unknown; orgId?: unknown };
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  const actorUserId = ctx.actor?.id ?? userId;
  const principal = ctx.owner;
  if (principal?.type === "user") {
    if (principal.id !== actorUserId) return null;
    return { userId: actorUserId, orgId, principal: { type: "user", id: principal.id } };
  }
  if (principal?.type === "team") {
    // A team assistant with no acting user carries the team's own
    // principal id as its user id (`team:{id}`). That value is the
    // session's server-derived owner, not a person, so a membership read
    // of it always fails. Unattended runs — schedules, events, webhooks —
    // reach the workflow tools through exactly that context.
    //
    // The gate therefore turns on the ACTING user id above (the turn's
    // author when it has one, else the session's own user id): every value
    // other than the assistant's own team principal id names a person, and
    // a person's turn always carries an author.
    //
    // Three submitters set that author, and each one sets it from an
    // authenticated person: `routes/messages.ts` (the web client's own
    // prompt), `channels/host.ts` (a linked channel identity), and
    // `events/assistant-delivery.ts` (the actor an event subscription was
    // created by).
    //
    // A fourth submitter sets NO author: `orchestrator/signals.ts`
    // (`admitSignal`). A signal therefore reads as a machine turn and
    // widens this gate. `authorizeEdge` in that file is what bounds the
    // widening: it admits a parent-to-child or child-to-parent edge, and an
    // org-owned assistant to a user-owned one within one organization. A
    // user-to-user or user-to-team assistant edge is denied, so a person
    // cannot reach a team's workflows by signalling its assistant.
    //
    // The comparison assumes a principal id holds no colon. A user id
    // spelled `team:{id}` would otherwise read as that team's own machine
    // principal. Every id this code sees is a generated identifier, so
    // there is no runtime check here.
    const machinePrincipal = actorUserId === `${principal.type}:${principal.id}`;
    return {
      userId: actorUserId,
      orgId,
      principal: { type: "team", id: principal.id },
      requireTeamMembership: ctx.sessionPurpose !== "workflow" && !machinePrincipal,
    };
  }
  return { userId: actorUserId, orgId };
}

const NO_OWNER: PluginActionResult = {
  success: false,
  error: "no authenticated principal in tool context",
};

/**
 * Curried action builder (same shape as plugin-github's): the first call
 * binds T from the parameters schema; the second types `execute`'s args via
 * Static<T>, sidestepping TS's contextual-inference depth limit.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

/**
 * `getDeps` is a getter (not the deps object) because the plugin list is
 * assembled before the workflow store / run host exist at boot — same
 * one-slot-indirection pattern `providers/node.ts` uses for `childSpawner`.
 * It throws until provider wiring completes; actions only execute long
 * after boot, so callers never observe the window.
 */
/** The credential reads the team arm gate makes before a schedule or a
 * trigger arms (`team-service-readiness.ts#teamArmBlock`). */
function armDepsFrom(deps: WorkflowServiceDeps): TeamServiceReadinessDeps {
  return { db: deps.db, credentials: deps.credentials, plugins: deps.plugins ?? [], onePassword: deps.onePassword };
}

export function workflowsActionPlugin(getDeps: () => WorkflowServiceDeps): ActionPlugin {
  const copyToTeam = action(Type.Object({
    workflow_id: Type.String({ description: "Explicit personal workflow ID to copy." }),
    team_id: Type.String({ description: "Explicit destination team ID." }),
    name: Type.String({ description: "New workflow name in the destination team. Must not exist." }),
  }))({
    id: "workflows.copy_to_team",
    name: "Copy workflow to team",
    description: "Copy an explicit personal workflow JSON graph into a team under a new name. Requires membership. Returns the destination ID. Leaves the original and its triggers unchanged. Copies no schedules, event triggers, webhook secrets, credentials or nested workflows. Referenced IDs stay unchanged and may need remapping before team use.",
    riskLevel: "medium",
    execute: async ({ workflow_id, team_id, name }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      if (ctx.owner && (ctx.owner.type !== "user" || ctx.owner.id !== owner.userId)) {
        return { success: false, error: "Copy personal workflows from your personal assistant." };
      }
      try {
        const copy = await copyWorkflowDefinition(getDeps(), owner, workflow_id, { teamId: team_id, name });
        if (!copy) return { success: false, error: "Personal workflow not found. Check the source workflow ID." };
        return { success: true, data: { workflowId: copy.id, teamId: copy.ownerId, name: copy.name,
          note: "Copied graph only. Referenced IDs are unchanged; check team access before running or adding triggers." } };
      } catch (err) {
        if (err instanceof ValetError) return { success: false, error: err.message };
        throw err;
      }
    },
  });

  const listWorkflows = action(Type.Object({}))({
    id: "workflows.list_workflows",
    name: "List workflows",
    description: "List the assistant owner's workflow definitions (id, name, timestamps).",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const workflows = await listWorkflowDefinitions(getDeps(), owner);
      return {
        success: true,
        data: {
          workflows: workflows.map((w) => ({
            workflowId: w.id,
            name: w.name,
            updatedAt: w.updatedAt,
          })),
        },
      };
    },
  });

  const getWorkflow = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_workflow",
    name: "Get workflow",
    description: "Fetch one workflow definition (full dag/v1 nodes + edges) by id.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const wf = await getWorkflowDefinition(getDeps(), owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: {
          workflowId: wf.id,
          name: wf.name,
          definition: wf.definition,
          updatedAt: wf.updatedAt,
        },
      };
    },
  });

  const saveWorkflow = action(
    Type.Object({
      workflow_id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      definition: Type.Unknown(),
    }),
  )({
    id: "workflows.save_workflow",
    name: "Save workflow",
    description:
      "Create a workflow for the assistant owner (omit workflow_id) or update one (pass workflow_id). " +
      "`definition` MUST be a dag/v1 object: { version: 'dag/v1', nodes: [...], edges: [...] } " +
      "using node types trigger|set|if|wait|approval|session|thread|tool|llm|stop|foreach|workflow. " +
      "The definition is validated before saving; validation errors come back in `error`. " +
      "Returns { workflowId } — always surface it to the user.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, definition }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;

      // The validate env is best-effort: if deps aren't wired (early boot,
      // or a test that only exercises validation), lint without the
      // catalog hooks rather than failing the whole call.
      let validationDeps: WorkflowServiceDeps | undefined;
      try {
        validationDeps = getDeps();
      } catch {
        validationDeps = undefined;
      }
      const env = validationDeps
        ? await buildOrgValidateEnvironment(validationDeps, owner.orgId)
        : buildValidateEnvironment();
      const validation = validateDefinitionInput(definition, env);
      if (!validation.ok) {
        return {
          success: false,
          error: formatLintErrors(validation.errors),
        };
      }

      if (workflow_id) {
        const updated = await updateWorkflowDefinition(getDeps(), owner, workflow_id, {
          name,
          definition,
        });
        if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
        return {
          success: true,
          data: { workflowId: updated.id, name: updated.name, updatedAt: updated.updatedAt },
        };
      }

      const created = await createWorkflowDefinition(getDeps(), owner, {
        name: name ?? "Untitled workflow",
        definition,
        ...(owner.principal?.type === "team" ? { teamId: owner.principal.id } : {}),
      });
      return {
        success: true,
        data: { workflowId: created.id, name: created.name, updatedAt: created.updatedAt },
      };
    },
  });

  const startRun = action(
    Type.Object({
      workflow_id: Type.String(),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  )({
    id: "workflows.start_run",
    name: "Start workflow run",
    description:
      "Start a run of a workflow. Optional `input` becomes the trigger payload data. " +
      "Returns { runId, workflowId } — always surface the runId to the user.",
    riskLevel: "medium",
    execute: async ({ workflow_id, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      // The calling conversation, as-is. `startWorkflowRun` is the one
      // validator: it drops a session that is no assistant's, an assistant
      // that belongs to neither the caller nor the run, and a thread that
      // is archived or gone.
      const origin = ctx.sessionId && ctx.threadId
        ? { assistantSessionId: ctx.sessionId, threadId: ctx.threadId }
        : undefined;
      const started = await startWorkflowRun(deps, owner, workflow_id, input, origin);
      if (!started) return { success: false, error: `workflow not found: ${workflow_id}` };
      if ("invalidInput" in started) {
        return {
          success: false,
          error:
            `run input is invalid: ${started.invalidInput.map((e) => e.message).join(" ")} ` +
            "Fix the listed inputs and start the run again.",
        };
      }
      return {
        success: true,
        data: { runId: started.runId, workflowId: workflow_id, status: "pending" },
      };
    },
  });

  const deleteWorkflow = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.delete_workflow",
    name: "Delete workflow",
    description:
      "Permanently delete a workflow definition. Refused (with an error) while the workflow " +
      "has non-settled runs — cancel them first. Settled run history is kept.",
    riskLevel: "medium",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowDefinition(getDeps(), owner, workflow_id);
      if (result === "not_found") {
        return { success: false, error: `workflow not found: ${workflow_id}` };
      }
      if (result === "has_active_runs") {
        return {
          success: false,
          error: `workflow ${workflow_id} has runs that are not settled — cancel them first, then delete`,
        };
      }
      return { success: true, data: { workflowId: workflow_id, deleted: true } };
    },
  });

  const getRun = action(Type.Object({ run_id: Type.String() }))({
    id: "workflows.get_run",
    name: "Get workflow run",
    description:
      "Fetch a run's status, outcome, per-node checkpoints, and what it is waiting on " +
      "(timers, signals, approvals). Use to check progress or find pending approval gates.",
    riskLevel: "low",
    execute: async ({ run_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const detail = await getWorkflowRunDetail(getDeps(), owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      return {
        success: true,
        data: {
          runId: detail.run.runId,
          workflowId: detail.run.workflowId,
          status: detail.run.status,
          outcome: detail.run.outcome,
          waitingOn: detail.run.waitingOn,
          checkpoints: detail.checkpoints.map((cp) => ({
            nodeId: cp.nodeId,
            iteration: cp.iteration,
            status: cp.status,
            error: cp.error,
            // The session a session node drove, and the run a workflow node
            // started — how the agent reaches a failed node's actual output.
            sessionId: cp.sessionId,
            childRunId: cp.childRunId,
          })),
        },
      };
    },
  });

  const listRuns = action(
    Type.Object({
      workflow_id: Type.Optional(Type.String()),
      parent_run_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number()),
      cursor: Type.Optional(Type.String()),
    }),
  )({
    id: "workflows.list_runs",
    name: "List workflow runs",
    description:
      "List runs (runId, status, outcome, timestamps), newest first. Omit workflow_id " +
      "for every workflow you can reach. Pass parent_run_id to track one batch's child " +
      "runs. Parked runs also carry waitingOn — the node and signal/timer each is blocked " +
      "on (signalType approval:<nodeId> = an approval node OR a policy gate on a tool " +
      "node). Use to find parked/pending runs before cancelling or checking approvals. " +
      "Paginated: pass the returned nextCursor back as cursor for the next page.",
    riskLevel: "low",
    execute: async ({ workflow_id, parent_run_id, status, limit, cursor }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const badStatus = status?.filter((s) => !isRunStatus(s));
      if (badStatus && badStatus.length > 0) {
        return {
          success: false,
          error: `unknown run status ${badStatus.join(", ")} — use one of: ${RUN_STATUS_VALUES.join(", ")}`,
        };
      }
      let page;
      try {
        page = await listRunsForOwner(getDeps(), owner, {
          workflowIds: workflow_id === undefined ? undefined : [workflow_id],
          status: status?.filter(isRunStatus),
          parentRunId: parent_run_id,
          limit,
          cursor,
        });
      } catch (err) {
        if (err instanceof WorkflowCursorError) return { success: false, error: err.message };
        throw err;
      }
      if (!page) return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: workflow_id, ...page } };
    },
  });

  const cancelRun = action(Type.Object({ run_id: Type.String() }))({
    id: "workflows.cancel_run",
    name: "Cancel workflow run",
    description:
      "Terminate a run (running, parked on a wait, or pending approval). Settling is " +
      "asynchronous — re-check with get_run after a few seconds if a follow-up (e.g. " +
      "delete_workflow) reports active runs.",
    riskLevel: "medium",
    execute: async ({ run_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Self-invocation guard: a workflow session must not cancel runs.
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot cancel runs. Request cancellation through the web UI or API." };
      }
      const result = await cancelWorkflowRun(getDeps(), owner, run_id);
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      return { success: true, data: { runId: run_id, cancelled: true } };
    },
  });

  const resolveApproval = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      approved: Type.Boolean(),
      note: Type.Optional(Type.String()),
      iteration: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.resolve_approval",
    name: "Resolve workflow approval",
    description:
      "Approve or deny a run's pending approval-node gate. Approval gates exist for HUMANS — " +
      "only call this when the user has explicitly told you their decision in this " +
      "conversation; never resolve a gate on your own judgment. (This action itself " +
      "requires the user's confirmation.) Policy gates on tool nodes must be resolved " +
      "from the run page, not via this action.",
    riskLevel: "high",
    execute: async ({ run_id, node_id, approved, note, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Self-invocation guard: a workflow session must not resolve approval gates.
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot resolve approval gates. A human must resolve this gate from the run page." };
      }
      const result = await resolveWorkflowApproval(getDeps(), owner, {
        runId: run_id,
        nodeId: node_id,
        approved,
        note,
        iteration,
        via: "agent",
      });
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      if (result === "not_parked") return { success: false, error: `run ${run_id} is not parked on approval gate ${node_id}` };
      if (result === "already_resolved") return { success: false, error: `approval gate ${node_id} on run ${run_id} has already been resolved` };
      if (result === "timed_out") return { success: false, error: `approval gate ${node_id} on run ${run_id} has timed out` };
      if (result === "human_only") return { success: false, error: "A human must resolve this policy gate from the run page." };
      if (result === "forbidden_always") return { success: false, error: "scope=always requires an org admin" };
      if (result === "org_mismatch") return { success: false, error: "not a member of this workflow's org" };
      return { success: true, data: { runId: run_id, nodeId: node_id, approved } };
    },
  });

  const patchWorkflow = action(
    Type.Object({
      workflow_id: Type.String(),
      name: Type.Optional(Type.String()),
      upsert_nodes: Type.Optional(Type.Array(Type.Unknown())),
      remove_node_ids: Type.Optional(Type.Array(Type.String())),
      add_edges: Type.Optional(
        Type.Array(
          Type.Object({
            from: Type.String(),
            to: Type.String(),
            fromOutput: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
            when: Type.Optional(Type.String()),
          }),
        ),
      ),
      remove_edges: Type.Optional(
        Type.Array(
          Type.Object({
            from: Type.String(),
            to: Type.String(),
            fromOutput: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
          }),
        ),
      ),
    }),
  )({
    id: "workflows.patch_workflow",
    name: "Patch workflow",
    description:
      "Edit a workflow WITHOUT re-sending the whole definition: rename, upsert single nodes " +
      "(replace-by-id or append), remove nodes (their edges go too), add/remove edges. " +
      "Prefer this over save_workflow for small edits — the patched result runs the full " +
      "linter, so a bad patch returns lint errors instead of saving. The linter reads the " +
      "WHOLE merged definition, so an error in a node you did not touch also blocks the " +
      "patch; the reply names those errors as pre-existing.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, upsert_nodes, remove_node_ids, add_edges, remove_edges }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const wf = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };

      const stored = wf.definition;
      if (
        typeof stored !== "object" ||
        stored === null ||
        !Array.isArray((stored as { nodes?: unknown }).nodes) ||
        !Array.isArray((stored as { edges?: unknown }).edges)
      ) {
        return { success: false, error: "stored definition is not a dag/v1 workflow" };
      }

      const patched = applyWorkflowPatch(stored as WorkflowDefinition, {
        upsertNodes: upsert_nodes,
        removeNodeIds: remove_node_ids,
        addEdges: add_edges as WorkflowEdge[] | undefined,
        removeEdges: remove_edges as WorkflowEdgeRef[] | undefined,
      });
      if (!patched.ok) return { success: false, error: formatLintErrors(patched.errors) };

      // A rename changes no node and no edge, so it cannot introduce a lint
      // error. Revalidating anyway would refuse to rename a workflow that
      // already holds one — while `PUT /api/workflows/:id` renames the same
      // workflow without complaint, because it validates only when the
      // request carries a definition. Match that, and keep the two surfaces
      // from disagreeing about the same edit.
      const changesGraph =
        (upsert_nodes !== undefined && upsert_nodes.length > 0) ||
        (remove_node_ids !== undefined && remove_node_ids.length > 0) ||
        (add_edges !== undefined && add_edges.length > 0) ||
        (remove_edges !== undefined && remove_edges.length > 0);

      if (changesGraph) {
        const env = await buildOrgValidateEnvironment(deps, owner.orgId);
        const validation = validateDefinitionInput(patched.definition, env);
        if (!validation.ok) {
          // Validate the stored definition too, so the reply can say which
          // errors the patch introduced and which the workflow already held.
          const before = validateDefinitionInput(stored, env);
          // When the patch removed edges and the lint reports unreachable
          // nodes, the removal is the likely cause — say so in one line.
          const withHint = appendRemovedEdgeHint(
            validation.errors,
            remove_edges as WorkflowEdgeRef[] | undefined,
          );
          return {
            success: false,
            error: formatEditLintErrors(withHint, before.ok ? [] : before.errors),
          };
        }
      }

      const updated = await updateWorkflowDefinition(deps, owner, workflow_id, {
        name,
        definition: patched.definition,
      });
      if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: {
          workflowId: updated.id,
          name: updated.name,
          nodes: patched.definition.nodes.length,
          edges: patched.definition.edges.length,
        },
      };
    },
  });

  const updateModel = action(
    Type.Object({
      workflow_id: Type.String(),
      model: Type.String({ description: "An approved catalog model id or a size tier: xs, s, m, l, xl." }),
      node_ids: Type.Optional(Type.Array(Type.String(), {
        description: "Only these llm or session nodes. Omit to update all model-capable nodes.",
      })),
    }),
  )({
    id: "workflows.update_model",
    name: "Update workflow model",
    description:
      "Change the model on selected llm or session nodes without replacing the workflow definition. " +
      "Omit node_ids to update all such nodes, including foreach bodies. Orchestrator nodes use their " +
      "assistant's saved model and are not changed. The model must be an approved active catalog model " +
      "or an org model tier.",
    riskLevel: "medium",
    execute: async ({ workflow_id, model, node_ids }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const catalog = await buildOrgCatalog(deps.db, deps.credentials, owner.orgId);
      if (!catalogValidIds(catalog).has(model)) {
        return {
          success: false,
          error: `unknown or inactive model: ${model}. Pick an approved model from GET /api/models, or use xs, s, m, l, or xl.`,
        };
      }
      const concrete = catalog.find((entry) =>
        entry.id === model || (entry.id.startsWith("anthropic/") && entry.id.slice("anthropic/".length) === model),
      );
      if (concrete && !concrete.approved) {
        return { success: false, error: `model ${model} is not approved. Choose an approved model or an org model tier.` };
      }

      const wf = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };
      const stored = validateDefinitionInput(wf.definition);
      if (!stored.ok) return { success: false, error: formatLintErrors(stored.errors) };
      const patched = applyWorkflowModelPatch(stored.definition, model, node_ids);
      if (!patched.ok) return { success: false, error: formatLintErrors(patched.errors) };
      const validation = validateDefinitionInput(patched.definition, await buildOrgValidateEnvironment(deps, owner.orgId));
      if (!validation.ok) return { success: false, error: formatLintErrors(validation.errors) };
      const updated = await updateWorkflowDefinition(deps, owner, workflow_id, { definition: patched.definition });
      if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: updated.id, model, nodeIds: patched.nodeIds } };
    },
  });

  const addAggregate = action(
    Type.Object({
      workflow_id: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("collect"), Type.Literal("summarize")])),
      model: Type.Optional(Type.String()),
      node_id: Type.Optional(Type.String()),
      sources: Type.Optional(Type.Array(Type.String())),
      instructions: Type.Optional(Type.String()),
    }),
  )({
    id: "workflows.add_aggregate",
    name: "Add aggregation node",
    description:
      "Append a node that combines several parallel branches into one result, wired with the " +
      "correct template path for each branch's node type (an llm branch reads result.text, a " +
      "session branch result.response, a branch with an outputSchema result.output). " +
      'mode "collect" (default) writes a set node with one field per branch; mode "summarize" ' +
      "writes an llm node and needs `model`. Omit `sources` to take every branch with no " +
      "outgoing edge. The node is an ordinary node afterwards — editable and removable like any other.",
    riskLevel: "medium",
    execute: async ({ workflow_id, mode, model, node_id, sources, instructions }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await addAggregateNode(
        deps,
        owner,
        workflow_id,
        { mode, model, nodeId: node_id, sources, instructions },
        await buildOrgValidateEnvironment(deps, owner.orgId),
      );
      if (!result.ok) {
        if (result.reason === "not_found") return { success: false, error: `workflow not found: ${workflow_id}` };
        // This action appends a node to the stored definition, so an error
        // the stored definition already held blocks it. Say so: the caller
        // cannot see the offending node from the arguments it sent.
        //
        // Both arguments are the same list ON PURPOSE. This reason code is
        // raised by validating the STORED definition alone, before the node
        // is appended (`addAggregateNode`), so every error in it is by
        // definition pre-existing. An error the appended node introduces
        // arrives under `would_be_invalid` instead, and is formatted below
        // as the caller's own. Keep the two reason codes apart if this
        // action ever takes a user-supplied path.
        if (result.reason === "stored_definition_invalid") {
          return { success: false, error: formatEditLintErrors(result.errors, result.errors) };
        }
        // Two failure shapes: a lint list, or one sentence naming the fix.
        if ("errors" in result) return { success: false, error: formatLintErrors(result.errors) };
        return { success: false, error: result.message };
      }
      return {
        success: true,
        data: {
          workflowId: result.definition.id,
          nodeId: result.nodeId,
          sources: result.sources,
          updatedAt: result.definition.updatedAt,
        },
      };
    },
  });

  const getNodeResult = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      iteration: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.get_node_result",
    name: "Get node result",
    description:
      "Fetch a run node's FULL checkpoint output (result + error) — use when debugging a " +
      "failed or surprising node; get_run intentionally omits result bodies. `result` is " +
      "the checkpoint value verbatim (the same value templates read via nodes.<id>.result); " +
      "an oversized result comes back as { truncated: true, jsonPrefix }. Foreach body " +
      "nodes have one checkpoint per iteration; pass `iteration` to narrow.",
    riskLevel: "low",
    execute: async ({ run_id, node_id, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const detail = await getWorkflowRunDetail(getDeps(), owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      const matches = detail.checkpoints.filter(
        (cp) => cp.nodeId === node_id && (iteration === undefined || cp.iteration === iteration),
      );
      if (matches.length === 0) {
        const known = [...new Set(detail.checkpoints.map((cp) => cp.nodeId))];
        return {
          success: false,
          error: `run ${run_id} has no checkpoint for node ${JSON.stringify(node_id)} (nodes with checkpoints: ${known.join(", ") || "none"})`,
        };
      }
      return {
        success: true,
        data: {
          runId: run_id,
          nodeId: node_id,
          checkpoints: matches.map((cp) => ({
            iteration: cp.iteration,
            status: cp.status,
            error: cp.error,
            result: presentResult(cp.result, 20_000),
          })),
        },
      };
    },
  });

  const listEventTypesAction = action(Type.Object({}))({
    id: "workflows.list_event_types",
    name: "List event types",
    description:
      "List the event keys workflows can be triggered by (per service, with filterable " +
      "fields). Use before create_trigger to pick a valid event key.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const services = listEventTypes(getDeps().plugins ?? []);
      if (services.length === 0) {
        return {
          success: true,
          data: { services, note: "no event-emitting integrations are connected yet" },
        };
      }
      return { success: true, data: { services } };
    },
  });

  const createTrigger = action(
    Type.Object({
      workflow_id: Type.String(),
      name: Type.String(),
      event_keys: Type.Array(Type.String(), {
        description: 'Event key patterns; trailing ".*" wildcard supported (e.g. "github.pull_request.*").',
      }),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal("eq"),
              Type.Literal("in"),
              Type.Literal("prefix"),
              Type.Literal("contains"),
            ]),
            value: Type.Unknown(),
          }),
        ),
      ),
      any_channel: Type.Optional(
        Type.Boolean({
          description:
            "slack.app_mention only: listen in every channel the app can see, instead of a " +
            "required channel filter.",
        }),
      ),
    }),
  )({
    id: "workflows.create_trigger",
    name: "Create workflow trigger",
    description:
      "Make a workflow run automatically on matching events (event-driven only — cron " +
      "schedules are not supported yet). The event arrives in templates as " +
      "{{trigger.data.payload...}} plus {{trigger.data.key}}/{{trigger.data.refs...}}. " +
      "Returns { triggerId }.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, event_keys, filters, any_channel }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await createWorkflowTrigger(
        armDepsFrom(deps),
        owner,
        { workflowId: workflow_id, name, eventKeys: event_keys, filters, anyChannel: any_channel },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.trigger };
    },
  });

  const listTriggers = action(
    Type.Object({ workflow_id: Type.Optional(Type.String()) }),
  )({
    id: "workflows.list_triggers",
    name: "List workflow triggers",
    description: "List event triggers targeting workflows (optionally one workflow's).",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const triggers = await listWorkflowTriggers(getDeps().db, owner, workflow_id);
      return { success: true, data: { triggers } };
    },
  });

  const createSchedule = action(
    Type.Object({
      workflow_id: Type.Optional(
        Type.String({ description: "Target a workflow: start a run each fire." }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "Target the orchestrator instead: this prompt is delivered to you (the " +
            "orchestrator) each fire, on a dedicated thread. Provide exactly one of " +
            "workflow_id or prompt.",
        }),
      ),
      name: Type.String(),
      cron: Type.String({
        description: '5-field cron expression, e.g. "0 9 * * 1-5" = 9:00 every weekday.',
      }),
      timezone: Type.Optional(
        Type.String({ description: 'IANA timezone name (default "UTC"), e.g. "America/Denver".' }),
      ),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Workflow target only: static payload delivered as {{trigger.data.input...}}.",
        }),
      ),
    }),
  )({
    id: "workflows.create_schedule",
    name: "Create schedule",
    description:
      "Run something on a cron schedule: a WORKFLOW (workflow_id → a run starts each fire) " +
      "or the ORCHESTRATOR (prompt → you receive the prompt each fire, e.g. 'check my PRs " +
      "every morning'). Fires are accurate to ~30s; missed fires during downtime collapse " +
      "into one catch-up. Returns { scheduleId, nextFireAt }.",
    riskLevel: "medium",
    execute: async ({ workflow_id, prompt, name, cron, timezone, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await createWorkflowSchedule(
        armDepsFrom(getDeps()),
        owner,
        {
          workflowId: workflow_id,
          prompt,
          name,
          cron,
          timezone,
          input,
          teamId: owner.principal?.type === "team" ? owner.principal.id : undefined,
        },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.schedule };
    },
  });

  const listSchedules = action(
    Type.Object({ workflow_id: Type.Optional(Type.String()) }),
  )({
    id: "workflows.list_schedules",
    name: "List workflow schedules",
    description: "List cron schedules (optionally one workflow's) with next/last fire times.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const schedules = await listWorkflowSchedules(getDeps().db, owner, workflow_id);
      return { success: true, data: { schedules } };
    },
  });

  const deleteSchedule = action(Type.Object({ schedule_id: Type.String() }))({
    id: "workflows.delete_schedule",
    name: "Delete workflow schedule",
    description: "Delete a cron schedule by id (from list_schedules/create_schedule).",
    riskLevel: "medium",
    execute: async ({ schedule_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowSchedule(getDeps().db, owner, schedule_id);
      if (result === "not_found") return { success: false, error: `schedule not found: ${schedule_id}` };
      return { success: true, data: { scheduleId: schedule_id, deleted: true } };
    },
  });

  const deleteTrigger = action(Type.Object({ trigger_id: Type.String() }))({
    id: "workflows.delete_trigger",
    name: "Delete workflow trigger",
    description: "Delete a workflow trigger by id (from list_triggers/create_trigger).",
    riskLevel: "medium",
    execute: async ({ trigger_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowTrigger(getDeps().db, owner, trigger_id);
      if (result === "not_found") return { success: false, error: `trigger not found: ${trigger_id}` };
      return { success: true, data: { triggerId: trigger_id, deleted: true } };
    },
  });

  const updateSchedule = action(
    Type.Object({
      schedule_id: Type.String(),
      name: Type.Optional(Type.String()),
      cron: Type.Optional(
        Type.String({
          description: '5-field cron expression, e.g. "0 9 * * 1-5". Changes recompute next fire time.',
        }),
      ),
      timezone: Type.Optional(
        Type.String({ description: 'IANA timezone name, e.g. "America/Denver". Changes recompute next fire time.' }),
      ),
      enabled: Type.Optional(
        Type.Boolean({ description: "false pauses the schedule; re-enabling recomputes next fire time." }),
      ),
      prompt: Type.Optional(Type.String({ description: "Orchestrator-target schedules only." })),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Workflow-target schedules only. Pass null to clear a previously set input.",
        }),
      ),
    }),
  )({
    id: "workflows.update_schedule",
    name: "Update schedule",
    description:
      "Update a cron schedule by id. Changing cron or timezone recomputes next fire time. " +
      "Setting enabled=false pauses the schedule; re-enabling recomputes next fire time so a stale slot does not fire at once. " +
      "Target kind (workflow vs orchestrator) cannot change — delete and recreate to switch.",
    riskLevel: "medium",
    execute: async ({ schedule_id, name, cron, timezone, enabled, prompt, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await updateWorkflowSchedule(
        getDeps().db,
        owner,
        schedule_id,
        { name, cron, timezone, enabled, prompt, input },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.schedule };
    },
  });

  const updateTrigger = action(
    Type.Object({
      trigger_id: Type.String(),
      name: Type.Optional(Type.String()),
      event_keys: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Event key patterns; trailing ".*" wildcard supported.',
        }),
      ),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal("eq"),
              Type.Literal("in"),
              Type.Literal("prefix"),
              Type.Literal("contains"),
            ]),
            value: Type.Unknown(),
          }),
        ),
      ),
      enabled: Type.Optional(Type.Boolean()),
      any_channel: Type.Optional(
        Type.Boolean({
          description:
            "slack.app_mention only: listen in every channel the app can see, instead of a " +
            "required channel filter.",
        }),
      ),
    }),
  )({
    id: "workflows.update_trigger",
    name: "Update event trigger",
    description:
      "Update a workflow event trigger by id. All fields are optional; only supplied fields change. " +
      "Changing event_keys or filters re-validates against the event catalog.",
    riskLevel: "medium",
    execute: async ({ trigger_id, name, event_keys, filters, enabled, any_channel }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await updateWorkflowTrigger(
        armDepsFrom(deps),
        owner,
        trigger_id,
        { name, eventKeys: event_keys, filters, enabled, anyChannel: any_channel },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.trigger };
    },
  });

  const createWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.create_webhook",
    name: "Create or rotate workflow webhook",
    description:
      "Mint an arbitrary-URL trigger for a workflow: POST any JSON to the returned URL and a run " +
      "starts, no Valet auth required — the URL itself is the credential. Calling this again on the " +
      "same workflow ROTATES the secret: the old URL stops working immediately. Returns { workflowId, " +
      "hookId, url }.",
    // high, not medium: this mints a bearer secret that is the ENTIRE auth
    // for triggering a run — equivalent in blast radius to granting a new
    // credential, which the plugin catalog's default policy (medium ==
    // auto-allow) would otherwise let the agent do with no human in the
    // loop, the same reasoning that keeps resolve_approval at "high".
    riskLevel: "high",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await mintOrRotateWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (!result.ok) return { success: false, error: result.error };
      return {
        success: true,
        data: { ...result.webhook, url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId) },
      };
    },
  });

  const getWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_webhook",
    name: "Get workflow webhook",
    description: "Look up the current webhook URL for a workflow, or null if none has been minted.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await getWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (!result.ok) return { success: false, error: result.error };
      if (!result.webhook) return { success: true, data: { webhook: null } };
      return {
        success: true,
        data: { webhook: { ...result.webhook, url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId) } },
      };
    },
  });

  const deleteWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.delete_webhook",
    name: "Delete workflow webhook",
    description: "Remove a workflow's webhook trigger, if any. The URL 404s afterward.",
    riskLevel: "medium",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (result === "not_found") return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: workflow_id, deleted: result === "deleted" } };
    },
  });

  return {
    service: "workflows",
    description:
      "Create, inspect, and run Valet DAG workflows (dag/v1 definitions: nodes + edges).",
    actions: [
      copyToTeam,
      listWorkflows,
      getWorkflow,
      saveWorkflow,
      patchWorkflow,
      updateModel,
      addAggregate,
      deleteWorkflow,
      startRun,
      getRun,
      getNodeResult,
      listRuns,
      cancelRun,
      resolveApproval,
      listEventTypesAction,
      createTrigger,
      listTriggers,
      deleteTrigger,
      updateTrigger,
      createSchedule,
      listSchedules,
      deleteSchedule,
      updateSchedule,
      createWebhook,
      getWebhook,
      deleteWebhook,
    ],
  };
}

/**
 * Return a checkpoint result verbatim when its JSON fits `maxChars`, so the
 * agent sees the same structured value templates read via
 * `nodes.<id>.result`. An oversized result becomes a `{ truncated: true,
 * jsonPrefix }` stub so a giant payload can't blow up the LLM context.
 * (An earlier always-stringified wrapper here read as the checkpoint's own
 * shape and convinced agents the data was unreachable.)
 */
function presentResult(value: unknown, maxChars: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch (err) {
    json = `<unserializable: ${err instanceof Error ? err.message : String(err)}>`;
    return { truncated: true, jsonPrefix: json };
  }
  if (json.length <= maxChars) return value;
  return { truncated: true, jsonPrefix: json.slice(0, maxChars) };
}
