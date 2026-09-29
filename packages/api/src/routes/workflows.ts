/**
 * `/api/workflows` (Phase 5 plan decision 18). Definitions + runs, owner-
 * scoped to the authenticated principal exactly like `routes/sessions.ts`
 * (cross-owner access 404s, never 403s — an owned row and a missing row are
 * indistinguishable to the caller).
 *
 * All definition/run logic lives in `../workflows/service.ts` (shared with
 * the agent-facing workflows action plugin); this file is HTTP plumbing.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { NotFoundError } from "@valet/shared";
import type { CredentialStore } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { requirePrincipal } from "../middleware/auth.js";
import { resolveCreateOwner, type RequestPrincipal } from "../lib/request-principal.js";
import { isTeamMember } from "../services/teams.js";
import {
  WorkflowCursorError,
  workflowFileBasename,
  workflowFileEnvelope,
  type ValidateEnvironment,
  type WorkflowDefinition,
} from "@valet/workflow";
import { stringify as stringifyYaml } from "yaml";
import {
  cancelWorkflowRun,
  createWorkflowDefinition,
  copyWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  getWorkflowVersion,
  isAuthorizedForOwner,
  isRunOutcome,
  isRunStatus,
  listRunsForOwner,
  listWorkflowActionRequired,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowVersions,
  parseWorkflowOwnerFilter,
  resolveWorkflowApproval,
  retryWorkflowRun,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  RUN_OUTCOME_VALUES,
  RUN_PAGE_LIMIT_MAX,
  RUN_STATUS_VALUES,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "../workflows/service.js";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
  workflowWebhookUrl,
} from "../workflows/webhook-service.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  type WorkflowScheduleSummary,
} from "../workflows/schedule-service.js";
import { buildValidateEnvironment, buildOrgValidateEnvironment } from "../workflows/validation-env.js";
import { applyWorkflowModelPatch } from "../workflows/patch.js";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import type { TeamServiceReadinessDeps } from "../workflows/team-service-readiness.js";
import { allowWorkflowPermissions, analyzeWorkflowPermissions, revokeWorkflowPermissions } from "../workflows/permissions.js";
import { parseRepoInput, ContentSourceInputError } from "../services/content-sources.js";
import {
  GitHubSkillRepoReader,
  SkillRepoReadError,
  SkillRepoTimeoutError,
  type SkillRepoFile,
} from "../services/skill-repo-reader.js";
import type {
  AllowWorkflowPermissionsRequest,
  AllowWorkflowPermissionsResponse,
  CancelWorkflowRunResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowPermissionsResponse,
  GetWorkflowImportFileResponse,
  ListAllWorkflowRunsResponse,
  ListWorkflowActionRequiredResponse,
  CreateScheduleOnWorkflowRequest,
  CreateWorkflowScheduleResponse,
  DeleteWorkflowScheduleResponse,
  DeleteWorkflowWebhookResponse,
  ListWorkflowSchedulesResponse,
  WorkflowScheduleWire,
  GetWorkflowResponse,
  GetWorkflowVersionResponse,
  ListWorkflowRunsResponse,
  ListWorkflowVersionsResponse,
  ListWorkflowsResponse,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  RetryWorkflowRunResponse,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowModelRequest,
  UpdateWorkflowModelResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
  WorkflowWebhookResponse,
} from "../wire/types.js";

export const workflowsRouter = new Hono<AppEnv>();

/** The credential reads the team arm gate makes before a schedule arms
 * (`workflows/team-service-readiness.ts#teamArmBlock`). */
function armDeps(c: Context<AppEnv>): TeamServiceReadinessDeps {
  const { db, engineCredentials, plugins, onePassword } = c.var.providers;
  return { db, credentials: engineCredentials, plugins, onePassword };
}

/** An empty query value means "not set": a client that always sends the
 * field must not get a 400 for leaving it blank. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * `teamId` names a team on the sibling listings (`/api/templates`,
 * `/api/credentials`), so clients send it here as well. Owner scoping on
 * these two lists is `ownerType`/`ownerId`, and one name for one thing beats
 * a second spelling of it, so `teamId` is refused rather than aliased. It is
 * read before the owner pair: a request carrying both says one thing twice,
 * and a precedence rule invented here would be one more rule to know.
 */
