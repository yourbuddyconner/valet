/**
 * Teams service — the org's membership structure (orchestrator spec,
 * "Identity"). Names unique per org (enforced at the schema level via
 * `teams_org_name`); last-admin guards on role change and removal, and
 * creator-auto-admin, are enforced here inside a single sqlite transaction
 * so a role-change and a removal racing on the same team's last admin can
 * never both succeed.
 */
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import { markAttentionNotificationsRead } from "../orchestrator/attention.js";
import { teamDeletionRequests } from "../schema/index.js";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import {
  actionPolicies,
  agentSessions,
  apikey,
  assistants,
  channelBindings,
  credentials,
  eventSubscriptions,
  followedThreads,
  orgMembers,
  skills,
  contentSources,
  teamJoinEligibilities,
  teamMembers,
  teams,
  workflowDefinitions,
  workflowSchedules,
  type AssistantRow,
  type ContentSourceRow,
  type TeamRow,
} from "../schema/index.js";
import { resolveDefaultAssistant, retireAssistant } from "../assistants/service.js";
import { isOrgAdmin } from "./org.js";
import {
  adoptedTeamSourceRow,
  deleteMirroredContent,
  type AdoptedSourceSpec,
} from "./content-sources.js";

export type TeamRole = "admin" | "member";

/** Aggregate only authorized teams; never materialize their full memberships. */
export async function teamMembershipSummaries(
  db: AppDb,
  orgId: string,
  teamIds: readonly string[],
  callerUserId: string,
): Promise<Map<string, { memberCount: number; callerRole: TeamRole | null }>> {
  const summaries = new Map<string, { memberCount: number; callerRole: TeamRole | null }>();
  const ids = [...new Set(teamIds)];
  for (let offset = 0; offset < ids.length; offset += 1_000) {
    const rows = await db.select({
      teamId: teamMembers.teamId,
      memberCount: count(),
      callerRole: sql<TeamRole | null>`max(case when ${teamMembers.userId} = ${callerUserId} then ${teamMembers.role} end)`,
    }).from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teams.orgId, orgId), inArray(teamMembers.teamId, ids.slice(offset, offset + 1_000))))
      .groupBy(teamMembers.teamId);
    for (const row of rows) summaries.set(row.teamId, { memberCount: row.memberCount, callerRole: row.callerRole });
  }
  return summaries;
}

/** Thrown when creating a team whose name is already taken within the org. */
export class TeamNameConflictError extends Error {
  readonly code = "team_name_conflict";
  readonly statusCode = 409;
  constructor(orgId: string, name: string) {
    super(`team name '${name}' already exists in org ${orgId}`);
    this.name = "TeamNameConflictError";
  }
}

/**
 * Thrown when a role change or removal would leave a team with zero admins.
 * Checked and enforced inside the same transaction as the mutating write.
 */
export class LastAdminError extends Error {
  readonly code = "last_admin";
  readonly statusCode = 409;
  constructor(teamId: string) {
    super(`team ${teamId} must keep at least one admin`);
    this.name = "LastAdminError";
  }
}

/** Thrown by `deleteTeam` when the team still owns one or more workflows. */
export class TeamOwnsWorkflowsError extends Error {
  readonly code = "team_owns_workflows";
  readonly statusCode = 409;
  constructor(teamId: string) {
    super(`team ${teamId} still owns one or more workflows — reassign or delete them first`);
    this.name = "TeamOwnsWorkflowsError";
  }
}

/** Thrown when a team delete would reap a workflow that still has a run
 * in flight. Wait for the run to finish, or cancel it, then delete. */
export class TeamHasActiveRunsError extends Error {
  readonly code = "team_has_active_runs";
  readonly statusCode = 409;
  constructor(teamId: string) {
    super(
      `team ${teamId} has an unsettled workflow run. Wait for it to finish, or cancel it, then delete the team.`,
    );
    this.name = "TeamHasActiveRunsError";
  }
}

