import { deleteTeamResources } from "../services/team-resource-deletion.js";
/**
 * Teams — org membership structure (orchestrator spec, "Identity").
 *
 *   GET    /api/teams                       → list teams the caller belongs to
 *   POST   /api/teams                       → create a team (caller auto-admitted as admin)
 *   PATCH  /api/teams/:id                   → update team settings (default model, TKAI-255)
 *   DELETE /api/teams/:id                   → delete a team (409s while a team-owned run is unsettled)
 *   POST   /api/teams/:id/members           → add/update a member
 *   PATCH  /api/teams/:id/members/:userId   → change a member's role
 *   DELETE /api/teams/:id/members/:userId   → remove a member
 *   GET/POST/DELETE /api/teams/:id/api-keys → team `vlt_` keys (TKAI-396; `routes/team-api-keys.ts`)
 *
 * Org-membership-gated: every route requires the team to belong to the
 * caller's org (`c.var.user.orgId`) — cross-org teams 404 rather than 403,
 * so a caller can't distinguish "not your org" from "doesn't exist".
 *
 * Mutation-gated: PATCH /:id, DELETE /:id and the three /members routes
 * additionally require the caller to be a team admin of *that* team, or an org admin
 * (a deliberate recovery path so org admins can always untangle a team even
 * if they're not on it). That rule lives in `canAdministerTeam`
 * (`services/teams.ts`), which also gates administration of the resources a
 * team owns — one definition, no forks. A caller who fails the check gets
 * 404, same as a caller outside the org — existence-hiding applies to
 * authz, not just org membership.
 *
 * Identity-provider-backed teams keep their provenance, but login does not
 * own their membership. The normal administration gate controls their team
 * and membership mutations. `isLiveIdpMirror` remains as a compatibility
 * seam while old headless configuration fields remain accepted.
 *
 * A `config` team — declared in `valet.yaml` — is gated for DELETE only. The
 * file asserts its declared members at each boot but never removes anybody,
 * so a membership edit here is real work that survives until the next
 * restart, and refusing it would be stricter than the file's own semantics.
 * A delete is different: the next boot recreates the team empty, which reads
 * as data loss, so the route refuses it and names the file instead.
 *
 * There is no rename route today. Whoever adds one must refuse BOTH `idp`
 * and `config`: the reconciler identifies a declared team by name, so a
 * rename orphans the row and the next boot creates a second team beside it.
 */
import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { NotFoundError, ValetError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { requirePrincipal } from "../middleware/auth.js";
import {
  agentSessions,
  assistants,
  childWatches,
  contentSources,
  teams,
  type ContentSourceRow,
  type TeamRow,
} from "../schema/index.js";
import { listWorkflowSources } from "../services/content-sources.js";
import { joinEligibleTeam, listSuggestedTeams } from "../services/team-join-eligibility.js";
import { reapTeamWorkflows } from "../workflows/service.js";
import { isOrgAdmin } from "../services/org.js";
import { validateDefaultModelId } from "../services/model-catalog.js";
import { assertModelSelectable } from "../services/approved-models.js";
import { assertReasoningSelectable } from "../services/reasoning.js";
import {
  findDefaultAssistant,
} from "../assistants/service.js";
import {
  addMember,
  canAdministerTeam,
  canViewTeam,
  ConfigManagedTeamError,
  createTeam,
  deleteTeam,
  TeamHasActiveRunsError,
  getTeamInOrg,
  IdpManagedTeamError,
  type IdpManagedMutation,
  isLiveIdpMirror,
  LastAdminError,
  listTeamMembers,
  teamMembershipSummaries,
  listTeamsForOrg,
  listTeamsForUser,
  NotTeamMemberError,
  removeMember,
  setRole,
  TeamNameConflictError,
  TeamOwnsWorkflowsError,
} from "../services/teams.js";
import type {
  AddTeamMemberRequest,
  CreateTeamRequest,
  CreateTeamResponse,
  GetTeamChildrenResponse,
  TeamChildSummary,
  JoinSuggestedTeamResponse,
  ListSuggestedTeamsResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  PatchTeamResponse,
  SetTeamMemberRoleRequest,
  SkillSourceSummary,
  TeamRole,
  TeamSummary,
} from "../wire/types.js";

export const teamsRouter = new Hono<AppEnv>();

async function rowToSummary(
  db: AppEnv["Variables"]["providers"]["db"],
  row: TeamRow,
  callerUserId: string,
  membership?: Pick<TeamSummary, "memberCount" | "callerRole">,
): Promise<TeamSummary> {
  if (!membership) {
    const members = await listTeamMembers(db, row.id);
    membership = { memberCount: members.length, callerRole: members.find((m) => m.userId === callerUserId)?.role ?? null };
  }
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    origin: row.origin,
    externalId: row.externalId,
    createdAt: row.createdAt,
    memberCount: membership.memberCount,
    // null = the caller is not on this team (they see it as an org admin).
    callerRole: membership.callerRole,
    defaultModel: row.defaultModel,
    defaultReasoning: row.defaultReasoning,
    slackHomeChannelId: row.slackHomeChannelId,
  };
}

