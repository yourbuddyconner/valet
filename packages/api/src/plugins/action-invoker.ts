/**
 * Headless ActionInvoker (plugin-system-v2 plan Task 6) — the real
 * implementation behind the workflow `tool` node's `engine.invokeAction`
 * seam. See `@valet/workflow`'s `packages/workflow/src/engine-deps.ts` JSDoc
 * on `WorkflowEngineDeps.invokeAction` for the normative contract this must
 * satisfy: `invocationId` is deterministic (minted once by the tool
 * executor, reused across resumed drives), and a duplicate `invocationId`
 * MUST return the ORIGINAL result rather than re-invoking the action or
 * erroring.
 *
 * Durable dedup: `action_invocations` (invocation_id PK, result JSON text,
 * created_at) records every outcome — including deterministic failures
 * (unknown action, param validation, unsupported owner type) — because
 * those must be just as stable across retries as a success. `INSERT OR
 * IGNORE` (`onConflictDoNothing`) followed by a re-`SELECT` makes two
 * concurrent invocations of the same id converge on whichever row won the
 * insert race, rather than each returning its own freshly-computed result.
 *
 * Runs outside the `list_tools`/`call_tool` catalog flow a live agent turn
 * uses (`@valet/engine`'s `plugin-catalog.ts`) — this invoker calls a
 * resolved `PluginAction.execute` directly, building its own
 * `PluginActionContext` since there is no live session/thread/turn behind a
 * workflow tool-node dispatch.
 */
import { eq } from "drizzle-orm";
import {
  prepareActionArgs,
  type ActionPlugin,
  type ApprovalMode,
  type Credential,
  type CredentialOwner,
  type CredentialProvider,
  type CredentialStore,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
  type Principal,
  type RiskLevel,
  type Sandbox,
  type ValetPlugin,
  credentialSecret,
} from "@valet/engine";
import type { WorkflowInvokeActionRequest, WorkflowInvokeActionResult } from "@valet/workflow";
import type { Static } from "typebox";
import type { AppDb } from "../lib/drizzle.js";
import { qualifiedActionId } from "./action-id.js";
import { workspaceSenderIdentity } from "../services/workspace-sender.js";
import { withSlackOwnerMetadata } from "../channels/identity-links.js";
import { type ConnectMode, connectModeFor, findCredentialDeclaration } from "../services/integration-availability.js";
import { actionInvocations } from "../schema/index.js";
import {
  GITHUB_INSTALLATION_CREDENTIAL_SERVICE,
  isUsableGithubUserRow,
  resolveInstallationApiToken,
  type GitHubTokenDeps,
} from "../services/github-tokens.js";
import {
  orgFallbackPolicy,
  resolveOrgCredentialRead,
  resolveTeamCredentialRead,
  resolveUserCredentialRead,
  onePasswordScopesFor,
} from "../services/credential-resolution.js";
import type { OnePasswordService } from "../services/onepassword.js";
import { resolveSessionGitHubToken } from "../services/session-github-token.js";
import { extractDocumentText } from "../services/pdf-extract.js";
import { persistInvocationAudit, resolveActionPolicy, updateInvocationOutcome } from "../policies/service.js";

/** `PluginActionContext.signal` timeout for a headless invocation — no live turn to bound it otherwise. */
const ACTION_TIMEOUT_MS = 120_000;

/**
 * Resolved run context an `invokeAction` call carries — `userId`/`orgId`
 * are the run's actor bookkeeping fields (same values `resolveRunContext`
 * in `../workflows/engine-deps.ts` produces), `owner` is the run's
 * ownership `Principal`. Kept separate from `WorkflowInvokeActionRequest`
 * (fixed by `@valet/workflow`, carries no owner/org fields) so this module
 * never needs to know the `workflow:{runId}:{nodeId}[:{iteration}]`
 * `invocationId` convention — the caller (`../workflows/engine-deps.ts`)
 * resolves this from the run and passes it in.
 */
export interface ActionInvocationContext {
  userId: string;
  orgId: string;
  owner: Principal;
  /**
   * The REAL app session (`session_repos`) this invocation runs on behalf
   * of, when there is one — distinct from `PluginActionContext.sessionId`
   * (a synthetic `wf:invoke:{invocationId}` id `buildActionContext` mints
   * below, which carries no repo-binding meaning). Today's only production
   * caller (`../workflows/engine-deps.ts`'s `invokeAction`) never sets this
   * — a workflow run has no live sandbox/session behind it — so `github`
   * resolution falls through to the repo-less `auto` tier for every
   * real invocation. The field exists so a future session-bound caller (or
   * a test exercising the repo-bound branch) can opt in.
   */
  sessionId?: string;
  /**
   * The workflow run this invocation belongs to (action-policies plan,
   * Task 3), scoping `appliesIn: "workflow"` policy resolution and any
   * exec-scoped runtime grant that quiets a `require_approval` action. Set by
   * `workflows/engine-deps.ts`'s `invokeAction` (the run id). Absent === no
   * workflow-policy enforcement runs (a direct/test caller with no run
   * context), so the action executes as before.
   */
  workflowExecutionId?: string;
}