/** Names which mutation a guard refused, so the message can name the fix. */
export type IdpManagedMutation = "membership" | "delete";

/** The fields a refusal message needs. Any team row satisfies it. */
export interface IdpManagedTeamRef {
  name: string;
  externalId: string | null;
}

/**
 * One wording for both guards. The routes build the refusal from the row
 * they already loaded; the service builds it from its own read. The two must
 * never drift, so both come through here.
 */
export function idpManagedTeamMessage(team: IdpManagedTeamRef, mutation: IdpManagedMutation): string {
  // The sync sets `external_id` on every team it creates. The name is a
  // fallback, so a row that somehow lost the path still points somewhere.
  const group = team.externalId ?? team.name;
  if (mutation === "delete") {
    return (
      `team '${team.name}' mirrors identity provider group '${group}' — ` +
      `delete that group in the identity provider to empty the team. ` +
      `Valet keeps the team itself.`
    );
  }
  return (
    `team '${team.name}' mirrors identity provider group '${group}' — ` +
    `add or remove people in that group in the identity provider, then ask them to sign in again`
  );
}

/**
 * Thrown when a mutation targets a team that mirrors an identity-provider
 * group. The identity provider owns that team's membership, so Valet must
 * not change it: a local edit would survive only until the next sign-in,
 * and it would read as data loss when the sync put it back.
 *
 * The routes refuse the same four mutations before they ever reach the
 * service. This class is the second line — it catches a caller that reaches
 * the service directly, and it keeps the refusal with the rule it enforces.
 *
 * The team sync is the deliberate exception. It writes `team_members`
 * directly and never calls the guarded functions, the same way `content-sync`
 * owns its `repo`-origin skill rows.
 */
export class IdpManagedTeamError extends Error {
  readonly code = "team_idp_managed";
  readonly statusCode = 409;
  constructor(team: IdpManagedTeamRef, mutation: IdpManagedMutation) {
    super(idpManagedTeamMessage(team, mutation));
    this.name = "IdpManagedTeamError";
  }
}

/**
 * Thrown when a delete targets a team declared in `valet.yaml`.
 *
 * Only delete. The file asserts its declared members at every boot and never
 * removes one, so a membership edit through the API is real work that lasts
 * until the next restart — refusing it would be stricter than the file's own
 * rule. A delete is the case the file cannot express: the next boot would
 * recreate the team empty, and an operator reading the teams page would see
 * the team return with nobody in it.
 *
 * The message names the environment variable, not a resolved path, because
 * this service reads no environment. `VALET_CONFIG` identifies the file
 * without ambiguity.
 */
export class ConfigManagedTeamError extends Error {
  readonly code = "team_config_managed";
  readonly statusCode = 409;
  constructor(name: string) {
    super(
      `team '${name}' is declared in the instance config file (VALET_CONFIG) — ` +
        `remove it from the teams: list in that file, then restart. ` +
        `Valet recreates a declared team at every boot.`,
    );
    this.name = "ConfigManagedTeamError";
  }
}

/** Thrown when targeting a user who isn't a member of the team. */
export class NotTeamMemberError extends NotFoundError {
  constructor(teamId: string, userId: string) {
    super("team member", `${teamId}/${userId}`);
  }
}

/** Thrown when adding a user who isn't a member of the team's org. */
export class NotOrgMemberError extends NotFoundError {
  constructor(orgId: string, userId: string) {
    super("org member", `${orgId}/${userId}`);
  }
}

/** True when a Postgres unique-constraint violation fired — within
 * `createTeam`'s transaction, the only unique index that can fire is
 * `teams_org_name` (team ids are freshly minted UUIDs). */
function isTeamNameUniqueViolation(err: unknown): boolean {
  return isPgUniqueViolation(err);
}

function newTeamId(): string {
  return `team_${randomUUID()}`;
}

async function countAdmins(db: AppQueryable, teamId: string): Promise<number> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  return rows.length;
}