function toAdoptedSourceSummary(row: ContentSourceRow): SkillSourceSummary {
  return {
    id: row.id,
    repo: row.repoFullName,
    ref: row.ref,
    subpath: row.subpath,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    kinds: row.kinds,
    enabled: row.enabled,
    status: row.status,
    skillCount: 0,
    lastSyncedAt: row.lastSyncedAt,
    lastSha: row.lastSha,
    lastMessage: row.lastError,
  };
}

function isTeamRole(v: unknown): v is TeamRole {
  return v === "admin" || v === "member";
}

/** Compatibility refusal for any future live external team writer. */
async function idpManagedRefusal(
  db: AppEnv["Variables"]["providers"]["db"],
  row: TeamRow,
  mutation: IdpManagedMutation,
): Promise<{ error: string; code: string } | null> {
  if (!(await isLiveIdpMirror(db, row))) return null;
  const err = new IdpManagedTeamError(row, mutation);
  return { error: err.message, code: err.code };
}

/**
 * Builds the refusal body for a DELETE of a team declared in `valet.yaml`,
 * or null for any other team.
 *
 * Delete only. Membership on a config team stays editable — see the file
 * header. Same 409 reasoning as `idpManagedRefusal`, and the message comes
 * from the class the service throws for the same reason.
 */
function configManagedDeleteRefusal(row: TeamRow): { error: string; code: string } | null {
  if (row.origin !== "config") return null;
  const err = new ConfigManagedTeamError(row.name);
  return { error: err.message, code: err.code };
}

/** Maps service errors to the route's JSON error response. Rethrows unknowns. */
function handleServiceError(err: unknown): { body: { error: string; code?: string }; status: 404 | 409 } | null {
  if (
    err instanceof TeamNameConflictError ||
    err instanceof LastAdminError ||
    err instanceof TeamOwnsWorkflowsError ||
    err instanceof TeamHasActiveRunsError ||
    err instanceof IdpManagedTeamError ||
    err instanceof ConfigManagedTeamError
  ) {
    return { body: { error: err.message, code: err.code }, status: 409 };
  }
  if (err instanceof NotTeamMemberError || err instanceof NotFoundError) {
    return { body: { error: err.message, code: "not_found" }, status: 404 };
  }
  if (err instanceof ValetError) {
    // Any other ValetError subclass — surface its own status if 404/409,
    // otherwise let the caller rethrow to the global error handler.
    if (err.statusCode === 404 || err.statusCode === 409) {
      return { body: { error: err.message, code: err.code }, status: err.statusCode };
    }
  }
  return null;
}

async function loadTeamInOrg(db: AppEnv["Variables"]["providers"]["db"], teamId: string, orgId: string) {
  return getTeamInOrg(db, orgId, teamId);
}

function refuseTeamApiKey(c: Context<AppEnv>) {
  if (requirePrincipal(c)?.type === "team") {
    return c.json(
      { error: "A team API key cannot change team membership. Sign in to the team workspace." },
      403,
    );
  }
  return undefined;
}

// ── List ──────────────────────────────────────────────────────────────────

teamsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  // Org admins manage every team in the org, not just ones they belong to;
  // plain members still only see their own memberships.
  const admin = await isOrgAdmin(db, user.orgId, user.id);
  const rows = admin
    ? await listTeamsForOrg(db, user.orgId)
    : (await listTeamsForUser(db, user.id)).filter((r) => r.orgId === user.orgId);

  const memberships = await teamMembershipSummaries(db, user.orgId, rows.map((row) => row.id), user.id);
  const body: ListTeamsResponse = {
    teams: await Promise.all(rows.map((r) => rowToSummary(db, r, user.id,
      memberships.get(r.id) ?? { memberCount: 0, callerRole: null }))),
  };
  return c.json(body);
});

// ── Explicit identity-provider join suggestions ──────────────────────────

teamsRouter.get("/suggestions", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const body: ListSuggestedTeamsResponse = {
    teams: await listSuggestedTeams(db, user.orgId, user.id),
  };
  return c.json(body);
});

teamsRouter.post("/:id/join", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db } = c.var.providers;
  const user = c.var.user;
  const joined = await joinEligibleTeam(db, {
    orgId: user.orgId,
    userId: user.id,
    teamId: c.req.param("id"),
  });
  if (!joined) return c.json({ error: "team not found" }, 404);
  return c.json({ joined: true } satisfies JoinSuggestedTeamResponse);
});