export interface ActionInvokerOpts {
  db: AppDb;
  credentials: CredentialStore;
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  /**
   * The full assembled plugin set, for the availability gate — a credential
   * declaration (and its OAuth block) can live on a different plugin than
   * the action's owner, so the gate must scan the whole registry, exactly
   * as `/api/plugins` and the session-build gate do. Optional: without it,
   * the gate falls back to the (deduped) plugins in `actionPluginByService`,
   * which covers every action-bearing plugin but misses credential-only
   * ones — production wiring passes the full set.
   */
  plugins?: ValetPlugin[];
  clock?: () => number;
  /**
   * Deps for resolving `github` service credentials through the canonical
   * token service (`services/github-tokens.ts`'s `resolveGitHubToken`)
   * instead of a raw `CredentialStore` read. Optional — omit when the
   * invoker never dispatches `github` actions; a `github` dispatch without
   * this configured throws a clear wiring error rather than silently
   * mis-resolving.
   */
  githubTokenDeps?: {
    key: Buffer;
    apiUrl?: string;
    githubUrl?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  };
  /**
   * 1Password reference-credential resolver (owner-precedence contract,
   * Task 6). Threaded into the shared `resolveUserCredentialRead`/
   * `resolveOrgCredentialRead` helper's `CredentialReadDeps` so a workflow
   * tool-node action can resolve a `metadata.onepassword`-carrying row the
   * same way the session resolver and `ChannelHost` do. Optional — omit for
   * deployments/tests with no 1Password service wired; rows then pass
   * through raw, byte-identical to before this task.
   */
  onePassword?: OnePasswordService;
}

export type ActionInvoker = (
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
) => Promise<WorkflowInvokeActionResult>;

/**
 * Build the dedup-first action invoker. Returned function is safe to call
 * concurrently with the same `invocationId` — the durable table is the
 * source of truth for "did this already happen," not any in-process cache.
 */
/**
 * The plugin registry a declaration lookup scans. A caller that wires only
 * the action map still gets declaration-driven behavior from the plugins
 * behind it, rather than silently losing it.
 */
function registryOf(opts: Pick<ActionInvokerOpts, "plugins" | "actionPluginByService">): ValetPlugin[] {
  return opts.plugins ?? [...new Set([...opts.actionPluginByService.values()].map((e) => e.plugin))];
}

export function buildActionInvoker(opts: ActionInvokerOpts): ActionInvoker {
  const clock = opts.clock ?? Date.now;

  return async (req, ctx) => {
    const existing = await selectStoredResult(opts.db, req.invocationId);
    if (existing) return existing;

    const result = await computeResult(opts, req, ctx);

    // Gate outcomes must not be stored: the approved retry must reach
    // enforcement fresh (re-evaluating the current policy state) rather than
    // replaying a parked result.
    if (!result.ok && "requiresApproval" in result && result.requiresApproval) {
      return result;
    }

    await opts.db
      .insert(actionInvocations)
      .values({ invocationId: req.invocationId, result, createdAt: clock() })
      .onConflictDoNothing();

    // Re-select rather than trusting the freshly-computed `result` directly
    // — a concurrent duplicate call may have won the insert race with a
    // different (but equally valid) computed result; both callers must
    // converge on the one row that actually landed.
    const stored = await selectStoredResult(opts.db, req.invocationId);
    if (!stored) {
      throw new Error(`action-invoker: invocation ${req.invocationId} vanished immediately after insert`);
    }
    return stored;
  };
}

async function selectStoredResult(db: AppDb, invocationId: string): Promise<WorkflowInvokeActionResult | undefined> {
  const rows = await db
    .select({ result: actionInvocations.result })
    .from(actionInvocations)
    .where(eq(actionInvocations.invocationId, invocationId))
    .limit(1);
  const row = rows[0];
  return row ? parseStoredResult(row.result) : undefined;
}