/**
 * True when this team is a LIVE mirror: it carries `origin='idp'` AND the
 * org's `ssoTeamSync` gate is on.
 *
 * The gate is part of the question because the lock exists for one reason —
 * the login sync owns these rows, so a hand edit would survive only until
 * the next sign-in and would read as data loss when the sync undid it. With
 * the gate off, no sync runs, and that reason is gone. The rows are then a
 * DORMANT mirror: Valet keeps them, keeps their members and keeps their
 * work, and gives the team controls back so people are not left with teams
 * nobody can rename, empty or remove.
 *
 * `origin` itself is not rewritten when the gate goes off. It is what
 * `findByExternalId` matches on, so leaving it is what lets an operator turn
 * the gate back on later and have each mirror adopted again instead of
 * colliding with its own group by name (`services/team-sync.ts`).
 */
export async function isLiveIdpMirror(
  _db: AppQueryable,
  _team: { orgId: string; origin: TeamRow["origin"] },
): Promise<boolean> {
  // Explicit join retired login-time membership sync.
  // Keep this compatibility seam until the headless config fields are
  // removed, but no identity-provider team is live-managed now.
  return false;
}

/**
 * Refuses the mutation when the team is a live mirror of an
 * identity-provider group.
 *
 * A missing team is not this guard's business. Each caller already reports
 * its own not-found, and inventing a second one here would change what a
 * caller sees for a team id that never existed.
 */