function unsupportedTeamIdError(raw: string | undefined): string | undefined {
  if (blankToUndefined(raw) === undefined) return undefined;
  return "teamId is not supported here. Filter by owner with ownerType=team and ownerId=<team id>.";
}

/** Parses `?limit=` for the run lists. Both list handlers share the range. */
function parseRunLimit(raw: string | undefined): { limit?: number } | { error: string } {
  const value = blankToUndefined(raw);
  if (value === undefined) return {};
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_PAGE_LIMIT_MAX) {
    return { error: `limit must be an integer from 1 to ${RUN_PAGE_LIMIT_MAX}` };
  }
  return { limit };
}

function serviceCtx(c: {
  var: {
    providers: Omit<WorkflowServiceDeps, "credentials"> & { engineCredentials: CredentialStore };
    user: { id: string; orgId: string };
    principal?: RequestPrincipal;
  };
}): { deps: WorkflowServiceDeps; owner: WorkflowOwner; env: ValidateEnvironment } {
  const { db, workflowStore, workflowRunHost, actionPluginByService, engineCredentials, engineStore } =
    c.var.providers;
  return {
    // `engineStore` is what run-origin validation probes for the origin
    // thread (`activeWorkflowOrigin`).
    deps: { db, workflowStore, workflowRunHost, actionPluginByService, credentials: engineCredentials, engineStore },
    owner: { userId: c.var.user.id, orgId: c.var.user.orgId, principal: c.var.principal },
    env: buildValidateEnvironment(actionPluginByService),
  };
}


// ── Definitions ───────────────────────────────────────────────────────────

workflowsRouter.post("/", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const env = await buildOrgValidateEnvironment(deps, owner.orgId);

  let body: CreateWorkflowRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (body.definition === undefined || body.definition === null) {
    return c.json({ error: "definition is required" }, 400);
  }

  const validation = validateDefinitionInput(body.definition, env);
  if (!validation.ok) {
    return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
  }

  const principal = requirePrincipal(c);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const createdOwner = await resolveCreateOwner({
    principal,
    authVia: c.var.authVia,
    bodyTeamId: body.teamId,
    userId: owner.userId,
    isTeamMember: (teamId) => isTeamMember(deps.db, teamId, owner.userId),
  });
  if (!createdOwner.ok) return c.json({ error: createdOwner.error }, createdOwner.status);

  let created;
  try {
    created = await createWorkflowDefinition(deps, owner, {
      name: body.name,
      definition: body.definition,
      teamId: createdOwner.owner.type === "team" ? createdOwner.owner.id : undefined,
    });
  } catch (err) {
    // Same "cross-owner 404, never 403" convention as the rest of this
    // file — a non-member's teamId looks identical to an unknown one.
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
  const resp: CreateWorkflowResponse = created;
  return c.json(resp, 201);
});

/**
 * Without a filter this returns every workflow the caller can reach: their
 * own, plus every team they belong to. `?ownerType=&ownerId=` narrows that
 * to one owner, for a client that shows one workspace at a time.
 */
workflowsRouter.get("/", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const teamIdError = unsupportedTeamIdError(c.req.query("teamId"));
  if (teamIdError) return c.json({ error: teamIdError }, 400);

  const filter = parseWorkflowOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);
  // The same check `GET /api/workflows/:id` runs, asked of the owner instead
  // of a row, and answered here rather than in the query — an id from a
  // query string never reaches SQL unchecked. 404 because a filter the
  // caller may not use must read exactly like a filter that matches
  // nothing. An `ownerType=org` filter always lands here: no rule admits
  // anybody to an org-owned workflow, so one is no more listable than it is
  // openable.
  if (filter.scope && !(await isAuthorizedForOwner(deps.db, owner, filter.scope))) {
    return c.json({ error: "owner not found" }, 404);
  }

  const resp: ListWorkflowsResponse = {
    workflows: await listWorkflowDefinitions(deps, owner, filter.scope),
  };
  return c.json(resp);
});