/** Runtime-validated narrowing — `result` is a native jsonb value now, but crossing the DB boundary still needs a check rather than a blind cast. */
function parseStoredResult(value: unknown): WorkflowInvokeActionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new Error(`action-invoker: corrupt stored result: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    return { ok: true, result: record.result };
  }
  if (record.ok === false && typeof record.error === "string") {
    return { ok: false, error: record.error };
  }
  // A requiresApproval row must never land in the dedup table (the guard in
  // buildActionInvoker skips the insert). If one exists, the data is corrupt.
  if (record.ok === false && record.requiresApproval === true) {
    throw new Error(`action-invoker: stored requiresApproval outcome should never exist for ${JSON.stringify(value)}`);
  }
  throw new Error(`action-invoker: corrupt stored result: ${JSON.stringify(value)}`);
}

async function computeResult(
  opts: ActionInvokerOpts,
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
): Promise<WorkflowInvokeActionResult> {
  const entry = opts.actionPluginByService.get(req.service);
  if (!entry) return unknownAction(req);

  const owner = credentialOwnerFor(ctx.owner);
  if (!owner) {
    return {
      ok: false,
      error: `credential resolution is not supported for owner type "${ctx.owner.type}" (workflow action invocation only supports user/team/org owners)`,
    };
  }
  const credentialService = entry.actionPlugin.credentialService ?? entry.actionPlugin.service;

  // Availability gate (integration-availability design): a service whose
  // deployment/org prerequisite is missing must fail the same way here as it
  // disappears from a live session's `list_tools` — deterministically, with
  // the corrective action named. Scans the full registry (see
  // `ActionInvokerOpts.plugins`) because the declaration can live on a
  // different plugin than the action's owner. `owner` lets a team run pass
  // on the team's own row when the org row is absent.
  const registry = registryOf(opts);
  const declared = findCredentialDeclaration(registry, credentialService);
  // Kept past the gate: the team refusal below reads it to tell an
  // org-provided service (the org row IS the credential) from one a team
  // must hold itself.
  let mode: ConnectMode | null = null;
  if (declared) {
    mode = await connectModeFor({
      plugins: registry,
      decl: declared,
      service: credentialService,
      orgId: ctx.orgId,
      credentials: opts.credentials,
      env: process.env,
      owner,
    });
    if (mode === "unconfigured") {
      return {
        ok: false,
        error: `${credentialService} is not configured for this organization. An admin can set it up in Settings → Organization.`,
      };
    }
  }
  // `github` is the only service that resolves a credential identity today.
  // Any other service would IGNORE the selection, and a node that asked to
  // act as the application would silently act as the workflow owner —
  // exactly the failure `credential` exists to prevent. Refuse instead.
  if (req.credential !== undefined && req.credential !== "auto" && credentialService !== "github") {
    return {
      ok: false,
      error:
        `the ${req.service} service cannot select a "${req.credential}" credential. ` +
        `Remove the credential field from this tool node.`,
    };
  }
  // User→org owner precedence + 1Password reference resolution, matching
  // `engine/host.ts`. A user-owned run reads the user row first and falls
  // back to the org row; an org-owned run reads the org row only.
  const baseProvider =
    credentialService === "github"
      ? buildGithubCredentialProvider(opts, req, ctx, owner)
      : buildCredentialProvider(opts, ctx, owner, credentialService);
  // Identity enrichment, the second half of the session path's slack branch
  // (`engine/host.ts`): the resolved token alone cannot answer "may the run
  // owner read this private channel" — `slack.dm_owner` and the private-
  // channel guard read the owner's linked Slack id off
  // `metadata.owner_slack_user_id`. Without this a linked user's workflow
  // still fails with "Owner has not linked their Slack identity". User-owned
  // runs only: a team/org-owned run has no single person whose channel
  // membership could authorize the read, so its credential stays bare and
  // those actions keep failing closed.
  const credentials =
    credentialService === "slack" && ctx.owner.type === "user"
      ? withOwnerSlackIdentity(baseProvider, opts.db, ctx.owner.id)
      : baseProvider;

  // Dynamic `resolveActions` discovery runs BEFORE policy enforcement because
  // resolution needs the action's `riskLevel` (rung 5 fallback) — which only
  // exists once the action is resolved. Discovery may touch credentials (an
  // MCP-proxy plugin lists its tools over an authenticated upstream), but no
  // action is EXECUTED here; enforcement below still gates the actual call.
  // Team refusal (team credentials design, decision 3): a team run with no
  // resolvable credential refuses here, before any action code runs. A
  // personal run keeps executing on a null credential because the action's
  // own guards answer for one person; a team run must fail the same way
  // for every member, so the refusal is made once, up front, and names the
  // corrective action. Only a declared service is gated (an undeclared one
  // never needed a credential), and only when the org does not provide it
  // (`mode === "org"` means the org row resolved above and the team read
  // escalates to it). `github` is gated like any other service: its team
  // branch returns `null` when neither a team row nor an App installation
  // answers, and the refusal names the github-specific fix.
  //
  // Ordering against the unknown-action check: a node that names an action
  // which does not exist must hear that, not a credential hint that sends
  // the author to the wrong settings page, so a statically listed plugin is
  // checked after the action is found. A dynamic plugin cannot list its
  // actions without the credential (an MCP proxy discovers its tools over
  // the authenticated upstream), so for one of those the refusal runs
  // before discovery: discovery would only echo the plugin's own generic
  // "no credential connected" message, which names no fix.
  const teamGated = ctx.owner.type === "team" && declared !== null && mode !== "org";
  let action = findAction(entry.actionPlugin.actions, req.service, req.action);
  if (!action && entry.actionPlugin.resolveActions) {
    if (teamGated) {
      const refusal = await refuseTeamRunWithoutCredential(credentials, credentialService);
      if (refusal) return refusal;
    }
    // A credential read can throw a typed refusal (a broken delegation, a
    // ref outside the team's 1Password lease). That message names the fix,
    // so it comes back as a failed result, the same way execute reports.
    let resolved: PluginAction[];
    try {
      resolved = await entry.actionPlugin.resolveActions({ credentials });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    action = findAction(resolved, req.service, req.action);
  }
  if (!action) return unknownAction(req);

  if (teamGated) {
    const refusal = await refuseTeamRunWithoutCredential(credentials, credentialService);
    if (refusal) return refusal;
  }

  // Policy enforcement (action-policies plan, Task 3): `deny` fails the
  // node. `require_approval` does NOT — it returns `requiresApproval`, and
  // the tool executor parks the run on an `approval:{nodeId}` signal until
  // a person resolves it (`@valet/workflow`'s `nodes/tool.ts`). Read that
  // as a warning for anything unattended: a scheduled run that reaches a
  // gated action waits, without a deadline, unless the node declares
  // `approvalTimeout`. An exec-scoped grant is consulted transparently by
  // `resolveActionPolicy` (grant rung), so a covered action resolves
  // straight to `allow`. The policy-facing actionId
  // is the fully-qualified fqid (spec Deviations T6 #3, fixed): one
  // canonical id matches both the session and workflow paths.
  const policyActionId = qualifiedActionId(req.service, action);
  // Set only when enforceWorkflowPolicy wrote a decision row (org + run
  // context present); also the org scope for the outcome-stamp UPDATE.
  const auditOrgId = ctx.orgId && ctx.workflowExecutionId ? ctx.orgId : undefined;
  const denial = await enforceWorkflowPolicy(
    opts,
    req,
    ctx,
    action.riskLevel,
    entry.actionPlugin.defaultApprovalMode,
    policyActionId,
  );
  if (denial) return denial;

  const prepared = prepareActionArgs(action.parameters, req.params);
  if (!prepared.ok) {
    if (auditOrgId) {
      await updateInvocationOutcome(opts.db, `pol:wf:${req.invocationId}`, auditOrgId, {
        status: "error",
        error: `invalid params: ${prepared.error}`,
      });
    }
    return { ok: false, error: prepared.error };
  }

  const actionCtx = buildActionContext(req, ctx, credentials, action.id, opts.db);

  const startedAt = (opts.clock ?? Date.now)();
  let result: PluginActionResult;
  try {
    // `prepared.args` is validated+defaulted against `action.parameters`
    // above, but `PluginAction`'s stored type parameter is erased to the
    // base `TSchema` on the array — same bridge `@valet/engine`'s own
    // `call_tool` executor (`plugin-catalog.ts`) uses for this exact call.
    result = await action.execute(prepared.args as Static<typeof action.parameters>, actionCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (auditOrgId) {
      await updateInvocationOutcome(opts.db, `pol:wf:${req.invocationId}`, auditOrgId, {
        status: "error",
        error: message,
        startedAt,
        durationMs: (opts.clock ?? Date.now)() - startedAt,
      });
    }
    return { ok: false, error: message };
  }

  // Stamp the execution outcome (status/result/error) onto the decision row
  // enforceWorkflowPolicy wrote before execution (spec Deviations T6 #6,
  // fixed: workflow rows now carry the result, size-capped by the updater).
  // `result` is the full `PluginActionResult` — the same shape the session
  // path's `PolicyInvocationRecord.result` carries.
  if (auditOrgId) {
    await updateInvocationOutcome(opts.db, `pol:wf:${req.invocationId}`, auditOrgId, {
      status: result.success ? "completed" : "error",
      result,
      error: result.success ? undefined : (result.error ?? "failed with no error detail"),
      startedAt,
      durationMs: (opts.clock ?? Date.now)() - startedAt,
    });
  }

  if (!result.success) {
    return { ok: false, error: result.error ?? `${req.service}.${req.action} failed with no error detail` };
  }
  // V2-GAP: attachments dropped — workflow results are JSON-only; revisit
  // once workflow runs have a place to store binary artifacts.
  return { ok: true, result: result.data };
}

function unknownAction(req: WorkflowInvokeActionRequest): WorkflowInvokeActionResult {
  return { ok: false, error: `unknown action: ${req.service}.${req.action}` };
}

/**
 * Resolves the team run's credential once, ahead of execute. A null
 * resolution is the refusal decision 3 asks for. A throw (a broken
 * delegated reference, a scope refusal) is mapped the way `execute`'s own
 * try/catch maps it, so the typed message reaches the run unchanged.
 */
async function refuseTeamRunWithoutCredential(
  credentials: CredentialProvider,
  service: string,
): Promise<WorkflowInvokeActionResult | null> {
  try {
    if ((await credentials.get()) !== null) return null;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: false, error: teamRefusalMessage(service) };
}

/**
 * The corrective action a team refusal names. GitHub has two fixes a
 * generic "share one from Integrations" does not cover: the App
 * installation is per repository owner, and a personal GitHub connection
 * is never borrowed by a team run.
 */
function teamRefusalMessage(service: string): string {
  if (service === "github") {
    return (
      "This team has no github credential. Install the GitHub App on the repository's owner in " +
      "Settings → Organization → GitHub, or store a github credential for the team in Settings → Organization → Teams."
    );
  }
  return (
    `This team has no ${service} credential. Share one from Integrations, ` +
    `or store one for the team in Settings → Organization → Teams.`
  );
}

/**
 * Resolve + enforce org policy for a workflow tool-node invocation
 * (action-policies plan, Task 3). Returns a failure `WorkflowInvokeActionResult`
 * when the action must NOT run (deny / require_approval with no covering
 * grant), or `null` to proceed. Writes a durable audit row either way
 * (deterministic PK `pol:wf:{invocationId}` → dedups a byte-identical replay).
 * A no-op when the caller supplied no run/org context.
 */
async function enforceWorkflowPolicy(
  opts: ActionInvokerOpts,
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
  riskLevel: RiskLevel,
  pluginDefault: ApprovalMode | undefined,
  policyActionId: string,
): Promise<WorkflowInvokeActionResult | null> {
  if (!ctx.orgId || !ctx.workflowExecutionId) return null;
  const now = (opts.clock ?? Date.now)();

  let decision: Awaited<ReturnType<typeof resolveActionPolicy>>;
  try {
    decision = await resolveActionPolicy(opts.db, {
      orgId: ctx.orgId,
      teamId: ctx.owner.type === "team" ? ctx.owner.id : undefined,
      userId: ctx.userId,
      service: req.service,
      actionId: policyActionId,
      riskLevel,
      params: req.params,
      appliesIn: "workflow",
      workflowExecutionId: ctx.workflowExecutionId,
      pluginDefault,
      now,
    });
  } catch (err) {
    console.error("action-invoker: policy resolution failed:", err);
    if (req.approval && ctx.owner.type !== "team") {
      // Team actions must re-check team denies even after approval.
      // Human approval is the authorization — proceed even though the
      // resolver could not be consulted. The signal is the authority.
      // Write a best-effort audit row so the approved execution is
      // auditable even when the policy store was unreachable.
      await persistInvocationAudit(opts.db, {
        invocationId: `pol:wf:${req.invocationId}`,
        service: req.service,
        actionId: policyActionId,
        riskLevel,
        resolvedMode: "require_approval",
        baseMode: "require_approval",
        matchedPolicyId: null,
        matchedGrantId: null,
        matchedOverrideId: null,
        status: "approved",
        workflowExecutionId: ctx.workflowExecutionId,
        userId: ctx.userId,
        orgId: ctx.orgId,
        params: req.params,
        createdAt: now,
      });
      return null;
    }
    return { ok: false, requiresApproval: true, provenance: "resolver_error" };
  }

  if (decision.mode === "allow") {
    await persistInvocationAudit(opts.db, {
      invocationId: `pol:wf:${req.invocationId}`,
      service: req.service,
      actionId: policyActionId,
      riskLevel,
      resolvedMode: decision.mode,
      baseMode: decision.provenance.baseMode,
      matchedPolicyId: decision.provenance.matchedPolicyId ?? null,
      matchedGrantId: decision.provenance.matchedGrantId ?? null,
      matchedOverrideId: decision.provenance.matchedOverrideId ?? null,
      status: "allowed",
      workflowExecutionId: ctx.workflowExecutionId,
      userId: ctx.userId,
      orgId: ctx.orgId,
      params: req.params,
      createdAt: now,
    });
    return null;
  }

  if (decision.mode === "deny") {
    await persistInvocationAudit(opts.db, {
      invocationId: `pol:wf:${req.invocationId}`,
      service: req.service,
      actionId: policyActionId,
      riskLevel,
      resolvedMode: decision.mode,
      baseMode: decision.provenance.baseMode,
      matchedPolicyId: decision.provenance.matchedPolicyId ?? null,
      matchedGrantId: decision.provenance.matchedGrantId ?? null,
      matchedOverrideId: decision.provenance.matchedOverrideId ?? null,
      status: "denied",
      workflowExecutionId: ctx.workflowExecutionId,
      userId: ctx.userId,
      orgId: ctx.orgId,
      params: req.params,
      createdAt: now,
    });
    return { ok: false, error: `${req.service}.${req.action} is blocked by ${decision.provenance.source === "team_policy" ? "team" : "org"} policy` };
  }

  // decision.mode === "require_approval"
  if (req.approval) {
    // The tool executor holds an approved, unconsumed signal — treat as authorized.
    await persistInvocationAudit(opts.db, {
      invocationId: `pol:wf:${req.invocationId}`,
      service: req.service,
      actionId: policyActionId,
      riskLevel,
      resolvedMode: decision.mode,
      baseMode: decision.provenance.baseMode,
      matchedPolicyId: decision.provenance.matchedPolicyId ?? null,
      matchedGrantId: decision.provenance.matchedGrantId ?? null,
      matchedOverrideId: decision.provenance.matchedOverrideId ?? null,
      status: "approved",
      workflowExecutionId: ctx.workflowExecutionId,
      userId: ctx.userId,
      orgId: ctx.orgId,
      params: req.params,
      createdAt: now,
    });
    return null;
  }

  // Park: write a "pending" audit row so the gate is visible in the audit log,
  // then return the requiresApproval signal. This row must NOT live in the
  // dedup table — the approved retry must reach enforcement fresh.
  await persistInvocationAudit(opts.db, {
    invocationId: `pol:wf:${req.invocationId}`,
    service: req.service,
    actionId: policyActionId,
    riskLevel,
    resolvedMode: decision.mode,
    baseMode: decision.provenance.baseMode,
    matchedPolicyId: decision.provenance.matchedPolicyId ?? null,
    matchedGrantId: decision.provenance.matchedGrantId ?? null,
    matchedOverrideId: decision.provenance.matchedOverrideId ?? null,
    status: "pending",
    workflowExecutionId: ctx.workflowExecutionId,
    userId: ctx.userId,
    orgId: ctx.orgId,
    params: req.params,
    createdAt: now,
  });
  return { ok: false, requiresApproval: true, riskLevel, provenance: decision.provenance.source };
}

export { qualifiedActionId };

/** Matches a bare or service-qualified `PluginAction.id` against `(service, action)`, mirroring `@valet/engine`'s `plugin-catalog.ts` fqid convention. */
export function findAction(actions: PluginAction[], service: string, actionId: string): PluginAction | undefined {
  return actions.find((a) => {
    if (a.id === actionId) return true;
    const fqid = a.id.includes(".") ? a.id : `${service}.${a.id}`;
    return fqid === `${service}.${actionId}`;
  });
}

/** A workflow run's owner `Principal` maps onto `CredentialOwner` of the same type. */
function credentialOwnerFor(owner: Principal): CredentialOwner | null {
  if (owner.type === "user") return { type: "user", id: owner.id };
  if (owner.type === "team") return { type: "team", id: owner.id };
  if (owner.type === "org") return { type: "org", id: owner.id };
  return null;
}

/**
 * Non-github `CredentialProvider` — routes through the shared
 * owner-precedence contract (`services/credential-resolution.ts`)
 * instead of a raw `CredentialStore.get`. A user-owned run resolves via
 * `resolveUserCredentialRead` (user row shadows org row, `owner.id` as the
 * acting user); a team-owned run resolves via `resolveTeamCredentialRead`
 * (team row, then org only when the service is org-provided, then the
 * org-scoped vault item); an org-owned
 * run resolves via `resolveOrgCredentialRead` (org row only), with
 * `ctx.userId` — the run's actor bookkeeping field — threaded through for a
 * personal-tokenScope 1Password reference to resolve against. Either path
 * fills a `metadata.onepassword` row's secret when `opts.onePassword` is
 * wired; absent onePassword or a non-reference row passes through raw.
 */
function buildCredentialProvider(
  opts: ActionInvokerOpts,
  ctx: ActionInvocationContext,
  owner: CredentialOwner,
  defaultService: string,
): CredentialProvider {
  const deps = { credentials: opts.credentials, onePassword: opts.onePassword };
  return {
    async get(service?: string): Promise<Credential | null> {
      const svc = service ?? defaultService;
      // Escalation applies to THIS provider's own service only. An incidental
      // read of some other service must not reach the org's credentials, even
      // when that other service is org-provided in its own right.
      //
      // The registry falls back to the plugins behind `actionPluginByService`,
      // the same way the availability gate above resolves it: a caller that
      // wires only the action map still gets declaration-driven escalation
      // rather than silently losing it.
      const registry =
        registryOf(opts);
      const fallback = svc === defaultService ? orgFallbackPolicy(registry, svc) : "none";
      const stored =
        owner.type === "user"
          ? await resolveUserCredentialRead(
              deps,
              { orgId: ctx.orgId, userId: owner.id, scopes: onePasswordScopesFor("user") },
              svc,
              fallback,
            )
          : owner.type === "team"
            ? await resolveTeamCredentialRead(
                deps,
                { orgId: ctx.orgId, teamId: owner.id, userId: ctx.userId, scopes: onePasswordScopesFor("team", owner.id) },
                svc,
                fallback,
              )
            : await resolveOrgCredentialRead(deps, { orgId: ctx.orgId, userId: ctx.userId, scopes: ["org"] }, svc);
      if (!stored) return null;
      const accessToken = credentialSecret(stored) ?? "";
      if (accessToken === "") return null;
      return {
        accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
        scopes: stored.scopes,
        metadata: stored.metadata,
      };
    },
    request(): Promise<Credential> {
      return Promise.reject(new Error("credential requests are not supported in workflow action invocation"));
    },
  };
}

/**
 * Wrap a provider so a resolved `slack` credential carries the run owner's
 * linked Slack user id as `metadata.owner_slack_user_id` — the same
 * enrichment `engine/host.ts`'s slack branch performs for a live session
 * (both call `withSlackOwnerMetadata`). The identity link is the single
 * source of truth; a credential's own stored metadata never carries this
 * field. No link → the credential passes through bare, and the plugin's
 * own guards fail closed exactly as before. An explicit
 * `.get("<other-service>")` through the wrapped provider is also passed
 * through bare — the slack identity must not stamp another service's
 * credential.
 */
function withOwnerSlackIdentity(provider: CredentialProvider, db: AppDb, userId: string): CredentialProvider {
  return {
    async get(service?: string): Promise<Credential | null> {
      const cred = await provider.get(service);
      if (!cred || (service !== undefined && service !== "slack")) return cred;
      return withSlackOwnerMetadata(db, userId, cred);
    },
    request(service: string, reason: string): Promise<Credential> {
      return provider.request(service, reason);
    },
  };
}

/**
 * `CredentialProvider` for the `github` service — resolves through
 * `resolveSessionGitHubToken`/`resolveGitHubToken` (the canonical GitHub
 * credential path, GitHub/repo integration plan Task 4) instead of a raw
 * `CredentialStore.get` read. `purpose: "api"` matches how the 28
 * plugin-github actions use the resulting token (Octokit API calls, not
 * `git` operations). A `GitHubAuthError` thrown by `resolveGitHubToken` is
 * NOT caught here — it propagates out of `action.execute()` to
 * `computeResult`'s existing try/catch, which maps it to
 * `{ ok: false, error: err.message }` the same way any other thrown error
 * becomes the action's error result (the message already names the gap and
 * carries the connect hint, per `github-tokens.ts`'s doc comment).
 *
 * ── Credential selection (`ToolNode.credential`) ────────────────────────
 * `req.credential` picks the identity the action acts as:
 *
 *   - `"app"`  → `auth: "app"` with the repository taken from the action's
 *     own `owner`/`repo` parameters. `resolveGitHubToken` mints the
 *     installation token for that owner or THROWS. There is no fallback:
 *     an automated review that cannot reach the App must fail visibly
 *     rather than post under the workflow owner's personal account.
 *   - `"user"` → `auth: "user"`, equally strict in the other direction.
 *   - `"auto"` or absent → the pre-existing precedence, binding included.
 *     Every definition written before this field existed lands here.
 *
 * ── Team owners (team credentials design, decisions 3 and 6) ────────────
 * A team run acts as the team, never as a person. `"auto"` reads the
 * team's own github row first (direct or delegated), then mints the App
 * installation token for the action's repository owner, or the org's sole
 * installation. `"user"` reads the team row alone. Neither consults a user
 * credential (`ctx.userId` is the synthetic `team:{id}` and must not be
 * resolved as a person) nor the org PAT, and a miss returns `null` rather
 * than throwing, so `computeResult`'s team refusal names the fix. `"app"`
 * keeps the strict installation path above.
 */
function buildGithubCredentialProvider(
  opts: ActionInvokerOpts,
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
  owner: CredentialOwner,
): CredentialProvider {
  return {
    async get(service?: string): Promise<Credential | null> {
      // A bare `.get()`, `.get("github")`, or `.get("github:installation")`
      // are the only shapes the plugin-github actions use; any other service falls back
      // to a plain store read (byte-identical to non-github services) —
      // no plugin known to this codebase does this today, but the contract
      // shouldn't silently reinterpret an unrelated service as "github".
      if (
        service !== undefined &&
        service !== "github" &&
        service !== GITHUB_INSTALLATION_CREDENTIAL_SERVICE
      ) {
        return buildCredentialProvider(opts, ctx, owner, service).get(service);
      }
      const tokenDeps = opts.githubTokenDeps;
      if (!tokenDeps) {
        throw new Error("action-invoker: github credential resolution requires githubTokenDeps to be configured");
      }
      const deps: GitHubTokenDeps = {
        db: opts.db,
        credentials: opts.credentials,
        key: tokenDeps.key,
        apiUrl: tokenDeps.apiUrl,
        githubUrl: tokenDeps.githubUrl,
        fetchImpl: tokenDeps.fetchImpl,
        now: tokenDeps.now,
      };
      if (service === GITHUB_INSTALLATION_CREDENTIAL_SERVICE) {
        // Explicit installation-tier request (github.list_repos with
        // `scope: "installation"`). The action's own `owner` parameter picks
        // the installation when present; otherwise the org's sole
        // installation applies. Same org-scoped lookup as the `"app"`
        // selection below — no cross-tenant reach.
        const token = await resolveInstallationApiToken(deps, ctx.orgId, repoFromParams(req.params)?.owner);
        return token === null ? null : { accessToken: token };
      }
      const selection = req.credential ?? "auto";
      if (owner.type === "team" && selection !== "app") {
        const teamRow = await buildCredentialProvider(opts, ctx, owner, "github").get("github");
        // A delegated row follows to the member's live github row. When
        // that row is one the member's own runs would refuse (identity-
        // only, refresh-failed, expired), the team must not act on it
        // either: it falls to the App path like a team with no row.
        if (teamRow && isUsableGithubUserRow(teamRow, (deps.now ?? Date.now)())) return teamRow;
        if (selection === "user") return null;
        const token = await resolveInstallationApiToken(deps, ctx.orgId, repoFromParams(req.params)?.owner);
        return token === null ? null : { accessToken: token };
      }
      // `params` are template-rendered, so a webhook payload can choose this
      // repo. That is safe only because `mintInstallationToken` looks an
      // installation up by `(orgId, accountLogin)` — the reachable set is
      // the caller's own org. Keep that scoping: a global installation
      // lookup would turn this node into cross-tenant access.
      const repo = selection === "app" ? repoFromParams(req.params) : undefined;
      if (selection === "app" && !repo) {
        throw new Error(
          `${req.service}.${req.action} cannot use the "app" credential: the repository owner is unknown. ` +
            `Add "owner" and "repo" parameters to this tool node.`,
        );
      }
      const resolved = await resolveSessionGitHubToken(deps, {
        orgId: ctx.orgId,
        // A team or org owner must not resolve the prompting member's PAT:
        // the synthetic `team:{id}` actor is never a person, and `auto`
        // without userId can still mint a sole installation token.
        ...(owner.type === "user" ? { userId: ctx.userId } : {}),
        sessionId: ctx.sessionId,
        purpose: "api",
        // `auto` means "keep the default precedence", so it must NOT
        // override a session binding's own selection. `app` already
        // required a repo above.
        ...(selection === "auto" ? {} : { auth: selection }),
        ...(repo ? { repo } : {}),
      });
      // `purpose: "api"` never returns `{ source: "none" }` (it throws
      // instead) — `token` is non-null whenever resolution didn't throw.
      if (resolved.token === null) return null;
      return { accessToken: resolved.token };
    },
    request(): Promise<Credential> {
      return Promise.reject(new Error("credential requests are not supported in workflow action invocation"));
    },
  };
}

/**
 * The repository an `app`-credential invocation resolves its installation
 * against, read from the action's own parameters. Every repo-scoped
 * plugin-github action declares `owner` and `repo` as required strings, so
 * both must be present — `resolveGitHubToken` only reads `owner`, but
 * inventing a `name` for a security decision is worse than refusing.
 */
function repoFromParams(params: Record<string, unknown>): { owner: string; name: string } | undefined {
  const owner = params.owner;
  const name = params.repo;
  if (typeof owner !== "string" || owner.length === 0) return undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  return { owner, name };
}

function buildActionContext(
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
  credentials: CredentialProvider,
  actionId: string,
  db: AppDb,
): PluginActionContext {
  const sessionId = `wf:invoke:${req.invocationId}`;
  return {
    userId: ctx.userId,
    orgId: ctx.orgId,
    sessionId,
    threadId: "invoke",
    actionId,
    service: req.service,
    owner: ctx.owner,
    sessionPurpose: "workflow",
    // `WorkflowInvokeActionRequest` carries no summary field (the `tool`
    // node executor's `engine.invokeAction` call never sets one) — left
    // undefined rather than guessing at a value the type doesn't offer.
    summary: undefined,
    credentials,
    // Workflow actions use the same owner identity as session-backed actions.
    resolveOutboundSender: () => workspaceSenderIdentity(db, ctx.orgId, ctx.owner),
    sandbox: throwingSandbox(sessionId),
    // Unlike the capabilities stubbed out below, document extraction is
    // genuinely available here: it is a pure call over bytes against the
    // native extractor in this process, needing no session, thread or
    // sandbox. Leaving it unset made a workflow node reading a PDF report
    // that extraction is unavailable on the deployment, which was wrong
    // about the deployment and only true of this context.
    extractDocument: extractDocumentText,
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    requestDecision: () =>
      Promise.reject(
        new Error("approvals inside workflow tool actions ride the policy gate — this callback is unreachable"),
      ),
    threadRead: () =>
      Promise.reject(new Error("thread history is not available in workflow action invocation")),
    listThreads: () =>
      Promise.reject(new Error("thread listing is not available in workflow action invocation")),
    setModel: () =>
      Promise.reject(new Error("model switching is not available in workflow action invocation")),
  };
}

/** Every method throws — a workflow tool-node action invocation has no sandbox behind it. Implements the full `Sandbox` interface rather than casting an empty object. */
function throwingSandbox(id: string): Sandbox {
  const unavailable = (): never => {
    throw new Error("sandbox unavailable in workflow action invocation");
  };
  return {
    id,
    readFile: () => unavailable(),
    readBinary: () => unavailable(),
    writeFile: () => unavailable(),
    writeBinary: () => unavailable(),
    readdir: () => unavailable(),
    stat: () => unavailable(),
    mkdir: () => unavailable(),
    rm: () => unavailable(),
    exec: () => unavailable(),
  };
}