// ── Children (team dashboard) ───────────────────────────────────────────

/** Recent child runs from the team runtime. Threads provides the full work history. */
teamsRouter.get("/:id/children", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canViewTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  const runtime = await findDefaultAssistant(db, user.orgId, { type: "team", id });
  if (!runtime || runtime.archivedAt !== null) return c.json({ children: [] });

  const selection = {
    sessionId: childWatches.childSessionId,
    parentSessionId: childWatches.parentSessionId,
    parentThreadId: childWatches.parentThreadId,
    settled: childWatches.settled,
    createdAt: childWatches.createdAt,
    title: agentSessions.title,
    lastActivityAt: agentSessions.lastActivityAt,
  };
  const parentFilter = and(
    eq(childWatches.parentSessionId, runtime.sessionId),
    isNull(childWatches.dismissedAt),
  );
  // Two reads, merged: the newest window feeds the dashboard, and RUNNING
  // rows ride along unconditionally — a still-running child older than the
  // window must not read as idle just because 20 quick runs settled after
  // it started. Both are bounded; running rows cap at the same 20.
  const [newest, running] = await Promise.all([
    db
      .select(selection)
      .from(childWatches)
      .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
      .where(parentFilter)
      .orderBy(desc(sql`COALESCE(${agentSessions.lastActivityAt}, ${childWatches.createdAt})`))
      .limit(20),
    db
      .select(selection)
      .from(childWatches)
      .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
      .where(and(parentFilter, eq(childWatches.settled, false)))
      .orderBy(desc(sql`COALESCE(${agentSessions.lastActivityAt}, ${childWatches.createdAt})`))
      .limit(20),
  ]);
  const seen = new Set<string>();
  const rows = [...newest, ...running]
    .filter((r) => (seen.has(r.sessionId) ? false : (seen.add(r.sessionId), true)))
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));

  const children: TeamChildSummary[] = rows.map((r) => {
    return {
      sessionId: r.sessionId,
      title: r.title ?? r.sessionId,
      parentThreadId: r.parentThreadId,
      status: r.settled ? "settled" : "running",
      createdAt: r.createdAt,
    };
  });

  const body: GetTeamChildrenResponse = { children };
  return c.json(body);
});

// ── Members: list ────────────────────────────────────────────────────────

teamsRouter.get("/:id/members", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canViewTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  const members = await listTeamMembers(db, id);
  const body: ListTeamMembersResponse = { members };
  return c.json(body);
});

// ── Create ────────────────────────────────────────────────────────────────

