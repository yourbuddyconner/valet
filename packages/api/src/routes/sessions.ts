import { visibleWorkOrigin } from "../services/work-origin.js";
import { Hono } from "hono";
import { and, count, desc, eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseAssistantSessionId, type Principal } from "@valet/engine";
import { writeHibernated } from "../engine/hibernation-hooks.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { computeTargetDirs } from "../engine/workspace-prep.js";
import { promptAuthorFromUser, submitSessionPrompt } from "./messages.js";
import { autoTitle } from "../sessions/auto-title.js";
import {
  deriveRunFields,
  groupSubmissionsBySession,
  type RunStateRow,
  type SessionRunFields,
} from "../sessions/run-state.js";
import { canAdministerSession, canViewSession, isSessionDirectOwner } from "../services/session-access.js";
import { isOrgAdminUser } from "./_org-admin.js";
import { assertModelSelectable } from "../services/approved-models.js";
import { assertReasoningSelectable } from "../services/reasoning.js";
import { loadAssistantBySessionId } from "../assistants/service.js";
import {
  createSecurityEngagementService,
  type SecurityConfigContext,
} from "../services/security-engagements.js";
import { seedSecurityReview, seededConfigContext } from "../services/security-seed.js";
import { planCellInputToCell, PlanCellInputError } from "./security.js";
import { resolveApiTokenOrNull, resolveRefSha } from "../bakes/source-service.js";
import { checkRepoExistence } from "../services/repo-existence.js";
import { getTeamInOrg, isTeamMember, listTeamsForUser } from "../services/teams.js";
import { requirePrincipal } from "../middleware/auth.js";
import { resolveCreateOwner } from "../lib/request-principal.js";
import { orgAllowsPluginForUser } from "../services/plugin-entitlements.js";
import {
  bundledPersonaIds,
  isKnownPreset,
  parsePlan,
  presetPlan,
  rescanPlan,
  SECURITY_PRESETS,
  securityKickoffPrompt,
  securitySessionTitle,
  serializePlan,
} from "@valet/plugin-security";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import {
  agentSessions,
  assistants,
  childWatches,
  messages as messagesTable,
  sessionRepos,
} from "../schema/index.js";
import type {
  AssistantOwner,
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  PatchSessionRequest,
  PauseSessionResponse,
  RepoBinding,
  SandboxJwtResponse,
  SandboxProfile,
  SessionStatus,
  SessionSummary,
} from "../wire/types.js";

import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";

export const sessionsRouter = new Hono<AppEnv>();

function newId(prefix: string): string {
  // Short URL-safe id; not cryptographic. Engine's own id collision domain is
  // separate (prefixed `sess-...` by the engine); we use `s_...` here.
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const REPO_AUTH_VALUES = ["auto", "app", "user"] as const;

// Validates + normalizes the `repo`/`repos` create-request sugar into a flat
// list (GitHub/repo integration plan, Task 2). Returns an error message on
// the first invalid binding rather than a field-keyed map — the route
// surfaces it as a flat 400 like every other validation error here.
function parseRepoBindings(body: CreateSessionRequest): { repos: RepoBinding[] } | { error: string } {
  if (body.repo !== undefined && body.repos !== undefined) {
    return { error: "specify either 'repo' or 'repos', not both" };
  }
  const raw = body.repos ?? (body.repo !== undefined ? [body.repo] : undefined);
  if (raw === undefined) return { repos: [] };
  if (!Array.isArray(raw)) return { error: "repos must be an array" };
  if (raw.length > 5) return { error: "at most 5 repo bindings are allowed" };

  const repos: RepoBinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      return { error: "each repo binding must be an object" };
    }
    if (typeof r.fullName !== "string" || r.fullName.trim() === "") {
      return { error: "repo binding fullName is required" };
    }
    if (typeof r.cloneUrl !== "string" || !r.cloneUrl.startsWith("https://")) {
      return { error: "repo binding cloneUrl must be an https:// URL" };
    }
    if (r.auth !== undefined && !REPO_AUTH_VALUES.includes(r.auth)) {
      return { error: "repo binding auth must be 'auto', 'app', or 'user'" };
    }
    repos.push({
      host: r.host ?? "github",
      fullName: r.fullName,
      cloneUrl: r.cloneUrl,
      ref: r.ref,
      auth: r.auth ?? "auto",
    });
  }
  return { repos };
}

async function getSessionRepos(db: AppDb, sessionId: string): Promise<RepoBinding[]> {
  const rows = await db
    .select()
    .from(sessionRepos)
    .where(eq(sessionRepos.sessionId, sessionId))
    .orderBy(sessionRepos.position);
  return rows.map((row) => ({
    host: row.host,
    fullName: row.fullName,
    cloneUrl: row.cloneUrl,
    ref: row.ref ?? undefined,
    auth: row.auth,
  }));
}

// Pure: everything it needs is the row plus the already-derived run fields
// (`sessions/run-state.ts` owns that derivation, and the queries that feed
// it). Keeping the mapper query-free is what lets the list route derive for
// every row from ONE cross-session read.
function rowToSummary(row: typeof agentSessions.$inferSelect, run: SessionRunFields): SessionSummary {
  return {
    id: row.id,
    workspace: row.workspace,
    status: row.status as SessionStatus,
    // The column is free text (shared shape with #396's 'design'); the wire
    // narrows to the kinds this API mints.
    kind: row.kind === "security" ? "security" : "code",
    runState: run.runState,
    title: row.title ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Prefer the persisted column; fall back to the queue-derived value
    // for rows written before the column existed (TKAI-341).
    lastActivityAt: Math.max(row.lastActivityAt ?? 0, run.lastActivityAt),
    owner: { type: row.ownerType as AssistantOwner["type"], id: row.ownerId },
  };
}

/** The row fields `deriveRunFields` reads, narrowed from a full session row. */
function runStateRow(row: typeof agentSessions.$inferSelect): RunStateRow {
  return { status: row.status as SessionStatus, updatedAt: row.updatedAt, lastActivityAt: row.lastActivityAt };
}

// ── List ──────────────────────────────────────────────────────────────────

// Standalone work excludes workspace runtimes and spawned children. Threads
// discovers child work through the parent-scoped children endpoint.
export async function listStandaloneSessions(db: AppDb, userId: string, owner?: Principal) {
  // Own rows plus every team you are on — the same union `listWorkflowDefinitions`
  // and `listSkills` use, so one workspace's sessions read like its workflows.
  // `owner` narrows that to a single workspace; the caller has already checked
  // they may reach it.
  const teamIds = owner ? [] : (await listTeamsForUser(db, userId)).map((t) => t.id);
  const mine = and(eq(agentSessions.ownerType, "user"), eq(agentSessions.ownerId, userId));
  const teamRows =
    teamIds.length > 0
      ? and(eq(agentSessions.ownerType, "team"), inArray(agentSessions.ownerId, teamIds))
      : undefined;
  const scope = owner
    ? and(eq(agentSessions.ownerType, owner.type), eq(agentSessions.ownerId, owner.id))
    : teamRows
      ? or(mine, teamRows)
      : mine;

  const rows = await db
      .select()
      .from(agentSessions)
      .where(and(
        scope,
        inArray(agentSessions.status, ["active", "hibernated"]),
        notExists(db.select({ id: childWatches.childSessionId }).from(childWatches)
          .where(eq(childWatches.childSessionId, agentSessions.id))),
        notExists(db.select({ id: assistants.sessionId }).from(assistants)
          .where(eq(assistants.sessionId, agentSessions.id))),
      ))
      .orderBy(desc(sql`COALESCE(${agentSessions.lastActivityAt}, ${agentSessions.updatedAt})`));
  // Retain the prefix fallback for assistant rows whose metadata is gone.
  return rows.filter((r) => parseAssistantSessionId(r.id) === null);
}