async function assertNotIdpManaged(
  db: AppQueryable,
  teamId: string,
  mutation: IdpManagedMutation,
): Promise<void> {
  const rows = await db
    .select({
      orgId: teams.orgId,
      name: teams.name,
      origin: teams.origin,
      externalId: teams.externalId,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  const team = rows[0];
  if (team && (await isLiveIdpMirror(db, team))) throw new IdpManagedTeamError(team, mutation);
}

async function getMember(
  db: AppQueryable,
  teamId: string,
  userId: string,
): Promise<{ teamId: string; userId: string; role: TeamRole } | undefined> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return rows[0];
}

/** Seeds the default assistant for one principal inside the caller's
 * transaction. Same shape as `resolveDefaultAssistant`. */
export type SeedDefaultAssistant = (
  tx: AppQueryable,
  orgId: string,
  principal: Principal,
) => Promise<AssistantRow>;

/**
 * One-time backfill for teams written before every team writer seeded a
 * default assistant. Runs at boot, after migrations: each team with no
 * default gets one through the same seed the writers use. Idempotent, and
 * a team that already holds a default, or one that was seeded by a
 * concurrent boot, is skipped by the seed's own conflict handling. Returns
 * the ids it seeded so the boot log can name them.
 */
export async function seedMissingTeamDefaults(db: AppDb): Promise<string[]> {
  const rows = await db
    .select({ id: teams.id, orgId: teams.orgId })
    .from(teams)
    .leftJoin(
      assistants,
      and(
        eq(assistants.ownerType, "team"),
        eq(assistants.ownerId, teams.id),
        eq(assistants.orgId, teams.orgId),
      ),
    )
    .where(isNull(assistants.id))
    .orderBy(teams.createdAt);
  const seeded: string[] = [];
  for (const row of rows) {
    await resolveDefaultAssistant(db, row.orgId, { type: "team", id: row.id });
    seeded.push(row.id);
  }
  return seeded;
}

export interface CreateTeamOptions {
  orgId: string;
  name: string;
  creatorUserId: string;
  /** Org-owned workflow sources to copy as team-owned rows. Inserted in
   * the same transaction as the team and the creator's membership. */
  adoptSources?: readonly Omit<AdoptedSourceSpec, "orgId">[];
  /**
   * Replaces the assistant seed. Only a test sets this, to prove the team
   * insert rolls back when the seed throws. Defaults to the real seed.
   */
  seedDefaultAssistant?: SeedDefaultAssistant;
}

export type CreateTeamResult = CreatedTeam;

/**
 * The new team row plus what the create transaction seeded beside it. The
 * route answers POST from this, so it never re-reads rows it already holds.
 */
export type CreatedTeam = TeamRow & {
  /** The default assistant seeded in the same transaction as the team. */
  defaultAssistant: AssistantRow;
  /** Org workflow sources copied onto the team in that same transaction. */
  adoptedSources: ContentSourceRow[];
};

/**
 * Creates a team; the creator is auto-admitted as its first admin. The
 * name-conflict check runs inside the same transaction as the insert (plus
 * a belt-and-suspenders catch on the `teams_org_name` unique constraint) so
 * two concurrent creates of the same name can't both pass the pre-check and
 * race into a raw 500 — the loser always sees `TeamNameConflictError`.
 *
 * A default assistant is seeded in the SAME transaction (TKAI-337). Every
 * `/chat` UI affordance for a team keys off "the team owns an assistant"
 * (group header, `+` button, scoped default), and lazy creation left a
 * brand-new team as a dead end that silently opened the caller's personal
 * conversation. The seed and the team insert live and die together.
 */
export async function createTeam(db: AppDb, opts: CreateTeamOptions): Promise<CreatedTeam> {
  const seedDefaultAssistant = opts.seedDefaultAssistant ?? resolveDefaultAssistant;
  const id = newTeamId();
  const now = Date.now();
  // A team created through this service is always `local`: it belongs to the
  // org, not to an identity provider, so no group sync may ever rewrite it.
  const row: TeamRow = {
    id,
    orgId: opts.orgId,
    name: opts.name,
    origin: "local",
    externalId: null,
    createdAt: now,
    defaultModel: null,
    defaultReasoning: null,
    slackHomeChannelId: null,
  };
  const adoptedSources: ContentSourceRow[] = [];

  try {
    const defaultAssistant = await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(teams)
        .where(and(eq(teams.orgId, opts.orgId), eq(teams.name, opts.name)))
        .limit(1);
      if (existingRows[0]) throw new TeamNameConflictError(opts.orgId, opts.name);

      await tx.insert(teams).values(row);
      await tx.insert(teamMembers).values({ teamId: id, userId: opts.creatorUserId, role: "admin" });
      for (const source of opts.adoptSources ?? []) {
        const adopted = adoptedTeamSourceRow(
          { orgId: opts.orgId, ...source },
          { teamId: id, createdBy: opts.creatorUserId, now },
        );
        await tx.insert(contentSources).values(adopted);
        adoptedSources.push(adopted);
      }
      return seedDefaultAssistant(tx, opts.orgId, { type: "team", id });
    });
    return { ...row, defaultAssistant, adoptedSources };
  } catch (err) {
    if (isTeamNameUniqueViolation(err)) throw new TeamNameConflictError(opts.orgId, opts.name);
    throw err;
  }
}

export interface AddMemberOptions {
  teamId: string;
  userId: string;
  role: TeamRole;
}

/**
 * Adds a member to a team. Adding an existing member updates their role.
 * Rejects with `NotOrgMemberError` if the target user isn't a member of the
 * team's org — otherwise any org member could add an arbitrary (or
 * cross-org) userId onto a team. Rejects with `IdpManagedTeamError` on a
 * team that mirrors a group: only the sync writes those memberships.
 */
export async function addMember(db: AppDb, opts: AddMemberOptions): Promise<void> {
  const teamRows = await db.select().from(teams).where(eq(teams.id, opts.teamId)).limit(1);
  const team = teamRows[0];
  if (!team) throw new NotFoundError("team", opts.teamId);
  // The row is already here, so check it directly instead of re-reading.
  if (await isLiveIdpMirror(db, team)) throw new IdpManagedTeamError(team, "membership");

  const targetOrgMemberRows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, team.orgId), eq(orgMembers.userId, opts.userId)))
    .limit(1);
  if (!targetOrgMemberRows[0]) throw new NotOrgMemberError(team.orgId, opts.userId);

  await db.transaction(async (tx) => {
    const existing = await getMember(tx, opts.teamId, opts.userId);
    if (existing) {
      await tx
        .update(teamMembers)
        .set({ role: opts.role })
        .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)));
    } else {
      await tx.insert(teamMembers).values({ teamId: opts.teamId, userId: opts.userId, role: opts.role });
      await invalidateWorkflowSources(tx, { teamId: opts.teamId });
    }
  });
}