// ── Cross-workflow run list ───────────────────────────────────────────────
//
// Registration order is load-bearing: `GET /:id` below also matches the
// single segment `/runs`, and the router picks the route registered first.
// Keep this handler above it. (`GET /runs/:runId` further down is safe at
// any position — two segments never collide with `/:id`.)

workflowsRouter.get("/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const limit = parseRunLimit(c.req.query("limit"));
  if ("error" in limit) return c.json({ error: limit.error }, 400);

  const teamIdError = unsupportedTeamIdError(c.req.query("teamId"));
  if (teamIdError) return c.json({ error: teamIdError }, 400);

  // Optional `?ownerType=&ownerId=` scope: the hub's Runs tab pins one
  // workspace, the same shape `GET /workflows` takes. A filter the caller may
  // not use 404s exactly like one that matches nothing — the definitions
  // list's rule, kept identical here.
  const filter = parseWorkflowOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);
  if (filter.scope && !(await isAuthorizedForOwner(deps.db, owner, filter.scope))) {
    return c.json({ error: "owner not found" }, 404);
  }

  // A whole number, not merely finite: `created_at` is an integer column, and
  // a fractional or out-of-range value reaches the driver as a syntax error.
  const rawSince = blankToUndefined(c.req.query("since"));
  const since = rawSince === undefined ? undefined : Number(rawSince);
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return c.json({ error: "since must be a whole millisecond timestamp, 0 or greater" }, 400);
  }

  // `status`, `outcome` and `workflowId` are repeatable and match any-of.
  const rawStatus = c.req.queries("status");
  const status = rawStatus?.filter(isRunStatus);
  if (rawStatus && status && status.length !== rawStatus.length) {
    return c.json({ error: `status must be one of: ${RUN_STATUS_VALUES.join(", ")}` }, 400);
  }
  const rawOutcome = c.req.queries("outcome");
  const outcome = rawOutcome?.filter(isRunOutcome);
  if (rawOutcome && outcome && outcome.length !== rawOutcome.length) {
    return c.json({ error: `outcome must be one of: ${RUN_OUTCOME_VALUES.join(", ")}` }, 400);
  }

  let page;
  try {
    page = await listRunsForOwner(deps, owner, {
      workflowIds: c.req.queries("workflowId"),
      status,
      outcome,
      parentRunId: blankToUndefined(c.req.query("parentRunId")),
      since,
      limit: limit.limit,
      cursor: blankToUndefined(c.req.query("cursor")),
      scope: filter.scope,
    });
  } catch (err) {
    if (err instanceof WorkflowCursorError) return c.json({ error: err.message }, 400);
    throw err;
  }
  // Same convention as every other handler here: a workflow the caller
  // cannot read is indistinguishable from one that does not exist.
  if (!page) return c.json({ error: "workflow not found" }, 404);

  // Rows carry `workflowName`: this list mixes workflows, so the hub's Runs
  // tab has no heading to name them from.
  const resp: ListAllWorkflowRunsResponse = page;
  return c.json(resp);
});

workflowsRouter.get("/action-required", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const resp: ListWorkflowActionRequiredResponse = await listWorkflowActionRequired(deps, owner);
  return c.json(resp);
});

// ── Import ────────────────────────────────────────────────────────────────

/**
 * Reads one file out of a PUBLIC GitHub repository, so the import dialog can
 * take a definition that lives in version control.
 *
 * PUBLIC REPOSITORIES ONLY. The reader accepts a credential (skill sync
 * gives it one), and this route does not pass one yet. That is a gap, not a
 * rule: this route has the caller in `c.var.user`, so the correct credential
 * here is that person's own, through `resolveUserApiToken`, passed as
 * `{ kind: "user", token, ownerScope: "user" }` — the caller reads their own
 * error here, which is what `ownerScope` selects the wording for.
 *
 * Do NOT reach for `services/content-source-credential.ts` when you close the
 * gap. That module re-checks team and org membership because a source row
 * outlives the membership that justified it; this route is authenticated per
 * request, so the caller's membership is already live. And do NOT resolve
 * the org App installation token, which reaches every repository the App is
 * installed on and would let a caller read a repository they cannot see on
 * GitHub.
 *
 * The file is returned as TEXT. The client owns the one parser that reads
 * both a pasted file and this response, so the two sources cannot drift into
 * accepting different shapes, and the definition is validated where every
 * other definition is validated — `POST /` below, with the full environment
 * hooks that reject an unknown service.
 */