sessionsRouter.get("/", async (c) => {
  const { db, engineStore } = c.var.providers;
  const userId = c.var.user.id;

  // Optional workspace filter, same shape `GET /api/assistants` takes.
  const ownerType = c.req.query("ownerType");
  const ownerId = c.req.query("ownerId");
  if ((ownerType === undefined) !== (ownerId === undefined)) {
    return c.json({ error: "Filter by owner with both ownerType and ownerId, or send neither." }, 400);
  }
  let owner: Principal | undefined;
  const principal = requirePrincipal(c);
  if (principal?.type === "team") {
    if (ownerType === undefined) {
      owner = principal;
    } else if (ownerType === "team" && ownerId === principal.id) {
      owner = principal;
    } else {
      return c.json({ error: "owner not found" }, 404);
    }
  } else if (ownerType !== undefined && ownerId !== undefined) {
    if (ownerType !== "user" && ownerType !== "team") {
      return c.json({ error: "ownerType must be 'user' or 'team'." }, 400);
    }
    const reachable =
      ownerType === "user" ? ownerId === userId : await isTeamMember(db, ownerId, userId);
    // 404, not 403: the same existence-hiding every cross-owner read here uses.
    if (!reachable) return c.json({ error: "owner not found" }, 404);
    owner = { type: ownerType, id: ownerId };
  }

  // Discovery preserves each execution's runtime and authorization boundary.
  if (c.req.query("discovery") === "true") {
    if (!owner) return c.json({ error: "Choose a workspace to browse work." }, 400);
    if (owner.type === "team" && !await getTeamInOrg(db, c.var.user.orgId, owner.id)) {
      return c.json({ error: "Workspace not found. Choose a workspace you can access." }, 404);
    }
    const limit = readLimit(c.req.query("limit"), 25, 100);
    if (limit === undefined) return c.json({ error: "Send a positive whole number for limit." }, 400);
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor === undefined ? undefined : decodePageCursor(rawCursor);
    if (rawCursor !== undefined && (!cursor || typeof cursor.createdAt !== "number" ||
        !Number.isSafeInteger(cursor.createdAt) || typeof cursor.id !== "string" || !cursor.id ||
        cursor.ownerType !== owner.type || cursor.ownerId !== owner.id)) {
      return c.json({ error: "Invalid work cursor. Remove it to start at the first page." }, 400);
    }
    const rows = await db.select().from(agentSessions).where(and(
      eq(agentSessions.orgId, c.var.user.orgId),
      eq(agentSessions.ownerType, owner.type), eq(agentSessions.ownerId, owner.id),
      inArray(agentSessions.status, ["active", "hibernated", "archived"]),
      sql`${agentSessions.id} NOT LIKE 'assistant:%'`,
      notExists(db.select({ id: assistants.sessionId }).from(assistants)
        .where(eq(assistants.sessionId, agentSessions.id))),
      cursor ? or(lt(agentSessions.createdAt, Number(cursor.createdAt)),
        and(eq(agentSessions.createdAt, Number(cursor.createdAt)), lt(agentSessions.id, String(cursor.id)))) : undefined,
    )).orderBy(desc(agentSessions.createdAt), desc(agentSessions.id)).limit(limit + 1);
    const visible = rows.slice(0, limit);
    const bySession = groupSubmissionsBySession(await engineStore.listAllUnsettledSubmissions(visible.map(row => row.id)));
    const last = visible.at(-1);
    const body: ListSessionsResponse = {
      sessions: visible.map(row => rowToSummary(row, deriveRunFields(runStateRow(row), bySession.get(row.id) ?? []))),
      nextCursor: rows.length > limit && last
        ? encodePageCursor({ createdAt: last.createdAt, id: last.id, ownerType: owner.type, ownerId: owner.id }) : null,
    };
    return c.json(body);
  }

  // Optional kind filter, the shape the security hub reads
  // (`GET /api/sessions?kind=security`).
  const kindFilter = c.req.query("kind");
  if (kindFilter !== undefined && kindFilter !== "code" && kindFilter !== "security") {
    return c.json({ error: "kind must be 'code' or 'security'." }, 400);
  }

  const standalone = await listStandaloneSessions(db, userId, owner);
  const filtered =
    kindFilter === undefined
      ? standalone
      : standalone.filter((row) => (row.kind === "security" ? "security" : "code") === kindFilter);

  // Fetch queue state only for authorized sessions that enter this response.
  const unsettled = await engineStore.listAllUnsettledSubmissions(filtered.map((row) => row.id));
  const bySession = groupSubmissionsBySession(unsettled);

  const body: ListSessionsResponse = {
    sessions: filtered.map((row) =>
      rowToSummary(row, deriveRunFields(runStateRow(row), bySession.get(row.id) ?? [])),
    ),
  };
  return c.json(body);
});

// ── Create ────────────────────────────────────────────────────────────────

/** A security review defaults to a capable model, not the account/org
 * fallback. `resolveModelForBuild` bottoms out at `claude-haiku-4-5`, which
 * is too weak for security review, so a security session with no explicit
 * model gets this instead. An explicit `model` on the request always wins. */
const SECURITY_DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Session kinds backed by a gateable plugin (plugin-entitlements design). A
 * kind in this map may only be created when its plugin is instance-loaded AND
 * the caller's org admits the caller. A future plugin-backed kind adds one
 * entry here. `code` is not backed by a plugin, so it is absent.
 */
const KIND_TO_PLUGIN: Partial<Record<"code" | "security", string>> = {
  security: "security",
};

/** UI label for a gateable plugin's kind, for the refusal messages below. */
const PLUGIN_LABEL: Record<string, string> = {
  security: "Valet Security",
};