export interface SetRoleOptions {
  teamId: string;
  userId: string;
  role: TeamRole;
}

/**
 * Changes a member's role. Rejects with `LastAdminError` when demoting the
 * team's sole remaining admin, and with `IdpManagedTeamError` on a team that
 * mirrors a group. Runs the read-check-write as one transaction so a
 * concurrent removal/demotion on the same team can't both succeed.
 */
export async function setRole(db: AppDb, opts: SetRoleOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await assertNotIdpManaged(tx, opts.teamId, "membership");
    const member = await getMember(tx, opts.teamId, opts.userId);
    if (!member) throw new NotTeamMemberError(opts.teamId, opts.userId);

    if (member.role === "admin" && opts.role === "member") {
      const admins = await countAdmins(tx, opts.teamId);
      if (admins <= 1) throw new LastAdminError(opts.teamId);
    }

    await tx
      .update(teamMembers)
      .set({ role: opts.role })
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)));
  });
}

export interface RemoveMemberOptions {
  teamId: string;
  userId: string;
}

/**
 * Removes a member from a team. Rejects with `LastAdminError` when removing
 * the team's sole remaining admin, `NotTeamMemberError` when the target
 * isn't a member, and `IdpManagedTeamError` on a team that mirrors a group.
 * Atomic with the admin-count check (same transaction).
 */
export async function removeMember(db: AppDb, opts: RemoveMemberOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await assertNotIdpManaged(tx, opts.teamId, "membership");
    const member = await getMember(tx, opts.teamId, opts.userId);
    if (!member) throw new NotTeamMemberError(opts.teamId, opts.userId);

    if (member.role === "admin") {
      const admins = await countAdmins(tx, opts.teamId);
      if (admins <= 1) throw new LastAdminError(opts.teamId);
    }

    await tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)));
    await invalidateWorkflowSources(tx, { teamId: opts.teamId });
  });
}