workflowsRouter.get("/import/repo-file", async (c) => {
  const repo = blankToUndefined(c.req.query("repo"));
  const path = blankToUndefined(c.req.query("path"));
  if (repo === undefined) {
    return c.json({ error: "Enter a repository. Write it as owner/repo, or paste its GitHub URL." }, 400);
  }
  if (path === undefined) {
    return c.json(
      { error: "Enter the path of the workflow file in the repository, such as workflows/deploy.json." },
      400,
    );
  }

  // `parseRepoInput` is the address parser the skill sources form already
  // uses. It reads `owner/repo` out of a bare name or a GitHub URL, and it
  // refuses a ref or a path that leaves the repository.
  let parsed;
  try {
    parsed = parseRepoInput(repo, { ref: blankToUndefined(c.req.query("ref")), subpath: path });
  } catch (err) {
    if (err instanceof ContentSourceInputError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (parsed.subpath === "") {
    return c.json(
      { error: "Enter the path of the workflow file in the repository, such as workflows/deploy.json." },
      400,
    );
  }

  const at = parsed.ref === "" ? "" : ` at ${parsed.ref}`;
  let file: SkillRepoFile | null;
  try {
    // Constructed per request so the GitHub base URL is read now, not at
    // module load — the same rule `repos/github-host.ts` follows.
    file = await new GitHubSkillRepoReader().readFile(parsed.repoFullName, parsed.subpath, parsed.ref);
  } catch (err) {
    // The reader words its own messages for the skill sync sweep, which
    // tells the reader to wait for the next poll. An import has a person in
    // front of it, so the action named here is the one they can take now.
    if (err instanceof SkillRepoTimeoutError) {
      return c.json(
        { error: `GitHub did not answer for ${parsed.repoFullName}. Try the import again.` },
        504,
      );
    }
    if (err instanceof SkillRepoReadError) {
      return c.json(
        {
          error: `GitHub refused to serve ${parsed.repoFullName}/${parsed.subpath}. Valet reads public repositories without a credential, and GitHub limits that to 60 requests each hour. Wait, then try the import again.`,
        },
        502,
      );
    }
    throw err;
  }

  // One message covers every miss: unauthenticated, a private repository, a
  // wrong branch, a misspelled path and a directory all answer the same way.
  if (file === null) {
    return c.json(
      {
        error: `Valet found no file at ${parsed.subpath} in ${parsed.repoFullName}${at}. Valet reads public repositories only, so a private repository, a wrong branch and a misspelled path look the same here. Check the repository, the path and the branch, and make the repository public.`,
      },
      404,
    );
  }
  const content = file.text;
  if (content.trim() === "") {
    return c.json(
      {
        error: `${parsed.subpath} in ${parsed.repoFullName}${at} is empty, or larger than the 1 MB GitHub serves inline. Point the path at the exported definition file.`,
      },
      400,
    );
  }

  const resp: GetWorkflowImportFileResponse = {
    repo: parsed.repoFullName,
    path: parsed.subpath,
    ref: parsed.ref,
    content,
  };
  return c.json(resp);
});

workflowsRouter.get("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const summary = await getWorkflowDefinition(deps, owner, c.req.param("id"));
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const resp: GetWorkflowResponse = summary;
  return c.json(resp);
});

/**
 * Decision-4 envelope as a file. Default YAML. A mirrored workflow writes
 * its upstream reference into `description` and nowhere else, so a commit
 * of the download is a labeled file and not a Valet row dump.
 */
workflowsRouter.get("/:id/file", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const summary = await getWorkflowDefinition(deps, owner, c.req.param("id"));
  if (!summary) return c.json({ error: "workflow not found" }, 404);

  const formatRaw = blankToUndefined(c.req.query("format")) ?? "yaml";
  if (formatRaw !== "yaml" && formatRaw !== "json") {
    return c.json({ error: "format must be 'yaml' or 'json'." }, 400);
  }
  const format = formatRaw;

  const description =
    summary.origin === "repo" && summary.upstream
      ? `Mirrored from ${summary.upstream.repoFullName}:${summary.upstream.path}`
      : undefined;
  const envelope = workflowFileEnvelope({
    name: summary.name,
    description,
    definition: summary.definition as WorkflowDefinition,
  });
  const filename = workflowFileBasename(summary.name, format, summary.upstream?.path);
  const body =
    format === "json" ? `${JSON.stringify(envelope, null, 2)}\n` : stringifyYaml(envelope);
  c.header("Content-Type", format === "json" ? "application/json; charset=utf-8" : "text/yaml; charset=utf-8");
  // Keep the quoted fallback ASCII; filename* preserves the upstream name.
  const fallback = workflowFileBasename(summary.name, format);
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const disposition = /^[a-zA-Z0-9._-]+$/.test(filename)
    ? `attachment; filename="${filename}"`
    : `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  c.header("Content-Disposition", disposition);
  return c.body(body);
});

workflowsRouter.put("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const env = await buildOrgValidateEnvironment(deps, owner.orgId);
  const id = c.req.param("id");

  let body: UpdateWorkflowRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body.definition !== undefined) {
    const validation = validateDefinitionInput(body.definition, env);
    if (!validation.ok) {
      return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
    }
  }

  const updated = await updateWorkflowDefinition(deps, owner, id, {
    name: body.name,
    definition: body.definition,
  });
  if (!updated) return c.json({ error: "workflow not found" }, 404);

  const resp: UpdateWorkflowResponse = updated;
  return c.json(resp);
});

/** Change only model-capable nodes. Existing models stay unchanged unless this route is called. */
workflowsRouter.patch("/:id/model", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const env = await buildOrgValidateEnvironment(deps, owner.orgId);
  let body: UpdateWorkflowModelRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowModelRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return c.json({ error: "model must be an approved model id or an org model tier" }, 400);
  }
  if (body.nodeIds !== undefined && (!Array.isArray(body.nodeIds) || body.nodeIds.some((id) => typeof id !== "string"))) {
    return c.json({ error: "nodeIds must be an array of llm or session node ids" }, 400);
  }
  const catalog = await buildOrgCatalog(deps.db, deps.credentials, owner.orgId);
  if (!catalogValidIds(catalog).has(body.model)) {
    return c.json({ error: `unknown or inactive model: ${body.model}. Pick a model from GET /api/models, or use xs, s, m, l, or xl.` }, 400);
  }
  const concrete = catalog.find((entry) =>
    entry.id === body.model || (entry.id.startsWith("anthropic/") && entry.id.slice("anthropic/".length) === body.model),
  );
  if (concrete && !concrete.approved) {
    return c.json({ error: `model ${body.model} is not approved. Choose an approved model or an org model tier.` }, 400);
  }
  const wf = await getWorkflowDefinition(deps, owner, c.req.param("id"));
  if (!wf) return c.json({ error: "workflow not found" }, 404);
  const stored = validateDefinitionInput(wf.definition);
  if (!stored.ok) return c.json({ error: "invalid stored workflow definition", errors: stored.errors }, 409);
  const patched = applyWorkflowModelPatch(stored.definition, body.model, body.nodeIds);
  if (!patched.ok) return c.json({ error: "model update is invalid", errors: patched.errors }, 400);
  const validation = validateDefinitionInput(patched.definition, env);
  if (!validation.ok) return c.json({ error: "model update is invalid", errors: validation.errors }, 400);
  const updated = await updateWorkflowDefinition(deps, owner, c.req.param("id"), { definition: patched.definition });
  if (!updated) return c.json({ error: "workflow not found" }, 404);
  const resp: UpdateWorkflowModelResponse = {
    workflowId: updated.id,
    model: body.model,
    nodeIds: patched.nodeIds,
  };
  return c.json(resp);
});

/**
 * Copies a workflow into a `local` one the caller owns. This is the escape
 * hatch for a mirrored workflow, which every write path refuses with 409:
 * the file keeps the original, and the copy is an ordinary workflow the
 * editor can save.
 */
workflowsRouter.post("/:id/copy-to-team", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("teamId" in body) || typeof body.teamId !== "string" || !body.teamId.trim() ||
      !("name" in body) || typeof body.name !== "string") {
    return c.json({ error: "Provide a destination teamId and a new workflow name." }, 400);
  }
  const principal = requirePrincipal(c);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const destination = await resolveCreateOwner({
    principal, authVia: c.var.authVia, bodyTeamId: body.teamId, userId: owner.userId,
    isTeamMember: (teamId) => isTeamMember(deps.db, teamId, owner.userId),
  });
  if (!destination.ok) return c.json({ error: destination.error }, destination.status);
  const copy = await copyWorkflowDefinition(deps, owner, c.req.param("id"), { teamId: body.teamId, name: body.name });
  if (!copy) return c.json({ error: "workflow not found" }, 404);
  return c.json(copy, 201);
});

workflowsRouter.post("/:id/copy", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const copy = await copyWorkflowDefinition(deps, owner, c.req.param("id"));
  if (!copy) return c.json({ error: "workflow not found" }, 404);
  const resp: CreateWorkflowResponse = copy;
  return c.json(resp, 201);
});

workflowsRouter.delete("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowDefinition(deps, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  if (result === "has_active_runs") {
    return c.json(
      { error: "workflow has runs that are not settled. Cancel them first, then delete." },
      409,
    );
  }
  return c.json({ ok: true });
});

// ── Runs ──────────────────────────────────────────────────────────────────
// The owner filter stops at the list above. Every per-workflow route below
// — runs, versions, webhook, schedules — already resolves one workflow id
// and checks its owner, and a workflow has exactly one owner, so an owner
// filter on those could only restate what the path already says.

workflowsRouter.post("/:id/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");

  let body: StartWorkflowRunRequest = {};
  try {
    const text = await c.req.text();
    if (text.length > 0) body = JSON.parse(text) as StartWorkflowRunRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const started = await startWorkflowRun(deps, owner, id, body.input);
  if (!started) return c.json({ error: "workflow not found" }, 404);
  if ("invalidInput" in started) {
    return c.json(
      {
        error: `run input is invalid: ${started.invalidInput.map((e) => e.message).join(" ")}`,
        fields: started.invalidInput,
      },
      400,
    );
  }

  const resp: StartWorkflowRunResponse = { runId: started.runId };
  return c.json(resp, 201);
});

workflowsRouter.get("/:id/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const limit = parseRunLimit(c.req.query("limit"));
  if ("error" in limit) return c.json({ error: limit.error }, 400);

  let page;
  try {
    page = await listWorkflowRuns(deps, owner, c.req.param("id"), {
      limit: limit.limit,
      cursor: blankToUndefined(c.req.query("cursor")),
    });
  } catch (err) {
    if (err instanceof WorkflowCursorError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (!page) return c.json({ error: "workflow not found" }, 404);

  const resp: ListWorkflowRunsResponse = page;
  return c.json(resp);
});

// ── Permissions preview + bulk pre-approval ──────────────────────────────
// The gating set is server-derived from the stored definition on BOTH
// routes; the POST body can only narrow it. See `../workflows/permissions.ts`.

workflowsRouter.get("/:id/permissions", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const nodes = await analyzeWorkflowPermissions(deps, owner, c.req.param("id"));
  if (nodes === null) return c.json({ error: "workflow not found" }, 404);
  const resp: GetWorkflowPermissionsResponse = { nodes };
  return c.json(resp);
});

workflowsRouter.delete("/:id/permissions/allow", async (c) => {
  const { deps, owner } = serviceCtx(c);
  if (!(await revokeWorkflowPermissions(deps, owner, c.req.param("id")))) return c.json({ error: "Workflow not found or permission management is not allowed." }, 404);
  return c.json({ ok: true });
});

workflowsRouter.post("/:id/permissions/allow", async (c) => {
  const { deps, owner } = serviceCtx(c);

  // Shape-check before use: `null` would throw on property access below,
  // and a bare array has no own `actionIds`, so it would silently take the
  // "omitted → pre-approve all" branch — a narrowing request must never
  // widen on a permissions-granting route.
  let body: AllowWorkflowPermissionsRequest = {};
  try {
    const text = await c.req.text();
    if (text.length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return c.json(
          { error: 'request body must be a JSON object, e.g. {"actionIds": ["service.action"]}. Omit actionIds to pre-approve all gating actions.' },
          400,
        );
      }
      body = parsed as AllowWorkflowPermissionsRequest;
    }
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.actionIds !== undefined) {
    if (!Array.isArray(body.actionIds) || body.actionIds.some((id) => typeof id !== "string")) {
      return c.json({ error: "actionIds must be an array of strings" }, 400);
    }
  }

  const outcome = await allowWorkflowPermissions(deps, owner, c.req.param("id"), body.actionIds);
  if (outcome === null) return c.json({ error: "workflow not found" }, 404);
  if (!outcome.ok) return c.json({ error: outcome.badRequest }, 400);

  const resp: AllowWorkflowPermissionsResponse = outcome.result;
  return c.json(resp);
});

workflowsRouter.get("/:id/versions", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const versions = await listWorkflowVersions(deps, owner, c.req.param("id"));
  if (!versions) return c.json({ error: "workflow not found" }, 404);
  const resp: ListWorkflowVersionsResponse = { versions };
  return c.json(resp);
});

workflowsRouter.get("/:id/versions/:version", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: "version must be a positive integer" }, 400);
  }
  const detail = await getWorkflowVersion(deps, owner, c.req.param("id"), version);
  if (!detail) return c.json({ error: "version not found" }, 404);
  const resp: GetWorkflowVersionResponse = detail;
  return c.json(resp);
});

// ── Webhook trigger (overhaul design decision 5) ────────────────────────────
// The bearer secret itself is minted/rotated/revoked here, owner-scoped like
// every other route in this file. The secret is CONSUMED at
// `POST /api/hooks/workflows/:workflowId/:hookId` (`routes/workflow-hooks.ts`),
// an intentionally unauthenticated route mounted before `buildAuthMiddleware`.

workflowsRouter.post("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await mintOrRotateWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, 404);
  const resp: WorkflowWebhookResponse = {
    ...result.webhook,
    url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId, new URL(c.req.url).origin),
  };
  return c.json(resp);
});

workflowsRouter.get("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await getWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: "workflow not found" }, 404);
  if (!result.webhook) return c.json({ error: "no webhook configured for this workflow" }, 404);
  const resp: WorkflowWebhookResponse = {
    ...result.webhook,
    url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId, new URL(c.req.url).origin),
  };
  return c.json(resp);
});

workflowsRouter.delete("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  const resp: DeleteWorkflowWebhookResponse = { deleted: result === "deleted" };
  return c.json(resp);
});

// ── Schedules (cron triggers) ─────────────────────────────────────────────
// Owner-scoped like the webhook routes above: every route resolves the
// workflow through `getWorkflowDefinition` first, so an unowned workflow
// 404s identically to a missing one. The schedule service also carries
// orchestrator-prompt schedules; this surface manages only the
// workflow-scoped kind, so every row it returns has a `workflowId`.

function toScheduleWire(s: WorkflowScheduleSummary, workflowId: string): WorkflowScheduleWire {
  return {
    scheduleId: s.scheduleId,
    workflowId: s.workflowId ?? workflowId,
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    lastFiredAt: s.lastFiredAt,
    nextFireAt: s.nextFireAt,
  };
}

workflowsRouter.get("/:id/schedules", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const schedules = await listWorkflowSchedules(deps.db, owner, id);
  const resp: ListWorkflowSchedulesResponse = {
    schedules: schedules.map((s) => toScheduleWire(s, id)),
  };
  return c.json(resp);
});

workflowsRouter.post("/:id/schedules", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);

  let body: CreateScheduleOnWorkflowRequest;
  try {
    body = (await c.req.json()) as CreateScheduleOnWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "name must be a non-empty string" }, 400);
  }
  if (!body.cron || typeof body.cron !== "string") {
    return c.json({ error: "cron must be a 5-field cron expression string" }, 400);
  }
  if (body.timezone !== undefined && typeof body.timezone !== "string") {
    return c.json({ error: "timezone must be an IANA timezone string" }, 400);
  }
  if (
    body.input !== undefined &&
    (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))
  ) {
    return c.json({ error: "input must be a JSON object" }, 400);
  }

  const result = await createWorkflowSchedule(armDeps(c), owner, {
    workflowId: id,
    name,
    cron: body.cron,
    timezone: body.timezone,
    input: body.input,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  const resp: CreateWorkflowScheduleResponse = toScheduleWire(result.schedule, id);
  return c.json(resp, 201);
});

workflowsRouter.delete("/:id/schedules/:scheduleId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const scheduleId = c.req.param("scheduleId");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const result = await deleteWorkflowSchedule(deps.db, owner, scheduleId, id);
  if (result === "not_found") return c.json({ error: "schedule not found" }, 404);
  const resp: DeleteWorkflowScheduleResponse = { deleted: true };
  return c.json(resp);
});

workflowsRouter.get("/runs/:runId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const resp = await getWorkflowRunDetail(deps, owner, c.req.param("runId"));
  if (!resp) return c.json({ error: "run not found" }, 404);
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/approvals/:nodeId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");
  const nodeId = c.req.param("nodeId");

  let body: ResolveWorkflowApprovalRequest;
  try {
    body = (await c.req.json()) as ResolveWorkflowApprovalRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.approved !== "boolean") {
    return c.json({ error: "approved is required" }, 400);
  }
  // Reject legacy grantActions field — scope replaces it.
  if ("grantActions" in body) {
    return c.json({ error: "grantActions is no longer supported; use scope instead" }, 400);
  }
  if (body.scope !== undefined && !["once", "run", "always", "workflow"].includes(body.scope)) {
    return c.json({ error: "scope must be one of: once, run, always, workflow" }, 400);
  }
  if (body.iteration !== undefined && (!Number.isInteger(body.iteration) || body.iteration < 0)) {
    return c.json({ error: "iteration must be a non-negative integer" }, 400);
  }

  const result = await resolveWorkflowApproval(deps, owner, {
    runId,
    nodeId,
    approved: body.approved,
    note: body.note,
    scope: body.scope,
    iteration: body.iteration,
    via: "web",
  });

  if (result === "not_found") return c.json({ error: "run not found" }, 404);
  if (result === "not_parked") return c.json({ error: "run is not parked on this approval gate" }, 409);
  if (result === "already_resolved") return c.json({ error: "this approval gate has already been resolved" }, 409);
  if (result === "timed_out") return c.json({ error: "this approval gate has timed out" }, 409);
  if (result === "forbidden_workflow") return c.json({ error: "This workflow permission cannot be saved. Its owner or team admin must review the current workflow and any policy restrictions." }, 403);
  if (result === "forbidden_always") return c.json({ error: "Always allow requires an org admin. Ask an org admin, or approve for the rest of this run." }, 403);
  if (result === "org_mismatch") return c.json({ error: "not a member of this workflow's org" }, 403);
  if (result === "human_only") return c.json({ error: "policy gates must be resolved by a human from the run page" }, 403);

  const resp: ResolveWorkflowApprovalResponse = { ok: true };
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/cancel", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");

  const result = await cancelWorkflowRun(deps, owner, runId);
  if (result === "not_found") return c.json({ error: "run not found" }, 404);

  const resp: CancelWorkflowRunResponse = { ok: true };
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/retry", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");

  const result = await retryWorkflowRun(deps, owner, runId);
  if (result === "not_found") return c.json({ error: "run not found" }, 404);
  if (result === "workflow_deleted") {
    return c.json(
      { error: "This run's workflow was deleted. Create the workflow again, then start a new run." },
      404,
    );
  }
  if (result === "not_retryable") {
    return c.json(
      { error: "Only failed or cancelled runs can be retried. Wait for the run to settle, or cancel it first." },
      409,
    );
  }
  if ("invalidInput" in result) {
    // The workflow's trigger schema changed since the original run; mirror
    // the start route's invalid-input shape.
    return c.json(
      {
        error: `The original input no longer matches the workflow's input schema: ${result.invalidInput.map((e) => e.message).join(" ")} Start a new run with valid input.`,
        fields: result.invalidInput,
      },
      400,
    );
  }

  const resp: RetryWorkflowRunResponse = { runId: result.runId };
  return c.json(resp, 201);
});