sessionsRouter.post("/", async (c) => {
  const { db, engineStore, prebuildService, engineCredentials, encryptionKey } = c.var.providers;
  const user = c.var.user;
  let body: CreateSessionRequest;
  try {
    body = (await c.req.json()) as CreateSessionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.workspace || typeof body.workspace !== "string") {
    return c.json({ error: "workspace is required" }, 400);
  }
  if (!isAbsolute(body.workspace)) {
    return c.json({ error: "workspace must be an absolute path" }, 400);
  }
  if (body.profile !== undefined && body.profile !== "headless" && body.profile !== "full") {
    return c.json({ error: "profile must be 'headless' or 'full'" }, 400);
  }
  const profile = body.profile ?? "headless";
  // Rejected here, before anything is written: a mistyped `initialPrompt` is
  // a bad request, not a failed enqueue.
  if (body.initialPrompt !== undefined && typeof body.initialPrompt !== "string") {
    return c.json({ error: "initialPrompt must be a string. Send the prompt text, or omit the field." }, 400);
  }
  if (body.docker !== undefined && typeof body.docker !== "boolean") {
    return c.json({ error: "docker must be a boolean. Send true or false, or omit the field." }, 400);
  }
  const docker = body.docker === true;
  if (body.kind !== undefined && body.kind !== "code" && body.kind !== "security") {
    return c.json({ error: "kind must be 'code' or 'security'." }, 400);
  }
  const kind = body.kind ?? "code";

  // Plugin entitlement gate (plugin-entitlements design). A plugin-backed kind
  // needs two things: the plugin loaded on this deployment (the instance
  // switch), and the caller's org admits the caller (the org mode). Placed
  // here, before anything is written, so a refusal never leaves an orphaned
  // session or engagement row.
  const gatingPlugin = KIND_TO_PLUGIN[kind];
  if (gatingPlugin) {
    const label = PLUGIN_LABEL[gatingPlugin] ?? gatingPlugin;
    if (!c.var.providers.engineHost.isPluginLoaded(gatingPlugin)) {
      return c.json({ error: `${label} is not enabled on this deployment.` }, 403);
    }
    if (!(await orgAllowsPluginForUser(db, user.orgId, user.id, gatingPlugin))) {
      return c.json(
        { error: `${label} is not enabled for your account. Ask an org admin to enable it.` },
        403,
      );
    }
  }

  // A security session's sweep preset and path scope. Validated here, before
  // anything is written, so a bad id or a mistyped `paths` is a bad request,
  // not a failed seed. Both fields only matter for a security session; a code
  // session ignores them.
  const presetId = body.preset ?? "code-review";
  if (kind === "security") {
    if (typeof presetId !== "string" || !isKnownPreset(presetId)) {
      const known = SECURITY_PRESETS.map((p) => p.id).join(", ");
      return c.json(
        { error: `Unknown preset "${String(presetId)}". Known presets: ${known}. Pick one when you start the review.` },
        400,
      );
    }
    if (
      body.paths !== undefined &&
      (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== "string"))
    ) {
      return c.json(
        { error: "paths must be a list of strings. Send the include globs, or omit the field." },
        400,
      );
    }
    // Setup-page overrides (`/security/new`): the final config + plan the user
    // edited before create. Validated here, before anything is written.
    if (body.securityConfig !== undefined) {
      const sc = body.securityConfig;
      if (typeof sc !== "object" || sc === null || Array.isArray(sc)) {
        return c.json({ error: "securityConfig must be an object with focus, invariants, or categories." }, 400);
      }
      if (sc.focus !== undefined && sc.focus !== null && typeof sc.focus !== "string") {
        return c.json({ error: "securityConfig.focus must be a text note or null." }, 400);
      }
      if (
        sc.invariants !== undefined &&
        (!Array.isArray(sc.invariants) || sc.invariants.some((v) => typeof v !== "string"))
      ) {
        return c.json({ error: "securityConfig.invariants must be a list of strings." }, 400);
      }
      if (
        sc.categories !== undefined &&
        (!Array.isArray(sc.categories) || sc.categories.some((v) => typeof v !== "string"))
      ) {
        return c.json({ error: "securityConfig.categories must be a list of strings." }, 400);
      }
      if (sc.scope !== undefined && sc.scope !== null) {
        const scope = sc.scope as {
          hosts?: unknown;
          cidrs?: unknown;
          loginUrl?: unknown;
          signupUrl?: unknown;
          rateLimitRps?: unknown;
        };
        if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
          return c.json({ error: "securityConfig.scope must be an object with hosts, or null." }, 400);
        }
        if (
          !Array.isArray(scope.hosts) ||
          scope.hosts.length === 0 ||
          !scope.hosts.every((h): h is string => typeof h === "string" && h.trim().length > 0)
        ) {
          return c.json({ error: "securityConfig.scope.hosts must be a non-empty list of strings." }, 400);
        }
        if (scope.cidrs !== undefined) {
          if (
            !Array.isArray(scope.cidrs) ||
            !scope.cidrs.every((c): c is string => typeof c === "string" && c.trim().length > 0)
          ) {
            return c.json({ error: "securityConfig.scope.cidrs must be a list of non-empty CIDR strings." }, 400);
          }
        }
        if (scope.loginUrl !== undefined && (typeof scope.loginUrl !== "string" || scope.loginUrl.trim() === "")) {
          return c.json({ error: "securityConfig.scope.loginUrl must be a non-empty URL string." }, 400);
        }
        if (scope.signupUrl !== undefined && (typeof scope.signupUrl !== "string" || scope.signupUrl.trim() === "")) {
          return c.json({ error: "securityConfig.scope.signupUrl must be a non-empty URL string." }, 400);
        }
        if (scope.rateLimitRps !== undefined) {
          const r = scope.rateLimitRps;
          if (typeof r !== "number" || !Number.isInteger(r) || r < 1 || r > 1000) {
            return c.json({ error: "securityConfig.scope.rateLimitRps must be an integer 1..1000." }, 400);
          }
        }
      }
    }
    if (body.planCells !== undefined && (!Array.isArray(body.planCells) || body.planCells.length === 0)) {
      return c.json({ error: "planCells must be a non-empty list of plan steps, or omit the field." }, 400);
    }
    if (body.includeReport !== undefined && typeof body.includeReport !== "boolean") {
      return c.json({ error: "includeReport must be a boolean, or omit the field." }, 400);
    }
  }

  // A model, when present, is a non-empty string id from the catalog. Rejected
  // here so a mistyped model is a bad request, not a silently ignored field.
  if (body.model !== undefined && (typeof body.model !== "string" || body.model.length === 0)) {
    return c.json(
      { error: "model must be a non-empty string. Send a model id from GET /api/models." },
      400,
    );
  }
  // A user-supplied model is held to the org's approved-models list, same as
  // PATCH /api/sessions/:id. The server-picked security default below is
  // exempt — it never came from the caller, so there is nothing to gate.
  if (body.model !== undefined) {
    const isAdmin = await isOrgAdminUser(c);
    const err = await assertModelSelectable(db, user.orgId, isAdmin, body.model);
    if (err) return c.json({ error: err }, 400);
  }
  // The session-default model. A security session with no explicit model uses
  // a capable default instead of the haiku floor `resolveModelForBuild` would
  // otherwise reach. A code session with no model keeps normal resolution
  // (undefined → user default → owning team's default → org preferred →
  // hardcoded default).
  const effectiveModel = body.model ?? (kind === "security" ? SECURITY_DEFAULT_MODEL : undefined);

  // Cookie (and stub) callers may send `teamId` when they are a live
  // member. A personal `vlt_` key cannot. A team key always creates as
  // that team — see `resolveCreateOwner`.
  const principal = requirePrincipal(c);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const createdOwner = await resolveCreateOwner({
    principal,
    authVia: c.var.authVia,
    bodyTeamId: body.teamId,
    userId: user.id,
    isTeamMember: (teamId) => isTeamMember(db, teamId, user.id),
  });
  if (!createdOwner.ok) return c.json({ error: createdOwner.error }, createdOwner.status);
  const owner: Principal = createdOwner.owner;

  const parsedRepos = parseRepoBindings(body);
  if ("error" in parsedRepos) {
    return c.json({ error: parsedRepos.error }, 400);
  }
  let { repos } = parsedRepos;

  // Re-scan / iterate: `rescanOf` names a prior security SESSION this review
  // re-scans. Resolve its engagement, reuse the repo binding and the plan, and
  // link the new engagement to it. The request wins on any explicit override
  // (repo, preset, paths, model). Validated here, before anything is written.
  let rescanParentEngagementId: string | undefined;
  let rescanPlanYaml: string | undefined;
  if (body.rescanOf !== undefined) {
    if (kind !== "security") {
      return c.json({ error: "rescanOf only applies to a security session. Send kind 'security'." }, 400);
    }
    if (typeof body.rescanOf !== "string" || body.rescanOf === "") {
      return c.json({ error: "rescanOf must be a prior security session id." }, 400);
    }
    const priorRows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, body.rescanOf))
      .limit(1);
    const prior = priorRows[0];
    // Existence-hiding: an unknown id, a session the caller cannot view, or a
    // non-security session all answer the same 404.
    if (!prior || prior.kind !== "security" || !(await canViewSession(db, prior, c.var.principal))) {
      return c.json({ error: "The prior review was not found, or you cannot view it." }, 404);
    }
    const priorSecurity = createSecurityEngagementService({ db });
    const priorEngagement = await priorSecurity.getEngagementBySession(body.rescanOf);
    if (!priorEngagement) {
      return c.json({ error: "The prior session has no security engagement to re-scan." }, 404);
    }
    rescanParentEngagementId = priorEngagement.engagement.id;
    // Re-scan v2: seed the plan from `rescanPlan(presetId)` — recon → reconcile
    // → the diff-scoped sweeps → verify → report. The reconcile pass re-checks
    // the carried findings; the sweeps find what the changed code introduced.
    // This replaces reusing the parent's flat plan, which had no reconcile cell.
    // The re-scan naturally picks up new commits: sec_start resolves the LATEST
    // default-branch SHA and scopes the sweeps to the diff.
    if (body.planCells === undefined) {
      rescanPlanYaml = rescanPlan(presetId);
    }
    // Reuse the prior repo binding unless the request supplies its own.
    if (repos.length === 0) {
      repos = await getSessionRepos(db, body.rescanOf);
    }
  }

  // An engagement reviews one repo at one pinned SHA (spec §Vocabulary), so
  // a security session must arrive with a binding — there is nothing to
  // review without one.
  if (kind === "security" && repos.length === 0) {
    return c.json({ error: "A security review needs a repository. Pick one when you start the review." }, 400);
  }

  const verifiedRepos: RepoBinding[] = [];
  const checkedRepos: RepoBinding[] = [];
  const tokenDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
  for (const repo of repos) {
    const result = await checkRepoExistence(tokenDeps, {
      orgId: user.orgId, userId: user.id, host: repo.host ?? "github",
      fullName: repo.fullName, auth: repo.auth,
    });
    if (result.kind === "not-found") return c.json({ error: result.error }, 400);
    const binding = result.kind === "found"
      ? { ...repo, fullName: result.fullName, cloneUrl: result.cloneUrl }
      : repo;
    checkedRepos.push(binding);
    if (result.kind === "found") verifiedRepos.push(binding);
  }
  repos = checkedRepos;

  // Auto-create the workspace dir if it doesn't exist; reject if the path
  // exists but is a file (Docker bind-mount needs a directory).
  try {
    const st = await stat(body.workspace);
    if (!st.isDirectory()) {
      return c.json({ error: `workspace exists but is not a directory: ${body.workspace}` }, 400);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return c.json({ error: `cannot access workspace: ${(err as Error).message}` }, 400);
    }
    try {
      await mkdir(body.workspace, { recursive: true });
    } catch (mkErr) {
      return c.json({ error: `cannot create workspace: ${(mkErr as Error).message}` }, 400);
    }
  }

  // Dynamic config (M-F1) + setup-page overrides (`/security/new`): a security
  // review reads the repo's `.valet/security.yml` through the GitHub contents
  // API BEFORE the sandbox exists, and seeds its config + plan from it (or the
  // preset fallback). `seedSecurityReview` owns that seeding — the same function
  // the preview endpoint calls, so a preview shows exactly what create seeds.
  //
  // When the setup page sends `planCells`, that edited plan wins over the seed;
  // when it sends `securityConfig`, those focus / invariants / categories
  // override the seed. The repo-committed tools / scope / personas always come
  // from the seed — the user does not edit those. A re-scan that reuses the
  // prior plan skips the plan seed but still resolves the repo config context.
  let securityPlan =
    kind === "security"
      ? presetPlan(presetId, {
          ...(body.paths ? { paths: body.paths } : {}),
          ...(body.includeReport !== undefined ? { includeReport: body.includeReport } : {}),
        })
      : "";
  let engagementConfig: SecurityConfigContext | undefined;
  let engagementHasRepoConfig = false;
  if (kind === "security") {
    const [owner, repo] = repos[0].fullName.split("/");
    if (owner && repo) {
      const tokenDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
      const seeded = await seedSecurityReview({
        owner,
        repo,
        ...(repos[0].ref ? { ref: repos[0].ref } : {}),
        presetId,
        ...(body.paths ? { paths: body.paths } : {}),
        ...(body.includeReport !== undefined ? { includeReport: body.includeReport } : {}),
        tokenDeps,
        orgId: user.orgId,
      });
      engagementHasRepoConfig = seeded.hasRepoConfig;

      // The plan: the re-scan v2 plan (recon → reconcile → sweeps → verify →
      // report), the setup page's edited plan, or the seeded plan (config steps
      // / preset). The edited plan is validated through the same path
      // `/plan/cells` uses.
      if (rescanPlanYaml !== undefined) {
        securityPlan = rescanPlanYaml;
      } else if (body.planCells !== undefined) {
        try {
          const cells = body.planCells.map((raw, i) => planCellInputToCell(raw, i + 1));
          const personaKeys = seeded.personas ? Object.keys(seeded.personas) : [];
          // Validate against the bundled ids ∪ the repo-declared personas, so a
          // config persona in an edited step stays valid.
          parsePlan(serializePlan(cells), [...bundledPersonaIds(), ...personaKeys]);
          securityPlan = serializePlan(cells);
        } catch (err) {
          if (err instanceof PlanCellInputError) return c.json({ error: err.message }, 400);
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      } else {
        securityPlan = seeded.planYaml;
      }

      // Translate the wire's scope (camelCase per JSON convention) to the
      // plugin's SecurityScope (snake_case per .valet/security.yml convention)
      // before passing through seededConfigContext.
      const wireScope = body.securityConfig?.scope;
      const overrides = body.securityConfig
        ? {
            ...(("focus" in body.securityConfig) ? { focus: body.securityConfig.focus ?? null } : {}),
            ...(body.securityConfig.invariants !== undefined ? { invariants: body.securityConfig.invariants } : {}),
            ...(body.securityConfig.categories !== undefined ? { categories: body.securityConfig.categories } : {}),
            ...(("scope" in body.securityConfig)
              ? {
                  scope:
                    wireScope === null || wireScope === undefined
                      ? null
                      : {
                          hosts: wireScope.hosts,
                          ...(wireScope.cidrs ? { cidrs: wireScope.cidrs } : {}),
                          ...(wireScope.loginUrl ? { login_url: wireScope.loginUrl } : {}),
                          ...(wireScope.signupUrl ? { signup_url: wireScope.signupUrl } : {}),
                          ...(wireScope.rateLimitRps !== undefined ? { rate_limit_rps: wireScope.rateLimitRps } : {}),
                        },
                }
              : {}),
          }
        : undefined;
      engagementConfig = seededConfigContext(seeded, overrides);
    }
  }

  // A security session names its target so the list reads at a glance (#7).
  // The user's explicit title always wins; otherwise derive one from the repo
  // and ref: "Security review · owner/repo@ref". Omit "@ref" for the default
  // branch (null/empty ref). A 40-hex SHA shortens to 7 chars. The whole title
  // stays within the 80-char column and reads well in a narrow list.
  const sessionTitle =
    body.title ??
    (kind === "security" ? securitySessionTitle(repos[0].fullName, repos[0].ref) : null);

  const now = Date.now();
  const id = newId("s");
  // Session row + repo bindings must land atomically — a failure between
  // the two statements would otherwise leave an orphaned agentSessions row
  // with no bindings (review finding on commit d0de1af3).
  let created: typeof agentSessions.$inferSelect | undefined;
  // The seeded engagement id, captured from the create transaction so the
  // setup-page path can materialize its cells right after commit.
  let securityEngagementId: string | undefined;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(agentSessions)
      .values({
        id,
        userId: user.id,
        orgId: user.orgId,
        workspace: body.workspace,
        title: sessionTitle,
        status: "active",
        ownerType: owner.type,
        ownerId: owner.id,
        // A new team session resolves credentials as the team (team
        // credentials design, deviation 13).
        credentialOwnerMode: "owner",
        profile,
        docker,
        kind,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      // Returned rather than re-read: the `initialPrompt` submit below needs
      // the full row to assemble the session meta.
      .returning();
    created = inserted[0];

    if (repos.length > 0) {
      // Compute target dirs once at bind time (spec decision 15): each binding
      // gets a persistent subdirectory name derived from its repo name. This
      // value is stored on the row so later loads never recompute (and
      // convergence never relocates an existing clone).
      const targetDirs = computeTargetDirs(repos);
      await tx.insert(sessionRepos).values(
        repos.map((repo, position) => ({
          sessionId: id,
          host: repo.host ?? "github",
          fullName: repo.fullName,
          cloneUrl: repo.cloneUrl,
          ref: repo.ref ?? null,
          auth: repo.auth ?? "auto",
          position,
          targetDir: targetDirs[position] ?? null,
        })),
      );
    }

    // A security session is an engagement runner: seed its engagement in
    // the SAME transaction, so no security session ever exists without one
    // (the security routes and tools resolve session → engagement). The final
    // config + plan arrive from the setup page (`/security/new`); `seedSecurityReview`
    // resolved the repo-committed context above.
    if (kind === "security") {
      const security = createSecurityEngagementService({ db });
      const engagement = await security.createEngagement(
        {
          sessionId: id,
          repoFullName: repos[0].fullName,
          // The plan comes from (in order): the re-scan v2 plan on a re-scan, the
          // setup page's edited `planCells`, the repo's `.valet/security.yml`
          // steps, or the request's preset + paths. `securityPlan` resolved all
          // four above.
          plan: securityPlan,
          ...(rescanParentEngagementId ? { parentEngagementId: rescanParentEngagementId } : {}),
          ...(engagementConfig ? { config: engagementConfig } : {}),
          // `has_repo_config` is the seed's flag, not "did a config context
          // exist": a preset review with a user-edited focus carries a config
          // context but no repo config seeded it.
          hasRepoConfig: engagementHasRepoConfig,
        },
        tx,
      );
      securityEngagementId = engagement.id;
    }
  });

  // Zero-config generation (spec decision 13): after the bindings land,
  // upsert each verified repo's image source + touch its `last_bound_at` and kick a
  // first bake in the background. Fire-and-forget — session create never
  // waits on a bake, and `ensureRepoSource` never throws.
  for (const repo of verifiedRepos) {
    void prebuildService.ensureRepoSource(user.orgId, {
      host: repo.host ?? "github",
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
    });
  }

  // Setup-page start (`/security/new`): when the request carries the final
  // edited plan, the user already reviewed the config + plan and clicked "Start
  // review" — that click IS the spend approval the old on-session sec_start gate
  // asked for. So materialize the cells now instead of leaving the engagement in
  // an editable planning state waiting on the runner. Resolve the binding's ref
  // to a commit SHA the same way the sec_start tool does, then `startEngagement`.
  // Best-effort: a SHA-resolution failure logs and leaves the engagement
  // planning — the runner's kickoff below can still start it. A re-scan keeps
  // the runner-driven start (it diffs against the parent at sec_start).
  // Whether the engagement is already running when the kickoff turn queues.
  // On the setup-page path the create route starts it here, so the runner must
  // not call sec_start (that route 409s a running engagement and the approval
  // gate is redundant). A start failure leaves this false and the runner starts
  // the engagement itself through sec_start.
  let securityAlreadyStarted = false;
  if (
    kind === "security" &&
    body.planCells !== undefined &&
    rescanParentEngagementId === undefined &&
    securityEngagementId
  ) {
    const [owner, repo] = repos[0].fullName.split("/");
    if (owner && repo) {
      try {
        // An already-pinned 40-hex ref needs no GitHub lookup — the engagement
        // is deterministic offline (mirrors the start-preview route).
        const ref = repos[0].ref;
        let resolvedSha: string;
        if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
          resolvedSha = ref.toLowerCase();
        } else {
          const tokenDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
          const token = await resolveApiTokenOrNull(tokenDeps, user.orgId, owner, repo);
          resolvedSha = (await resolveRefSha(tokenDeps, token, owner, repo, ref)).toLowerCase();
        }
        const security = createSecurityEngagementService({ db });
        await security.startEngagement(securityEngagementId, { resolvedSha });
        securityAlreadyStarted = true;
      } catch (err) {
        console.warn(
          `security create: could not start engagement ${securityEngagementId} for ${repos[0].fullName} at create; ` +
            `the runner can start it. Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // `initialPrompt` (wire `CreateSessionRequest`): queue the first turn once
  // the row and its repo bindings are durable, through the same submit path
  // `POST /api/sessions/:id/messages` uses. The prompt goes to the session's
  // default thread — a session one statement old has no other.
  //
  // An enqueue failure does NOT fail the create. The session row exists and
  // the response carries its id, so answering 500 here would leave the caller
  // believing nothing was created while an orphan row stayed behind. The
  // caller sees `runState: "idle"` instead of "working" and can send the
  // prompt again through the messages route; the server logs the cause.
  // A security session is an engagement runner, not a chat: it must start
  // working the moment it is created, so it always gets a kickoff turn even
  // when the user left the focus box empty. The user's optional prompt folds
  // in as focus notes. A code session only runs when the user sends a prompt.
  // Persist the chosen model BEFORE the kickoff turn so the first turn runs on
  // it, not the haiku floor. `setModel` is the same durable path PATCH uses:
  // it saves `SessionData.model`, so `resolveModelForBuild` returns it on this
  // build and every rebuild after eviction. The kickoff below reuses the cached
  // session this materializes. Best-effort like the kickoff: a failure logs and
  // does not fail the create — the row and engagement are already durable, and
  // the model can be re-set through PATCH.
  if (effectiveModel && created) {
    const { engineHost } = c.var.providers;
    try {
      const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, created));
      await engineSession.setModel(effectiveModel);
    } catch (err) {
      console.error(`session ${id}: set default model ${effectiveModel} failed:`, err);
    }
  }

  const firstPrompt =
    kind === "security"
      ? securityKickoffPrompt(repos[0].fullName, {
          ...(body.initialPrompt ? { focusNotes: body.initialPrompt } : {}),
          alreadyStarted: securityAlreadyStarted,
        })
      : body.initialPrompt;
  let queuedPrompt = false;
  if (firstPrompt && created) {
    try {
      queuedPrompt =
        (await submitSessionPrompt(c.var.providers, created, firstPrompt, {
          author: promptAuthorFromUser(c.var.user),
        })) !== null;
    } catch (err) {
      console.error(`session ${id}: initialPrompt enqueue failed:`, err);
    }
  }
  // A session this new has no queue history, so the only submission it can
  // hold is the one just enqueued.
  const unsettled = queuedPrompt ? await engineStore.listUnsettledSubmissions(id) : [];

  const detail: CreateSessionResponse = {
    id,
    workspace: body.workspace,
    status: "active",
    kind,
    ...deriveRunFields({ status: "active", updatedAt: now, lastActivityAt: now }, unsettled),
    ...(sessionTitle !== null ? { title: sessionTitle } : {}),
    owner,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    profile,
    docker,
    ...(repos.length > 0 ? { repos } : {}),
  };
  return c.json(detail, 201);
});

// ── Get ───────────────────────────────────────────────────────────────────

sessionsRouter.get("/:id", async (c) => {
  const { db, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  // View access, not just direct ownership — a team's orchestrator session
  // is readable by any member (see `services/session-access.ts`); every
  // other session route in this file stays direct-owner-only.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, c.var.principal))) {
    return c.json({ error: "session not found" }, 404);
  }

  const [{ n }] = await db
    .select({ n: count() })
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, id));

  // Surface the engine's session-default model + reasoning level. This is
  // best-effort: if the engine session hasn't been materialized yet we just
  // omit the fields rather than spinning up a sandbox to read them.
  const { engineHost } = c.var.providers;
  let model: string | undefined;
  let reasoning: string | null | undefined;
  if (engineHost.isLive(id)) {
    const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    // The canonical spec, not the wire id (`modelSpec` differs whenever the
    // resolver returned a wire-ready model for a namespaced spec).
    model = engineSession.options.modelSpec ?? engineSession.options.model.id;
    reasoning = engineSession.options.sampling?.reasoning ?? null;
  }

  const repos = await getSessionRepos(db, id);
  // One session, so one submission read — the same derivation the list uses.
  const unsettled = await engineStore.listUnsettledSubmissions(id);

  const detail: GetSessionResponse = {
    isWorkspaceRuntime: (await loadAssistantBySessionId(db, id)) !== undefined,
    ...rowToSummary(row, deriveRunFields(runStateRow(row), unsettled)),
    parentWork: await visibleWorkOrigin(db, row),
    messageCount: Number(n ?? 0),
    model,
    reasoning,
    profile: row.profile,
    docker: row.docker,
    ...(repos.length > 0 ? { repos } : {}),
  };
  return c.json(detail);
});

// ── Patch (`model`, `title`, and/or `profile`) ───────────────────────────

/** Upper bound on a hand-typed session name. The auto-titler caps itself at
 * 60 characters. A person renaming a session sometimes wants more room, so
 * the manual limit is larger, but it stays bounded: the header and the
 * session lists render this string. */
const MAX_SESSION_TITLE_CHARS = 200;

/** The profile row is written before the sandbox is replaced, so a failed
 * replacement leaves a saved setting and a stale sandbox. Say both, and name
 * the one action that finishes the job. */
function profileSavedButSandboxFailed(reason: string): string {
  return `Profile saved, but the sandbox did not restart (${reason}). Use "Replace sandbox" in the session menu to apply it.`;
}

sessionsRouter.patch("/:id", async (c) => {
  const { db, engineHost, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  // Administer access, not direct ownership: on a team-owned session the
  // team's admins choose the model, not whichever member opened the
  // assistant first (see `services/session-access.ts`). The row loads
  // without an ownership filter so the check can run in application code;
  // an unauthorized caller still gets the same 404 a missing id gets.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canAdministerSession(db, row, c.var.principal))) {
    return c.json({ error: "session not found" }, 404);
  }

  let body: PatchSessionRequest;
  try {
    body = (await c.req.json()) as PatchSessionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const wantsModel = body.model !== undefined;
  const wantsTitle = body.title !== undefined;
  const wantsProfile = body.profile !== undefined;
  const wantsOwner = body.teamId !== undefined;
  const wantsReasoning = body.reasoning !== undefined;
  // A body with no field at all keeps the message this guard has always
  // sent. The model picker is still the only caller that can omit a field
  // by accident, and a contract test pins this exact response.
  if (!wantsModel && !wantsTitle && !wantsProfile && !wantsOwner && !wantsReasoning) {
    return c.json({ error: "model is required" }, 400);
  }
  if (wantsModel && (typeof body.model !== "string" || body.model.length === 0)) {
    return c.json({ error: "model must be a non-empty string. Send a model id from GET /api/models." }, 400);
  }
  if (wantsModel) {
    const isAdmin = await isOrgAdminUser(c);
    const err = await assertModelSelectable(db, row.orgId, isAdmin, body.model as string);
    if (err) return c.json({ error: err }, 400);
  }
  // `reasoning: null` clears the override and always passes.
  if (wantsReasoning && body.reasoning !== null) {
    if (typeof body.reasoning !== "string") {
      return c.json(
        { error: "reasoning must be a reasoning level string, or null to clear the override." },
        400,
      );
    }
    const normalizedReasoning = body.reasoning.trim().toLowerCase();
    const reasoningErr = await assertReasoningSelectable(db, row.orgId, normalizedReasoning);
    if (reasoningErr) return c.json({ error: reasoningErr }, 400);
  }

  let nextTitle: string | undefined;
  if (wantsTitle) {
    if (typeof body.title !== "string") {
      return c.json({ error: "title must be a string. Send the new session name." }, 400);
    }
    nextTitle = body.title.trim();
    if (nextTitle.length === 0) {
      return c.json({ error: "title cannot be empty. Send a name with at least one character." }, 400);
    }
    if (nextTitle.length > MAX_SESSION_TITLE_CHARS) {
      return c.json(
        { error: `title is too long. Use ${MAX_SESSION_TITLE_CHARS} characters or fewer.` },
        400,
      );
    }
  }

  // A profile change recreates the sandbox, so it is refused mid-turn for
  // the same reason `POST /:id/sandbox/replace` is: the running turn would
  // lose the sandbox under it. An unchanged value is not a change and needs
  // no guard.
  let nextProfile: SandboxProfile | undefined;
  if (wantsProfile) {
    if (body.profile !== "headless" && body.profile !== "full") {
      return c.json({ error: "profile must be 'headless' or 'full'." }, 400);
    }
    if (body.profile !== row.profile) nextProfile = body.profile;
  }
  // Owner move (team-workspace-ui design, decision 5): a team id moves the
  // session to that team, `null` to the CALLER's own workspace — on a
  // team-owned session the mover is a team or org admin, and taking a
  // session personal makes it theirs. Validated like the create route:
  // membership of the target team, 404 for a non-member or unknown id.
  let nextOwner: Principal | undefined;
  if (wantsOwner) {
    if (requirePrincipal(c)?.type === "team") {
      return c.json(
        { error: "A team API key cannot move a session. Sign in to the team workspace." },
        403,
      );
    }
    if (body.teamId !== null && (typeof body.teamId !== "string" || body.teamId.length === 0)) {
      return c.json(
        { error: "teamId must be a team id, or null to move the session to your own workspace." },
        400,
      );
    }
    // An assistant's session is ADDRESSED by its owner (`assistant:{id}`):
    // the assistants table, the rail, and orchestrator resolution all answer
    // from that owner. Moving only the session row desyncs them — every
    // teammate keeps seeing the assistant but 404s opening it. The web UI
    // hides the action; the API is the contract, so it refuses too.
    // Both tests on purpose: the column lookup covers migrated rows with
    // legacy `orchestrator:*` session ids, and the prefix keeps refusing an
    // `assistant:` id even when its row is gone — the address stays
    // structural either way.
    if (
      parseAssistantSessionId(id) !== null ||
      (await loadAssistantBySessionId(db, id)) !== undefined
    ) {
      return c.json(
        { error: "an assistant's session cannot be moved. It belongs to the assistant's owner." },
        400,
      );
    }
    // A child session is listed nowhere on its own — it nests under the
    // parent via child_watches, which a move does not touch. Moving one
    // strands it: gone from every workspace list, still nested under the
    // OLD owner's chat.
    const watch = await db
      .select({ childSessionId: childWatches.childSessionId })
      .from(childWatches)
      .where(eq(childWatches.childSessionId, id))
      .limit(1);
    if (watch.length > 0) {
      return c.json(
        { error: "a child session follows its parent and cannot be moved." },
        400,
      );
    }
    if (typeof body.teamId === "string") {
      if (!(await isTeamMember(db, body.teamId, userId))) {
        return c.json({ error: "team not found" }, 404);
      }
      nextOwner = { type: "team", id: body.teamId };
    } else {
      nextOwner = { type: "user", id: userId };
    }
    // An unchanged owner is not a change — no eviction, no mid-turn refusal.
    if (nextOwner.type === row.ownerType && nextOwner.id === row.ownerId) {
      nextOwner = undefined;
    }
  }
  // One busy gate for both mutation kinds: a profile change replaces the
  // sandbox, an owner move evicts the cached engine session (skills and
  // credential context bind to the owner at build) — neither may land under
  // a running turn.
  if (nextProfile !== undefined || nextOwner !== undefined) {
    const busy = await engineStore.listUnsettledSubmissions(id);
    if (busy.length > 0) {
      return c.json(
        { error: "a turn is running. Wait for it to finish, then retry the change." },
        409,
      );
    }
  }

  // Materialize the engine session only when the model or reasoning
  // changes. A rename must not start a sandbox — the header renames
  // hibernated sessions too.
  let model: string | undefined;
  let reasoning: string | null | undefined;
  if ((wantsModel && typeof body.model === "string") || wantsReasoning) {
    const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    if (wantsModel && typeof body.model === "string") {
      try {
        await engineSession.setModel(body.model);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    if (wantsReasoning) {
      try {
        await engineSession.setReasoning(
          typeof body.reasoning === "string" ? body.reasoning.trim().toLowerCase() : null,
        );
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    model = engineSession.options.modelSpec ?? engineSession.options.model.id;
    reasoning = engineSession.options.sampling?.reasoning ?? null;
  } else if (engineHost.isLive(id)) {
    // Report the model/reasoning the GET route would report. Same
    // best-effort rule: do not wake a session to read it.
    const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    model = engineSession.options.modelSpec ?? engineSession.options.model.id;
    reasoning = engineSession.options.sampling?.reasoning ?? null;
  }

  // A live session froze its profile into `SandboxCreateOpts` when it was
  // built, and the attachment reuses that object on every re-provision. So
  // read whether a sandbox exists BEFORE the cache entry goes away: that
  // answers whether a running container has to be replaced, or whether the
  // next provision picks the new profile up on its own.
  let hadSandbox = false;
  if (nextProfile !== undefined && engineHost.isLive(id)) {
    const live = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    hadSandbox = live.attachment.current() !== null;
  }

  // The writes land after every validation, so a rejected model never
  // leaves a half-applied patch behind.
  let effectiveRow = row;
  if (nextTitle !== undefined || nextProfile !== undefined || nextOwner !== undefined) {
    const now = Date.now();
    // A personal move also re-stamps `userId`: `canViewSession` and
    // `canAdministerSession` key user-owned rows off that column, so leaving
    // the original creator there would hand the session to somebody who no
    // longer owns it and lock out the mover. A team move leaves it alone —
    // on team rows the column only records the first actor.
    const ownerCols =
      nextOwner !== undefined
        ? {
            ownerType: nextOwner.type,
            ownerId: nextOwner.id,
            ...(nextOwner.type === "user" ? { userId: nextOwner.id } : {}),
          }
        : {};
    await db
      .update(agentSessions)
      .set({
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(nextProfile !== undefined ? { profile: nextProfile } : {}),
        ...ownerCols,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, id));
    effectiveRow = {
      ...row,
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(nextProfile !== undefined ? { profile: nextProfile } : {}),
      ...ownerCols,
      updatedAt: now,
    };
  }

  // Drop the cached session so the next build reads the new row: the
  // profile is frozen into the sandbox opts, and the owner binds the skills
  // provider and credential context.
  if (nextOwner !== undefined || nextProfile !== undefined) {
    engineHost.evictCache(id);
  }

  if (nextProfile !== undefined) {
    if (hadSandbox) {
      // The old container still runs the old profile. Rebuild from the
      // updated row, then replace the sandbox so the change is live now
      // rather than at some later re-provision.
      const rebuilt = await engineHost.sessionFor(id, await loadSessionMeta(db, effectiveRow));
      // Re-check right before the replacement. A submission admitted while
      // the rebuild ran wins, the same TOCTOU rule `POST /:id/sandbox/replace`
      // applies. The row already carries the new profile, so say so.
      const recheck = await engineStore.listUnsettledSubmissions(id);
      if (recheck.length > 0) {
        return c.json({ error: profileSavedButSandboxFailed("a turn started") }, 409);
      }
      try {
        await rebuilt.attachment.replace();
      } catch (err) {
        return c.json({ error: profileSavedButSandboxFailed((err as Error).message) }, 502);
      }
      if (rebuilt.attachment.state !== "ready") {
        return c.json({ error: profileSavedButSandboxFailed("the new sandbox never became ready") }, 502);
      }
    }
  }

  const [{ n }] = await db
    .select({ n: count() })
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, id));
  const unsettled = await engineStore.listUnsettledSubmissions(id);
  const detail: GetSessionResponse = {
    isWorkspaceRuntime: (await loadAssistantBySessionId(db, id)) !== undefined,
    ...rowToSummary(effectiveRow, deriveRunFields(runStateRow(effectiveRow), unsettled)),
    parentWork: await visibleWorkOrigin(db, effectiveRow),
    messageCount: Number(n ?? 0),
    model,
    reasoning,
    profile: effectiveRow.profile,
    docker: effectiveRow.docker,
  };
  return c.json(detail);
});

// ── Auto-title ────────────────────────────────────────────────────────────

/**
 * Generate + persist a title for this session (and optionally a thread)
 * from the opening messages. The server normally starts naming from the
 * completed-submission event; this route remains an idempotent retry seam.
 * Returns 200 with `{ sessionTitle, threadTitle }` even in the "nothing to
 * do" cases (`already_titled`, `no_messages`) — the client just treats
 * null title fields as "leave the row alone".
 */
sessionsRouter.post("/:id/auto-title", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const url = new URL(c.req.url);
  const threadId = url.searchParams.get("threadId") ?? undefined;

  // The persistent `messages` table isn't the source of truth today — the
  // engine owns entries. Route the loader through the same engine session
  // the messages GET endpoint uses so we see what the UI sees.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const sessionRow = rows[0];
  // Session-not-found is handled inside `autoTitle` too, but bail early
  // here so we don't pay the cost of a sessionFor call on a bad id.
  if (!sessionRow) return c.json({ error: "session not found" }, 404);
  // Titling a thread is part of prompting, not administering — anyone who
  // can read and reply may title what they said. Gating this on ownership
  // left a team member's threads permanently untitled.
  if (!(await canViewSession(db, sessionRow, c.var.principal))) {
    return c.json({ error: "session not found" }, 404);
  }

  const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, sessionRow));
  const defaultThread = await engineSession.ensureDefaultThread();

  const result = await autoTitle(
    {
      db,
      loadMessages: async (_sid, tid) => {
        const thread = tid ? engineSession.threadById(tid) ?? defaultThread : defaultThread;
        const entries = await thread.readEntries({ limit: 4 });
        const out: { role: string; content: string }[] = [];
        for (const e of entries) {
          if (e.type !== "message") continue;
          if (e.role !== "user" && e.role !== "assistant") continue;
          out.push({ role: e.role, content: e.content ?? "" });
        }
        return out;
      },
    },
    { sessionId: id, threadId },
  );
  if (!result.ok) {
    if (result.reason === "session_not_found") return c.json({ error: "session not found" }, 404);
    // already_titled / no_messages → 200 with nulls; client no-ops.
    return c.json({ sessionTitle: null, threadTitle: null });
  }
  return c.json({ sessionTitle: result.sessionTitle, threadTitle: result.threadTitle });
});

// ── Sandbox JWT ───────────────────────────────────────────────────────────

// Mints a short-lived service JWT the session's sandbox uses to call back
// into the API (Task 8, auth-v2 plan). Direct-owner-gated
// (`isSessionDirectOwner`) — unknown or not-owned ids 404. A team key owns
// its team's sessions but is refused here: the token binds one user, and
// the only user on a team key is the creating admin, for audit.
sessionsRouter.post("/:id/sandbox-jwt", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const caller = c.var.principal;

  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await isSessionDirectOwner(db, row, caller))) return c.json({ error: "session not found" }, 404);
  if (caller.type === "team") {
    return c.json(
      { error: "A team API key cannot mint a sandbox credential. Use a personal API key or the web app." },
      403,
    );
  }

  const { token, expiresAt } = engineHost.mintSandboxJwtFor(id, caller.id);
  const body: SandboxJwtResponse = { token, expiresAt };
  return c.json(body);
});

// ── Pause (manual hibernation) ───────────────────────────────────────────

// Sandbox hibernation plan, Task 4: suspends the session's sandbox on
// demand (as opposed to the idle sweep's automatic suspend) and stamps the
// row `"hibernated"`. Administer-gated (`canAdministerSession`) — unknown
// ids, and ids the caller may not administer, both 404. Refuses (409) when
// a turn is running/gated (nothing to safely suspend mid-turn) or when the
// sandbox provider doesn't support hibernation at all. There is no explicit
// resume route (spec decision 4) — the next submission, a gateway touch, or
// a future wake all resume it and clear the status back to `"active"`
// (`EngineHost`'s `onWake`/`onSessionReady` hooks, wired in
// `providers/node.ts` and `integration/_setup.ts`).
sessionsRouter.post("/:id/pause", async (c) => {
  const { db, engineHost, engineStore, sandboxProvider } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  // Status guard #1: the lookup itself requires `active` — an
  // archived/deleted session 404s exactly like a missing one, rather than
  // passing the authorization check and getting resurrected by the status
  // write below (`listStandaloneSessions` treats `hibernated` as visible).
  // Ownership is NOT in this query: `canAdministerSession` answers it in
  // application code, because a team-owned session's `user_id` names the
  // member who opened it first, not the members who may pause it.
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row || !(await canAdministerSession(db, row, c.var.principal))) {
    return c.json({ error: "session not found" }, 404);
  }

  if (!sandboxProvider.capabilities().hibernation) {
    return c.json({ error: "provider does not support hibernation" }, 409);
  }

  // ANY unsettled submission blocks — not just running/gated — matching the
  // idle sweep's own (stricter) `listUnsettledSubmissions.length > 0` check
  // in `maybeSuspendIdleSession` (`EngineHost`). A merely-queued item would
  // otherwise get orphaned by a pause that suspends the sandbox out from
  // under it before it's ever claimed.
  const unsettled = await engineStore.listUnsettledSubmissions(id);
  if (unsettled.length > 0) {
    return c.json({ error: "a turn is running" }, 409);
  }

  const session = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
  await session.attachment.suspend();

  // `suspend()` silently no-ops unless the attachment was `ready` — only
  // stamp the row `hibernated` when it actually transitioned, so a pause hit
  // mid-provision doesn't lie about having suspended anything.
  if (session.attachment.state !== "suspended") {
    return c.json({ error: "sandbox is not ready to pause" }, 409);
  }

  // Status guard #2: conditioned `WHERE status='active'` (shared with the
  // engine's own hibernation hook — see `writeHibernated`) so a concurrent
  // archive/delete between the lookup above and this write still can't be
  // resurrected. The sandbox handle rides along for the reaper.
  await writeHibernated(db, id, session.attachment.sandboxId);

  const body: PauseSessionResponse = { status: "hibernated" };
  return c.json(body, 200);
});

// ── Replace sandbox ───────────────────────────────────────────────────────

/** POST /:id/sandbox/replace — tear down the session's sandbox and
 * re-provision a fresh one. Threads and history are untouched; prep steps
 * re-apply on the new sandbox. Same busy rule as pause: ANY unsettled
 * submission blocks, so a queued turn is never orphaned mid-replace.
 * Direct-owner-gated like `sandbox-jwt`, and a team key is refused the
 * same way: it owns its team's rows, but rebuilding a live sandbox is a
 * person's act on the session, not a key's. */
sessionsRouter.post("/:id/sandbox/replace", async (c) => {
  const { db, engineHost, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const caller = c.var.principal;

  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row || !(await isSessionDirectOwner(db, row, caller))) return c.json({ error: "session not found" }, 404);
  if (caller.type === "team") {
    return c.json(
      { error: "A team API key cannot replace a sandbox. Use a personal API key or the web app." },
      403,
    );
  }

  const unsettled = await engineStore.listUnsettledSubmissions(id);
  if (unsettled.length > 0) {
    return c.json({ error: "a turn is running. Wait for it to finish, then retry." }, 409);
  }

  const session = await engineHost.sessionFor(id, await loadSessionMeta(db, row));

  // Re-check immediately before replacing — a submission admitted while
  // sessionFor built the session wins (same TOCTOU rule as the idle
  // sweep's re-check before suspend).
  const recheck = await engineStore.listUnsettledSubmissions(id);
  if (recheck.length > 0) {
    return c.json({ error: "a turn is running. Wait for it to finish, then retry." }, 409);
  }

  try {
    await session.attachment.replace();
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  // `replace()` resolves once the re-provision settles, but a provision
  // that fails lands in `error` state without throwing — don't report ok
  // for a sandbox that never came up.
  if (session.attachment.state !== "ready") {
    return c.json(
      { error: "sandbox replacement failed to provision. Check the sandbox backend, then retry." },
      502,
    );
  }

  return c.json({ ok: true }, 200);
});

// ── Delete ────────────────────────────────────────────────────────────────

// Administer-gated (`canAdministerSession`): a team-owned session is
// deleted by the team's admins, not by whichever member opened it first.
// Unknown ids, and ids the caller may not administer, both 404.
sessionsRouter.delete("/:id", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canAdministerSession(db, row, c.var.principal))) {
    return c.json({ error: "session not found" }, 404);
  }

  // The workspace runtime is permanent; users archive conversations instead.
  const assistant = await loadAssistantBySessionId(db, id);
  if (assistant) return c.json({ error: "The workspace assistant cannot be deleted. Archive individual threads instead." }, 409);

  // Keep the owning session visible until required teardown succeeds.
  try {
    await engineHost.destroy(id);
  } catch (err) {
    console.error(`engineHost.destroy(${id}) failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : "Session teardown failed. Restore the sandbox connection, then retry deletion." }, 503);
  }

  // Mark standalone execution deleted only after resource teardown succeeds.
  await db.transaction(async (tx) => {
    await tx
      .update(agentSessions)
      .set({ status: "deleted", updatedAt: Date.now() })
      .where(eq(agentSessions.id, id));
  });

  // Clear any runtime that was reopened between teardown and the row update.
  try {
    await engineHost.destroy(id);
  } catch (err) {
    console.error(`engineHost.destroy(${id}) failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : "Session teardown failed. Restore the sandbox connection, then retry deletion." }, 503);
  }

  return c.json({ ok: true });
});