/** Lists every team the given user is currently a member of. */
export async function listTeamsForUser(db: AppDb, userId: string): Promise<TeamRow[]> {
  return db
    .select({
      id: teams.id,
      orgId: teams.orgId,
      name: teams.name,
      origin: teams.origin,
      externalId: teams.externalId,
      createdAt: teams.createdAt,
      defaultModel: teams.defaultModel,
      defaultReasoning: teams.defaultReasoning,
      slackHomeChannelId: teams.slackHomeChannelId,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.createdAt);
}

/**
 * Live membership check — re-queries on every call, never cached. Per the
 * orchestrator spec's access model: "Eligibility is re-checked at action
 * time, not delivery time" — a member removed from a team must lose access
 * to its resources on their very next request, not at the next snapshot.
 * This is the sole access path to any team-owned resource (memory,
 * workflows, sessions, credentials): no creator shortcut, no org-visible
 * fallback.
 */
export async function isTeamMember(db: AppQueryable, teamId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Live view check — the one definition of "may see this team's resources
 * without changing them": a member of the team, or an admin of the team's
 * org, who manages every team in it (the roster, the credential list, the
 * 1Password lease). Looser than `canAdministerTeam`, which requires
 * team-admin. Reads the org from the team row, the way `canAdministerTeam`
 * does, so an admin of some other org is not admitted. Membership is
 * re-read on every call, never cached, same contract as `isTeamMember`.
 */
export async function canViewTeam(db: AppQueryable, teamId: string, userId: string): Promise<boolean> {
  const teamRows = await db.select({ orgId: teams.orgId }).from(teams).where(eq(teams.id, teamId)).limit(1);
  const team = teamRows[0];
  if (!team) return false;
  if (await isOrgAdmin(db, team.orgId, userId)) return true;
  return isTeamMember(db, teamId, userId);
}

/**
 * Live administration check — the one definition of "may administer this
 * team". True for a team admin of `teamId`, and for an admin of the team's
 * org (per `org_members.role`, not the global `users.role` operator flag).
 * Org admin is a deliberate recovery path, for example when the team's last
 * admin left the org. Keep it narrow: do not extend it to plain org
 * membership.
 *
 * Two surfaces share this check, and they must not drift:
 *
 *   1. The team mutation routes — delete the team, add/set-role/remove a
 *      member (`routes/teams.ts`).
 *   2. Administration of a team-owned resource, where the team holds the
 *      authority instead of a row's `user_id`
 *      (`canAdministerSession` in `services/session-access.ts`).
 *
 * Reads the org from the team row rather than from the caller's request
 * context, so callers that hold no `orgId` ask the same question as callers
 * that do. An unknown team id is false: no team, no authority.
 *
 * Membership is re-read on every call, never cached — same contract as
 * `isTeamMember`.
 */
export async function canAdministerTeam(db: AppQueryable, teamId: string, userId: string): Promise<boolean> {
  const teamRows = await db.select({ orgId: teams.orgId }).from(teams).where(eq(teams.id, teamId)).limit(1);
  const team = teamRows[0];
  if (!team) return false;
  if (await isOrgAdmin(db, team.orgId, userId)) return true;

  const memberRows = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return memberRows[0]?.role === "admin";
}

/**
 * The team row, only when the team belongs to `orgId`. The one definition of
 * "this team is reachable from this org context", shared by the team routes
 * and team-scoped queries (usage) so the rule cannot drift. An unknown id
 * resolves the same as a foreign org's team — callers must not reveal which
 * of the two it was (existence hiding).
 */
export async function getTeamInOrg(db: AppQueryable, orgId: string, teamId: string): Promise<TeamRow | undefined> {
  const rows = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  const row = rows[0];
  if (!row || row.orgId !== orgId) return undefined;
  return row;
}

/**
 * Lists every team in an org, regardless of the caller's own membership.
 * Org admins manage the whole roster, not just teams they happen to belong
 * to — `listTeamsForUser` alone would hide a team from an admin who isn't
 * on it.
 */
export async function listTeamsForOrg(db: AppDb, orgId: string): Promise<TeamRow[]> {
  return db
    .select({
      id: teams.id,
      orgId: teams.orgId,
      name: teams.name,
      origin: teams.origin,
      externalId: teams.externalId,
      createdAt: teams.createdAt,
      defaultModel: teams.defaultModel,
      defaultReasoning: teams.defaultReasoning,
      slackHomeChannelId: teams.slackHomeChannelId,
    })
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(teams.createdAt);
}

/** Lists a team's members (userId + role), for the teams settings panel. */
export async function listTeamMembers(
  db: AppDb,
  teamId: string,
): Promise<Array<{ userId: string; role: TeamRole }>> {
  return db
    .select({ userId: teamMembers.userId, role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
}

/**
 * Deletion guard: the orchestrator spec blocks team deletion "while
 * team-owned workflows exist" — a deleted team's `ownerId` would otherwise
 * strand its workflows (every `ownedDefinitionRow` check reads through live
 * `team_members`, so an orphaned `ownerId` becomes permanently
 * inaccessible, not just unowned). Queries `workflow_definitions` directly
 * rather than importing `workflows/service.ts`, which would create a
 * services/teams.ts <-> services/workflows.ts import cycle.
 */
export async function assertNoTeamOwnedWorkflows(db: AppQueryable, teamId: string): Promise<void> {
  const rows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, teamId)))
    .limit(1);
  if (rows.length > 0) throw new TeamOwnsWorkflowsError(teamId);
}

/**
 * `pg_advisory_xact_lock` keyed by team id, released automatically at
 * transaction end. `deleteTeam`'s checks and the team-owned INSERTs in
 * `workflows/service.ts` and `services/skills.ts` target tables with no FK
 * between them (a polymorphic `owner_id` can't carry one), so under plain
 * MVCC a SELECT here never blocks a concurrent INSERT there — this lock is
 * what actually serializes "is the team still valid to own this" against
 * "delete the team," not the surrounding `db.transaction` on its own. Every
 * side must take this same lock for it to do anything.
 */
export async function lockTeamForOwnership(tx: AppQueryable, teamId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${teamId}))`);
}

/** Validates a prospective team owner and writes under the same transaction
 * lock used by deletion. `principalTeamId: null` is a user/org request;
 * another team id is a cross-team request and always fails closed. */
export async function withAuthorizedTeamOwnership<T>(
  db: AppDb,
  opts: {
    teamId: string;
    orgId: string;
    userId: string;
    principalTeamId: string | null;
    requireMembership: boolean;
  },
  write: (tx: AppQueryable) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    await lockTeamForOwnership(tx, opts.teamId);
    const principalMatches = opts.principalTeamId === opts.teamId;
    const trustedPrincipal = principalMatches && !opts.requireMembership;
    const mayUseMembership = opts.principalTeamId === null || principalMatches;
    const authorized = trustedPrincipal ||
      (mayUseMembership && await isTeamMember(tx, opts.teamId, opts.userId));
    if (!(await getTeamInOrg(tx, opts.orgId, opts.teamId)) || !authorized) return null;
    return write(tx);
  });
}

export interface DeleteTeamOptions {
  teamId: string;
  /** Reaps team-owned workflows under the ownership lock, ahead of
   * `assertNoTeamOwnedWorkflows`. The route passes `reapTeamWorkflows`. */
  reapOwnedWorkflows?: (tx: AppQueryable) => Promise<void>;
}

/**
 * Deletes a team, its memberships, the skills it owns, and the skill
 * repositories it tracks. When `reapOwnedWorkflows` is passed, team-owned
 * workflows go with the team unless a run is unsettled. Without that
 * callback, the delete still refuses while any team-owned workflow exists.
 * Identity-provider-backed teams are deletable because login does not create
 * or reconcile them. `isLiveIdpMirror` remains a compatibility seam.
 *
 * Skills are removed rather than blocking, because a skill is a document,
 * not a running thing — there is nothing to cancel first. They must go
 * somewhere: every read path for a team-owned skill goes through
 * `isTeamMember`, so a surviving row would sit in the table forever with no
 * owner who can ever reach it, the same orphan `deleteWorkflowDefinition`
 * closes for `workflow_webhooks`. A tracked repository is unreachable the
 * same way, and it would go on polling GitHub for a team that no longer
 * exists, so it goes with them.
 */
export async function deleteTeam(db: AppDb, opts: DeleteTeamOptions): Promise<void> {
  const teamRows = await db.select().from(teams).where(eq(teams.id, opts.teamId)).limit(1);
  const team = teamRows[0];
  if (!team) throw new NotFoundError("team", opts.teamId);
  if (await isLiveIdpMirror(db, team)) throw new IdpManagedTeamError(team, "delete");
  if (team.origin === "config") throw new ConfigManagedTeamError(team.name);

  await db.transaction(async (tx) => {
    await lockTeamForOwnership(tx, opts.teamId);
    await tx.delete(actionPolicies).where(and(eq(actionPolicies.orgId, team.orgId), eq(actionPolicies.principalType, "team"), eq(actionPolicies.principalId, opts.teamId)));
    if (opts.reapOwnedWorkflows) await opts.reapOwnedWorkflows(tx);
    await assertNoTeamOwnedWorkflows(tx, opts.teamId);
    await tx
      .delete(skills)
      .where(and(eq(skills.ownerType, "team"), eq(skills.ownerId, opts.teamId)));
    // Each source's mirrored content goes with the source, through the same
    // helper the source delete uses. Without it a mirrored row outlives every
    // route that could remove it: a mirrored workflow is read-only, and its
    // source would be gone. Reap (or `assertNoTeamOwnedWorkflows`) already
    // removed team-owned definitions, so this reaches a source whose
    // mirrored workflows were removed by that path first, and the
    // templates it still holds.
    const teamSources = await tx
      .select({ id: contentSources.id, orgId: contentSources.orgId })
      .from(contentSources)
      .where(and(eq(contentSources.ownerType, "team"), eq(contentSources.ownerId, opts.teamId)));
    for (const source of teamSources) {
      await deleteMirroredContent(tx, source.orgId, source.id);
    }
    await tx
      .delete(contentSources)
      .where(and(eq(contentSources.ownerType, "team"), eq(contentSources.ownerId, opts.teamId)));
    // The team's assistants go with it (TKAI-296): with the membership rows
    // gone, no caller passes canViewSession/canAdministerSession, so a
    // surviving assistant row and its session are unreachable orphans —
    // the same reasoning as the skills removal above. The route tears down
    // the engine sessions first; for any other caller, the sandbox
    // reconcile sweep covers a sandbox whose owning session is deleted.
    const teamAssistants = await tx
      .select({ id: assistants.id, sessionId: assistants.sessionId })
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, opts.teamId)));
    for (const assistant of teamAssistants) {
      await retireAssistant(tx, assistant.id);
      await tx
        .update(agentSessions)
        .set({ status: "deleted", updatedAt: Date.now() })
        .where(eq(agentSessions.id, assistant.sessionId));
    }
    // Machine-driven delivery targets go too. A surviving team-owned event
    // subscription, channel binding, or followed thread keeps dispatching
    // to the team principal, and `resolveDefaultAssistant` would then MINT
    // a fresh assistant for the deleted team (retire freed the default
    // slot) — resurrecting a dangling-owner assistant on the very next
    // event.
    await tx
      .delete(eventSubscriptions)
      .where(and(eq(eventSubscriptions.ownerType, "team"), eq(eventSubscriptions.ownerId, opts.teamId)));
    await tx
      .delete(workflowSchedules)
      .where(and(eq(workflowSchedules.ownerType, "team"), eq(workflowSchedules.ownerId, opts.teamId)));
    await tx
      .delete(channelBindings)
      .where(and(eq(channelBindings.ownerType, "team"), eq(channelBindings.ownerId, opts.teamId)));
    await tx
      .delete(followedThreads)
      .where(and(eq(followedThreads.ownerType, "team"), eq(followedThreads.ownerId, opts.teamId)));
    await tx
      .delete(credentials)
      .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, opts.teamId)));
    // The team's `vlt_` keys go with it. Once the team row is gone, every
    // route that could revoke one is closed: the team key list 404s, and
    // the personal routes refuse a team-pinned key, so a surviving row is
    // unreachable forever. It is not an open door. The auth ladder already
    // reads a key whose team is gone as invalid.
    await tx.delete(apikey).where(eq(apikey.teamId, opts.teamId));
    await tx.delete(teamJoinEligibilities).where(eq(teamJoinEligibilities.teamId, opts.teamId));
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, opts.teamId));
    const removedRequests = await tx.delete(teamDeletionRequests)
      .where(and(eq(teamDeletionRequests.teamId, opts.teamId), eq(teamDeletionRequests.orgId, team.orgId)))
      .returning({ id: teamDeletionRequests.id });
    for (const request of removedRequests) await markAttentionNotificationsRead(tx, "review", request.id);
    await tx.delete(teams).where(eq(teams.id, opts.teamId));
  });
}