teamsRouter.post("/", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db, contentSync } = c.var.providers;
  const user = c.var.user;

  let body: CreateTeamRequest;
  try {
    body = (await c.req.json()) as CreateTeamRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  try {
    const orgSources = await listWorkflowSources(db, {
      orgId: user.orgId,
      ownerType: "org",
      ownerId: user.orgId,
    });
    const team = await createTeam(db, {
      orgId: user.orgId,
      name: body.name,
      creatorUserId: user.id,
      adoptSources: orgSources.map((source) => ({
        repoFullName: source.repoFullName,
        ref: source.ref,
        subpath: source.subpath,
        kinds: source.kinds,
      })),
    });
    const adoptedSources: SkillSourceSummary[] = [];
    for (const source of team.adoptedSources) {
      // A failed first sync is reported on the row, same as source create.
      await contentSync.syncOnce(source.id);
      const rows = await db.select().from(contentSources).where(eq(contentSources.id, source.id)).limit(1);
      adoptedSources.push(toAdoptedSourceSummary(rows[0] ?? source));
    }
    const resp: CreateTeamResponse = {
      team: await rowToSummary(db, team, user.id),
      adoptedSources,
      runtime: { sessionId: team.defaultAssistant.sessionId },
    };
    return c.json(resp, 201);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Update ────────────────────────────────────────────────────────────────

const PATCH_TEAM_FIELDS = new Set(["defaultModel", "defaultReasoning", "slackHomeChannelId"]);

/**
 * Team settings (TKAI-255). Strict whitelist, same shape as `PATCH /api/me`:
 * an unknown field 400s rather than silently no-oping, and a non-null
 * `defaultModel` must be an id the org catalog reports as valid — the same
 * set `GET /api/models` shows the picker.
 */
teamsRouter.patch("/:id", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body. Send a JSON object, e.g. {\"defaultModel\": null}." }, 400);
  }
  // `JSON.parse` accepts `null`/numbers/strings, which `Object.keys` and the
  // `in` operator below would throw on — reject anything but a plain object.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json({ error: "invalid JSON body. Send a JSON object, e.g. {\"defaultModel\": null}." }, 400);
  }
  const raw = parsed as Record<string, unknown>;
  const unknownFields = Object.keys(raw).filter((k) => !PATCH_TEAM_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return c.json(
      { error: `unknown field(s): ${unknownFields.join(", ")}. Send only defaultModel, defaultReasoning, or slackHomeChannelId.` },
      400,
    );
  }

  // `team` from `loadTeamInOrg` above is fresh within this request; the
  // write branch swaps it for the UPDATE's own returned row, so no re-read.
  let fresh: TeamRow = team;
  const update: { defaultModel?: string | null; defaultReasoning?: string | null; slackHomeChannelId?: string | null } = {};
  if ("slackHomeChannelId" in raw) {
    const channel = raw.slackHomeChannelId;
    if (channel !== null && (typeof channel !== "string" || !/^[CG][A-Z0-9]{2,}$/.test(channel))) {
      return c.json({ error: "Use a Slack channel ID starting with C or G, or null to disable home-channel notifications." }, 400);
    }
    update.slackHomeChannelId = channel;
  }
  if ("defaultModel" in raw) {
    const defaultModel = raw.defaultModel;
    if (defaultModel !== null && typeof defaultModel !== "string") {
      return c.json(
        { error: "defaultModel must be a model id from the model list (GET /api/models), or null to clear the override." },
        400,
      );
    }
    const invalid = await validateDefaultModelId(db, engineCredentials, user.orgId, defaultModel);
    if (invalid) return c.json({ error: invalid }, 400);
    if (defaultModel !== null) {
      const isAdmin = await isOrgAdmin(db, user.orgId, user.id);
      const err = await assertModelSelectable(db, user.orgId, isAdmin, defaultModel);
      if (err) return c.json({ error: err }, 400);
    }
    update.defaultModel = defaultModel;
  }
  if ("defaultReasoning" in raw) {
    const defaultReasoning = raw.defaultReasoning;
    if (defaultReasoning !== null && typeof defaultReasoning !== "string") {
      return c.json(
        { error: "defaultReasoning must be a reasoning level string, or null to clear the override." },
        400,
      );
    }
    if (defaultReasoning === null) {
      update.defaultReasoning = null;
    } else {
      const normalizedReasoning = defaultReasoning.trim().toLowerCase();
      const err = await assertReasoningSelectable(db, user.orgId, normalizedReasoning);
      if (err) return c.json({ error: err }, 400);
      update.defaultReasoning = normalizedReasoning;
    }
  }
  if (Object.keys(update).length > 0) {
    const updated = await db.update(teams).set(update).where(eq(teams.id, id)).returning();
    // Zero rows = the team was deleted between the gate and the write.
    if (!updated[0]) return c.json({ error: "team not found" }, 404);
    fresh = updated[0];
  }

  const resp: PatchTeamResponse = { team: await rowToSummary(db, fresh, user.id) };
  return c.json(resp);
});

// ── Delete ────────────────────────────────────────────────────────────────

teamsRouter.delete("/:id", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  let sessionIds: string[];
  try {
    sessionIds = await deleteTeamResources(db, { orgId: user.orgId, userId: user.id }, id);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
  for (const sessionId of sessionIds) {
    await engineHost.destroy(sessionId).catch((err) => console.error(`engineHost.destroy(${sessionId}) failed:`, err));
  }
  return c.json({ ok: true });
});

// ── Members: add/update ─────────────────────────────────────────────────

teamsRouter.post("/:id/members", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  const refusal = await idpManagedRefusal(db, team, "membership");
  if (refusal) return c.json(refusal, 409);

  let body: AddTeamMemberRequest;
  try {
    body = (await c.req.json()) as AddTeamMemberRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.userId || typeof body.userId !== "string") {
    return c.json({ error: "userId is required" }, 400);
  }
  if (!isTeamRole(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

  try {
    await addMember(db, { teamId: id, userId: body.userId, role: body.role });
    return c.json({ ok: true }, 201);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Members: change role ────────────────────────────────────────────────

teamsRouter.patch("/:id/members/:userId", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  const refusal = await idpManagedRefusal(db, team, "membership");
  if (refusal) return c.json(refusal, 409);

  let body: SetTeamMemberRoleRequest;
  try {
    body = (await c.req.json()) as SetTeamMemberRoleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isTeamRole(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

  try {
    await setRole(db, { teamId: id, userId: targetUserId, role: body.role });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Members: remove ──────────────────────────────────────────────────────

teamsRouter.delete("/:id/members/:userId", async (c) => {
  const refused = refuseTeamApiKey(c);
  if (refused) return refused;
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  const refusal = await idpManagedRefusal(db, team, "membership");
  if (refusal) return c.json(refusal, 409);

  try {
    await removeMember(db, { teamId: id, userId: targetUserId });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});
